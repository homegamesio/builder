const https = require('https');
const http = require('http');
const fs = require('fs');
const unzipper = require('unzipper');
const config = require('./config');
const path = require('path');
const aws = require('aws-sdk');
const { spawn } = require('child_process');

const options = {
  key: fs.readFileSync(config.SSL_KEY_PATH),
  cert: fs.readFileSync(config.SSL_CERT_PATH)
};

const getReqBody = (req, cb) => {
    let _body = '';
    req.on('data', chunk => {
        _body += chunk.toString();
    });

    req.on('end', () => {
        cb && cb(_body);
    });
};

const getBuildHistory = (limit = 10) => {
	//todo
	return [];
};

const server = https.createServer(options, (req, res) => {
    if (req.method === 'GET') {
        if (req.url === '/health') {
            res.writeHead(200, {'Content-Type': 'text/plain'});
            res.end('ok');
        } else if (req.url === '/') {
		getCurrentBuildInfo().then(currentBuildInfo => {
			console.log(currentBuildInfo);
		    res.writeHead(200, {'Content-Type': 'text/plain'});
		    res.end(`Built ${currentBuildInfo.commitHash} at ${currentBuildInfo.dateBuilt}`);
		});
	}
    } else {
	    res.writeHead(404);
	    res.end('Not found');
    }

});

const getLatestCommitHash = () => new Promise((resolve, reject) => {
	https.get({
		hostname: 'api.github.com',
		path: '/repos/homegamesio/homegames/commits',
		headers: {
			'User-Agent': 'HomegamesBuilder/0.1.0'
		}
	},(_response) => {
		getReqBody(_response, (response) => {
			const data = JSON.parse(response);
			resolve(data[0].sha);
		});
	});
});

const downloadHomegames = () => new Promise((resolve, reject) => {
    // todo: uuid
    const dir = `/home/ubuntu/tmp/${Date.now()}`;
    const file = fs.createWriteStream(dir + '.zip');
	const zlib = require('zlib');
    https.get("https://codeload.github.com/homegamesio/homegames/zip/master", (_response) => {
	    _response.pipe(unzipper.Extract({ path: dir }));
	    resolve(dir);
	});
});

// todo: picodeg.io (docker)
// also hg web

const installNPMDependencies = (projectDir) => new Promise((resolve, reject) => {
	const install = spawn('npm', ['install', '--prefix', projectDir]);

	install.stdout.on('data', (data) => {
		console.log("DATTTTA");
		console.log(data.toString());	
	});

	install.stderr.on('data', (data) => {
		console.log('errrrr');
		console.log(data.toString());
	});

	install.on('close', (code) => {
		console.log("cloooosed");
		console.log(code);
		resolve();
	});
//						exec('pkg ' + path + '/homegames-master --targets node13-linux-x64,node13-macos-x64,node13-win-x64 --out-path ' + outPath, (err, stdout, stderr) => {
//							console.log('what happened');
//							console.log(stdout);
//							console.log(stderr);
//						});
//					});

});

const buildPkg = (packagePath, outPath) => new Promise((resolve, reject) => {
	const targets = [
		'node13-linux-x64',
		'node13-macos-x64',
		'node13-win-x64'
	];

	let targetString = '';

	targets.forEach(t => targetString += t + ',');

	targetString = targetString.slice(0, -1);
	console.log("target string");
	console.log(targetString);

	const build = spawn('pkg', [packagePath, '--targets', targetString, '--out-path', outPath]);

	build.stdout.on('data', (data) => {
		console.log("build DATTTTA");
		console.log(data.toString());	
	});

	build.stderr.on('data', (data) => {
		console.log('build errrrr');
		console.log(data.toString());
	});

	build.on('close', (code) => {
		console.log("build cloooosed");
		console.log(code);
		resolve();
	});

});

const updateCurrentBuildInfo = (commitHash) => new Promise((resolve, reject) => {
	const dynamoClient = new aws.DynamoDB({region: config.AWS_REGION});

	const params = {
		TableName: config.TABLE_NAME,
		Item: {
			'status': {
				'S': 'current'
			},
			'commit_hash': {
				'S': commitHash
			},
			'date_built': {
				'N': '' + Date.now()
			}
		}
	};

	dynamoClient.putItem(params, (err, data) => {
		console.log("DSFNDGF PUT");
		console.log(err);
		console.log(data);
		resolve(data);
	});
});

const uploadBuild = () => new Promise((resolve, reject) => {
	const linuxPath = config.BUILD_PATH + '/homegames-linux';
	const windowsPath = config.BUILD_PATH + '/homegames-win.exe';
	const macPath = config.BUILD_PATH + '/homegames-macos';

	fs.chmodSync(linuxPath, '555');
	fs.chmodSync(windowsPath, '555');
	fs.chmodSync(macPath, '555');

	const options = { partSize: 10 * 1024 * 1024, queueSize: 1 };

	const s3Client = new aws.S3();

	const linuxReadStream = fs.createReadStream(linuxPath);
	const windowsReadStream = fs.createReadStream(windowsPath);
	const macReadStream = fs.createReadStream(macPath);

	const linuxParams = { Bucket: config.S3_BUCKET, Key: config.S3_BUILD_PREFIX + '/homegames-linux', Body: linuxReadStream, ACL: 'public-read', ContentType: 'application/x-binary' };
	const windowsParams = { Bucket: config.S3_BUCKET, Key: config.S3_BUILD_PREFIX + '/homegames-win.exe', Body: windowsReadStream, ACL: 'public-read', ContentType: 'application/x-binary' };
	const macParams = { Bucket: config.S3_BUCKET, Key: config.S3_BUILD_PREFIX + '/homegames-macos', Body: macReadStream, ACL: 'public-read', ContentType: 'application/x-binary' };

	s3Client.upload(linuxParams, (err, data) => {
		s3Client.upload(windowsParams, (err, data) => {
			s3Client.upload(macParams, (err, data) => {
				console.log("uploaded all 3");
			});
		});
	});
});

uploadBuild();
console.log('fdsfsdfdsf');

const workflow = () => {
	getCurrentBuildInfo().then(currentInfo => {
		const currentHash = currentInfo.commitHash;
		getLatestCommitHash().then(latestHash => {
			if (latestHash != currentHash) {
				downloadHomegames().then(path => {
					installNPMDependencies(path + '/homegames-master').then(() => {
						console.log('installed dependencies');
						buildPkg(path + '/homegames-master', config.BUILD_PATH).then(() => {
							uploadBuild().then(() => {
								updateCurrentBuildInfo(latestHash).then((buildInfo) => {
									console.log('built');
									console.log(buildInfo);
								});
							});
						});
					});
				});
			} else {
				console.log('still good');
			}
		});
	});
};

const getCurrentBuildInfo = () => new Promise((resolve, reject) => {
	const dynamoClient = new aws.DynamoDB({region: config.AWS_REGION});
	const params = {
		TableName: config.TABLE_NAME,
		Key: {
			'status': {
				S: 'current'
			}
		}
	};

	dynamoClient.getItem(params, (err, data) => {
		resolve({
			commitHash: data.Item.commit_hash.S,
			dateBuilt: new Date(data.Item.date_built.N)
		});
	});

});

workflow();
//setInterval(workflow, 10 * 1000)

const HTTPS_PORT = 443;

server.listen(HTTPS_PORT);

const HTTP_PORT = 80;

http.createServer((req, res) => {
    res.writeHead(301, {'Location': 'https://' + req.headers['host'] + req.url });
    res.end();
}).listen(HTTP_PORT);
