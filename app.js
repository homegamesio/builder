const https = require('https');
const http = require('http');
const fs = require('fs');
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
	const dynamoClient = new aws.DynamoDB();
	console.log(dynamoClient);
	dynamoClient.listTables({}, (err, data) => {
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

const checkLatestVersion = () => {
    console.log("need to check latest version");
};

setInterval(checkLatestVersion, 10 * 1000)

const HTTPS_PORT = 443;

server.listen(HTTPS_PORT);

const HTTP_PORT = 80;

http.createServer((req, res) => {
    res.writeHead(301, {'Location': 'https://' + req.headers['host'] + req.url });
    res.end();
}).listen(HTTP_PORT);
