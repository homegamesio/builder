const process = require('process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const unzipper = require('unzipper');
const path = require('path');
const aws = require('aws-sdk');
const { spawn } = require('child_process');
const zlib = require('zlib');
const archiver = require('archiver');
const url = require('url');

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
	const dynamoClient = new aws.DynamoDB({region: process.env.AWS_REGION});

	const params = {
		TableName: process.env.BUILD_TABLE_NAME,
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

const getBuilds = (limit, stable) => new Promise((resolve, reject) => {
	const dynamoClient = new aws.DynamoDB({region: process.env.AWS_REGION});
	const params = {
		TableName: process.env.BUILD_TABLE_NAME,
		KeyConditionExpression: 'wat = :wat and date_published <= :now',
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

        if (stable != undefined) {
            params['FilterExpression'] = '#stable = :stable';
            params['ExpressionAttributeNames'] = { '#stable': 'stable' };
            params['ExpressionAttributeValues'][':stable'] = {'BOOL': stable !== undefined};
        } else {
	    params['Limit'] = limit;
        }

	dynamoClient.query(params, (err, data) => {
                if (err) {
                    console.error(err);
                    resolve([])
                } else {
                    // dynamo model feels super wrong. oh well
		    const response = data.Items.reduce((total, r) => {
		    	if ((r.commit_info || r.commit_hash) && r.date_published && r.windows_url && r.linux_url && r.mac_url) {
                                if (!limit || total.length < limit) { 
		    		    total.push({
		    		    	datePublished: new Date(Number(r.date_published.N)),
		    		    	windowsUrl: r.windows_url.S,
		    		    	macUrl: r.mac_url.S,
		    		    	linuxUrl: r.linux_url.S,
		    		    	notes: r.notes && r.notes.S || '',
		    		    	commitInfo: r.commit_info && JSON.parse(r.commit_info.S) || (r.commit_hash && {commitHash: r.commit_hash.S}) || '',
		    		    	stable: r.stable && r.stable.BOOL
		    		    });
                                }
		    	}

		    	return total;
		    }, []);
		    
		    resolve(response);
                }
	});
});

const getBuild = (commitHash) => new Promise((resolve, reject) => {
        if (!commitHash) {
            reject('Bad commit hash');
        } else {
	    const buildPath = `${process.env.TEMP_DATA_DIR}/hg_builds/${commitHash}`;
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

const getReqQuery = (req) => url.parse(req.url,true).query;

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'GET') {
        if (req.url === '/health') {
            res.writeHead(200, {'Content-Type': 'text/plain'});
            res.end('ok updated');
        } else if (req.url === '/latest') {
            getBuilds(1).then(builds => {
                res.writeHead(200, {
                    'Content-Type': 'application/json'
                });
                res.end(JSON.stringify(builds[0])); 
            });
        } else if (req.url === '/latest/stable') {
            getBuilds(1, true).then(builds => {
                res.writeHead(200, {
                    'Content-Type': 'application/json'
                });
                res.end(JSON.stringify(builds[0])); 
            });
 
        } else if (req.url.startsWith('/')) {
            const query = getReqQuery(req);

            console.log(query);

            const queryLimit = query.limit && Number(query.limit);

            const limit = queryLimit < 100 && queryLimit > 0 ? queryLimit : 10;

            getBuilds(limit, query.stable).then(builds => {
                res.writeHead(200, {
                    'Content-Type': 'application/json'
                });
                res.end(JSON.stringify({builds}));
            });

        } else {
	    res.writeHead(404);
	    res.end('Not found');
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

const HTTP_PORT = 80;

server.listen(HTTP_PORT);


