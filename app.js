const https = require('https');
const http = require('http');
const fs = require('fs');
const config = require('./config');
const path = require('path');

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

const server = https.createServer(options, (req, res) => {
    if (req.method === 'POST') {
        if (req.url === '/event') {
            getReqBody(req, (_body) => {
                const body = JSON.parse(_body);
                if (body.username && body.code) {
                    confirmUser(body.username, body.code).then((data) => {
                        res.writeHead(200, {'Content-Type': 'application/json'});

                        res.end(JSON.stringify(data));
                    });
                } else {
                    res.writeHead(400, {'Content-Type': 'text/plain'});
                    res.end('Signup requires username & code');
                }
            });
        }
    } else if (req.method === 'GET') {
        if (req.url === '/health') {
            res.writeHead(200, {'Content-Type': 'text/plain'});
            res.end('ok');
        }
    }
});

const HTTPS_PORT = 443;

server.listen(HTTPS_PORT);

const HTTP_PORT = 80;

http.createServer((req, res) => {
    res.writeHead(301, {'Location': 'https://' + req.headers['host'] + req.url });
    res.end();
}).listen(HTTP_PORT);
