const https = require('https');
const http = require('http');
const fs = require('fs');
const unzipper = require('unzipper');
const config = require('./config');
const path = require('path');
const aws = require('aws-sdk');
const { spawn } = require('child_process');
const zlib = require('zlib');
const archiver = require('archiver');

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

const getBuildInfo = (commitHash) => new Promise((resolve, reject) => {
	const dynamoClient = new aws.DynamoDB({region: config.AWS_REGION});

	const params = {
		TableName: config.BUILD_TABLE_NAME,
		ProjectionExpression: '#commitHash, mac_url, windows_url, linux_url',
		FilterExpression: '#commitHash = :commitHash',
		ExpressionAttributeNames: {
			'#commitHash': 'commit_hash'
		},
		ExpressionAttributeValues: {
			':commitHash': {
				'S': commitHash
			}
		}

	};

	dynamoClient.scan(params, (err, data) => {
		if (err) {
			reject(err);
		} else {
			resolve(data.Items[0])
		}
	});
});

const getLatestBuildHash = (stable = false) => new Promise((resolve, reject) => {
	if (!stable) {
		getBuilds(1).then(builds => {
			resolve(builds[0].commitInfo.commitHash);
		});
	} else {
		const dynamoClient = new aws.DynamoDB({region: config.AWS_REGION});

		const params = {
			TableName: config.BUILD_TABLE_NAME,
			ProjectionExpression: '#commitHash',
			FilterExpression: '#stable= :stable',
			ExpressionAttributeNames: {
				'#stable': 'stable',
				'#commitHash': 'commit_hash'
			},
			ExpressionAttributeValues: {
				':stable': {
					'BOOL': stable
				}
			}

		};

		dynamoClient.scan(params, (err, data) => {
			if (err) {
				reject(err);
			} else {
				resolve(data.Items[0].commit_hash.S);
			}
		});
	}

});

const getBuilds = (limit = 10) => new Promise((resolve, reject) => {
	const dynamoClient = new aws.DynamoDB({region: config.AWS_REGION});
	const params = {
		TableName: config.BUILD_TABLE_NAME,
		KeyConditionExpression: 'wat = :wat and date_published <= :now',
		Limit: limit,
		ScanIndexForward: false,
		ExpressionAttributeValues: {
			':now': {
				'N': '' + Date.now()
			},
			':wat': {
				'S': 'wat'
			}
		}
	};

	dynamoClient.query(params, (err, data) => {
		const response = data.Items.reduce((total, r) => {
			if ((r.commit_info || r.commit_hash) && r.date_published && r.windows_url && r.linux_url && r.mac_url) {
				total.push({
					datePublished: new Date(Number(r.date_published.N)),
					windowsUrl: r.windows_url.S,
					macUrl: r.mac_url.S,
					linuxUrl: r.linux_url.S,
					notes: r.notes && r.notes.S || '',
					commitInfo: r.commit_info && JSON.parse(r.commit_info.S) || (r.commit_hash && {commitHash: r.commit_hash.S}) || '',
					stable: r.stable && r.stable.BOOL
				})
			}

			return total;
		}, []);
		
		resolve(response);
	});
});

const wrapHtml = (response) => {
	return `<!doctype html><html><body>${response}</body></html>`;
};

const download = (url, cb) => {
	const module = url.startsWith('https') ? https : http;
	module.get(url, cb);
};

const getBuild = (commitHash) => new Promise((resolve, reject) => {
        if (!commitHash) {
            reject('Bad commit hash');
        } else {
	    const buildPath = `${config.TEMP_DATA_DIR}/hg_builds/${commitHash}`;
	    if (!fs.existsSync(buildPath)) {
	    	fs.mkdirSync(buildPath);
	    	getBuildInfo(commitHash).then(buildData => {
	    		console.log('got build info');
	    		console.log(buildData);
	    		if(!buildData) {
	    			reject();
	    		} else {
	    			download(buildData.mac_url.S, macDataBuf => {
	    				macDataBuf.pipe(fs.createWriteStream(`${buildPath}/homegames-macos`)).on('finish', () => {
	    					download(buildData.windows_url.S, windowsDataBuf => {
	    						windowsDataBuf.pipe(fs.createWriteStream(`${buildPath}/homegames-win.exe`)).on('finish', () => {
	    							download(buildData.linux_url.S, linuxDataBuf => {
	    								linuxDataBuf.pipe(fs.createWriteStream(`${buildPath}/homegames-linux`)).on('finish', () => {
	    									fs.chmodSync(`${buildPath}/homegames-macos`, '555');
	    									fs.chmodSync(`${buildPath}/homegames-win.exe`, '555');
	    									fs.chmodSync(`${buildPath}/homegames-linux`, '555');
	    									const archive = archiver('zip', {

	    									});

	    									const tmpDir = '/tmp/' + Date.now()

	    									fs.mkdirSync(tmpDir);

	    									const output = fs.createWriteStream(`${tmpDir}/build.zip`);
	    									output.on('close', () => {

	    										fs.renameSync(`${tmpDir}/build.zip`, `${buildPath}/build.zip`);
	    										const stat = fs.statSync(`${buildPath}/build.zip`);
	    										resolve({
	    											info: {
	    												size: stat.size,
	    											},
	    											stream: fs.createReadStream(`${buildPath}/build.zip`)
	    										});
	    									});
	    									archive.pipe(output);
	    									archive.directory(buildPath, 'homegames');

	    									archive.finalize();

	    								});
	    							});
	    						});
	    					});
	    				});
	    			});
	    		}
	    	}).catch(err => {
	    		reject(err);
	    	})
	    } else {
	    	const stat = fs.statSync(`${buildPath}/build.zip`)
	    	resolve({
	    		info: {
	    			size: stat.size,
	    		},
	    		stream: fs.createReadStream(`${buildPath}/build.zip`)
	    	});
            }
	}
});

const server = https.createServer(options, (req, res) => {
	const downloadRegex = /download\/(\w+)\/?(\w+)?/g;
	const downloadMatch = downloadRegex.exec(req.url);
    if (req.method === 'GET') {
        if (req.url === '/health') {
            res.writeHead(200, {'Content-Type': 'text/plain'});
            res.end('ok');
        } else if (req.url === '/') {
		const stableLabel = `<span style="background: green; color: white; padding: 4px; margin: 10px;">Stable</span>`;
		getBuilds(10).then(builds => {
			const buildDivs = builds.map(b => {
				const commitInfo = b.commitInfo;
				const commitDiv = `<div>Author: ${b.commitInfo.author || 'Unknown'}<br />${b.commitInfo.message || 'No message available'}</div>`;
				const notesDiv = b.notes && `<div>Note: ${b.notes}</div>` || '';
				return `<li style="margin-bottom: 3%">Built ${b.commitInfo.commitHash} on ${b.datePublished}. <a href="https://builder.homegames.io/download/${b.commitInfo.commitHash}" target="_blank">Download</a>${b.stable && stableLabel || ''}<div>${commitDiv}${notesDiv}</div></li>`;
			});
			const response = wrapHtml(`<ul style="list-style-type: none" >${buildDivs.join('')}</ul>`);
		    res.writeHead(200, {'Content-Type': 'text/html'});
		    res.end(response);
		});
	} else if (downloadMatch) {
		if (downloadMatch[1] === 'latest') {
			const stable = downloadMatch[2] === 'stable';

			getLatestBuildHash(stable).then(commitHash => {
				res.writeHead(301, {    
					'Cache-Control': 'no-store',
				   	'Location': 'https://builder.homegames.io/download/' + commitHash 
				});
			    	res.end();
			});
		} else {
			const commitHash = downloadMatch[1];
			getBuild(commitHash).then(buildData => {
				res.writeHead(200, {
					'Content-Type': 'application/zip',
					'Content-Length': buildData.info.size,
					'Content-Disposition': `attachment;filename="homegames.zip"`
				});

				buildData.stream.pipe(res);
			}).catch(err => {
				if (err) {
					console.error(err);
					res.writeHead(500);
					res.end();
				} else {
					res.writeHead(404);
					res.end('Not found');
				}
			});
		}
	}
    } else {
	    res.writeHead(404);
	    res.end('Not found');
    }

});

const getLatestCommitInfo = () => new Promise((resolve, reject) => {
	https.get({
		hostname: 'api.github.com',
		path: '/repos/homegamesio/homegames/commits',
		headers: {
			'User-Agent': 'HomegamesBuilder/0.1.0'
		}
	},(_response) => {
		getReqBody(_response, (response) => {
			const data = JSON.parse(response)[0];
			resolve({
				author: data.author.login,
				message: data.commit.message,
				date: data.commit.author.date,
				commitHash: data.sha
			});
		});
	});
});

const downloadHomegames = () => new Promise((resolve, reject) => {
    // todo: uuid
    const dir = `/home/ubuntu/tmp/${Date.now()}`;
    const file = fs.createWriteStream(dir + '.zip');
	const zlib = require('zlib');
    https.get("https://codeload.github.com/homegamesio/homegames/zip/main", (_response) => {
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

	const cmdArgs = [packagePath, '--targets', targetString, '--out-path', outPath];
	console.log('args');
	console.log(cmdArgs);
	const build = spawn('pkg', cmdArgs); 


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

const updateCurrentBuildInfo = (commitInfo, s3Paths) => new Promise((resolve, reject) => {
	const dynamoClient = new aws.DynamoDB({region: config.AWS_REGION});

	const params = {
		TableName: config.BUILD_TABLE_NAME,
		Item: {
			'wat': {
				'S': 'wat'
			},
			'commit_info': {
				'S': JSON.stringify(commitInfo)
			},
			'commit_hash': {
				'S': commitInfo.commitHash
			},
			'date_published': {
				'N': '' + Date.now()
			},
			'linux_url': {
				'S': s3Paths.linuxUrl
			},
			'mac_url': {
				'S': s3Paths.macUrl
			},
			'windows_url': {
				'S': s3Paths.windowsUrl
			}
		}
	};

	dynamoClient.putItem(params, (err, data) => {
		resolve(data);
	});
});

const s3Get = (bucket, key) => new Promise((resolve, reject) => {
	const s3 = new aws.S3();

	const params = {
		Bucket: bucket,
		Key: key
	};

	s3.getObject(params, (err, data) => {
		if (err) {
			reject(err);
		} else {
			resolve(data.Body);
		}
	});
});

const uploadBuild = (commitInfo, buildPath) => new Promise((resolve, reject) => {
	const commitHash = commitInfo.commitHash;
	const linuxPath = buildPath + '/homegames-linux';
	const windowsPath = buildPath + '/homegames-win.exe';
	const macPath = buildPath + '/homegames-macos';
	
	const linuxKey = config.S3_BUILD_PREFIX + `/${commitHash}/homegames-linux`;
	const windowsKey = config.S3_BUILD_PREFIX + `/${commitHash}/homegames-win.exe`;
	const macKey = config.S3_BUILD_PREFIX + `/${commitHash}/homegames-macos`;

	const options = { partSize: 10 * 1024 * 1024, queueSize: 1 };

	const s3Client = new aws.S3();

	const linuxReadStream = fs.createReadStream(linuxPath);
	const windowsReadStream = fs.createReadStream(windowsPath);
	const macReadStream = fs.createReadStream(macPath);

	const linuxParams = { Bucket: config.S3_BUCKET, Key: linuxKey, Body: linuxReadStream, ACL: 'public-read', ContentType: 'application/x-binary' };
	const windowsParams = { Bucket: config.S3_BUCKET, Key: windowsKey, Body: windowsReadStream, ACL: 'public-read', ContentType: 'application/x-binary' };
	const macParams = { Bucket: config.S3_BUCKET, Key: macKey, Body: macReadStream, ACL: 'public-read', ContentType: 'application/x-binary' };

	s3Client.upload(linuxParams, (err, linuxData) => {
		s3Client.upload(windowsParams, (err, windowsData) => {
			s3Client.upload(macParams, (err, macData) => {
				resolve({
					linuxUrl: linuxData.Location,
					windowsUrl: windowsData.Location,
					macUrl: macData.Location
				});
			});
		});
	});
});

const runBuild = (path) => new Promise((resolve, reject) => {

	const cmd = `npm run build --prefix ${path}`;
	const build = spawn('npm', ['run', 'build', '--prefix', path]);

	build.stdout.on('data', (data) => {
		console.log("DATTTTA");
		console.log(data.toString());	
	});

	build.stderr.on('data', (data) => {
		console.log('errrrr');
		console.log(data.toString());
	});

	build.on('close', (code) => {
		console.log("cloooosed");
		console.log(code);
		resolve();
	});
//	
});

const updateBuild = (commitInfo) => new Promise((resolve, reject) => {
	const _update = () => {
		// todo: pass hash here
		downloadHomegames().then(path => {
			console.log('downloaded to ' + path);
			installNPMDependencies(path + '/homegames-main').then(() => {
				console.log('installed dependencies wHAT');
				runBuild(path + '/homegames-main').then(() => {
					console.log('just ran build');
					buildPkg(path + '/homegames-main', config.BUILD_PATH).then(() => {
						console.log('built that');
						uploadBuild(commitInfo, config.BUILD_PATH).then(s3Paths => {
							updateCurrentBuildInfo(commitInfo, s3Paths).then((buildInfo) => {
								console.log('built');
								console.log(buildInfo);
							});
						});
					});
				});
			}).catch(err => {
				console.log("Could not install NPM dependencies");
				console.log(err);
				reject(err);
			});
		}).catch(err => {
			console.log("Could not download");
			console.log(err);
			reject(err);
		});
	};
	
	if (!commitInfo) {
		getLatestCommitInfo().then(_commitInfo => {
			commitInfo = _commitInfo;
			_update();
		});
	} else {
		_update();
	}


});

const workflow = () => {
	getCurrentBuildInfo().then(currentInfo => {
		const currentHash = currentInfo.commitInfo && currentInfo.commitInfo.commitHash;
		getLatestCommitInfo().then(commitInfo => {
			const latestCommitHash = commitInfo.commitHash;
			if (latestCommitHash != currentHash) {
				console.log('gonna update build');
				console.log(latestCommitHash);
				updateBuild(commitInfo).then(() => {
					console.log('updated build to ' + latestCommitHash);
				}).catch(err => {
					console.log('couldnt update build');
					console.log(err);
				});
			} else {
				console.log('already built ' + latestCommitHash);
			}
		}).catch(err => {
			console.log('could not retrieve latest commit hash');
			console.log(err);
		});
	}).catch(err => {
		console.log('could not retrieve build info');
		console.log(err);
		if (err === 'No builds found') {
			updateBuild().then(() => {
				console.log('created initial build');
			});
		}
	});
};

const getCurrentBuildInfo = () => new Promise((resolve, reject) => {
	getBuilds(1).then(builds => {
		if (!builds.length) {
			reject('No builds found');
		} else {
			resolve(builds[0]);
		}
	});
});

// 5 mins
setInterval(workflow, 5 * 60 * 1000)

const HTTPS_PORT = 443;

server.listen(HTTPS_PORT);

const HTTP_PORT = 80;

http.createServer((req, res) => {
    res.writeHead(301, {'Location': 'https://' + req.headers['host'] + req.url });
    res.end();
}).listen(HTTP_PORT);
