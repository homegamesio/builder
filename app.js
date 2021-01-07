const https = require('https');
const http = require('http');
const fs = require('fs');
const unzipper = require('unzipper');
const config = require('./config');
const path = require('path');
const aws = require('aws-sdk');

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
	const dynamoClient = new aws.DynamoDB({region: config.AWS_REGION});
	const params = {
		TableName: config.TABLE_NAME,
		Limit: limit,
		KeyConditionExpression: 'date_started <= :now',
		ScanIndexForward: false, // sort descending
		ExpressionAttributeValues: {
			':now': {"N": "" + Date.now()}
		}
	};

	console.log(params);

	dynamoClient.query(params, (err, data) => {
		console.log(err);
		console.log(data);
		return 'hello\nworld';
	});
};

const server = https.createServer(options, (req, res) => {
    if (req.method === 'GET') {
        if (req.url === '/health') {
            res.writeHead(200, {'Content-Type': 'text/plain'});
            res.end('ok');
        } else if (req.url === '/') {
	    const buildHistory = getBuildHistory(10);
	    res.writeHead(200, {'Content-Type': 'text/plain'});
	    res.end('My last 10 builds:\n' + buildHistory);
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

const checkLatestVersion = () => {
	getCurrentBuildHash().then(currentHash => {
		console.log('current hash');
		console.log(currentHash);
		getLatestCommitHash().then(latestHash => {
			console.log('latest hash');
			console.log(latestHash);
			if (latestHash != currentHash) {
				console.log('gotta build');
				downloadHomegames().then(path => {
					console.log(path);
					const {exec} = require('child_process');
					exec('npm install --prefix ' + path + '/homegames-master', (err, stdout, stderr) => {
						console.log('yeah i did that');
						exec('pkg ' + path + '/homegames-master --targets node13-linux-x64,node13-macos-x64,node13-win-x64', (err, stdout, stderr) => {
							console.log('what happened');
							console.log(stdout);
							console.log(stderr);
						});
					});
				});
			}
		});
	});
};

const getCurrentBuildHash = () => new Promise((resolve, reject) => {
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
		resolve(data.Item.commit_hash.S);
	});

});

setInterval(checkLatestVersion, 10 * 1000)

const HTTPS_PORT = 443;

server.listen(HTTPS_PORT);

const HTTP_PORT = 80;

http.createServer((req, res) => {
    res.writeHead(301, {'Location': 'https://' + req.headers['host'] + req.url });
    res.end();
}).listen(HTTP_PORT);
