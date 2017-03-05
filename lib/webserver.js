"use strict";

const Q = require('q');
const _ = require('underscore');
const co = require('co');
const http = require('http');
const morgan = require('morgan');
const express = require('express');
const bodyParser = require('body-parser');

module.exports = (host, port, neo4jService) => {

  var app = express();

  app.use(morgan('\x1b[90m:remote-addr - :method :url HTTP/:http-version :status :res[content-length] - :response-time ms\x1b[0m', {
    stream: {
      write: function(message){
        message && console.log(message.replace(/\n$/,''));
      }
    }
  }));
  app.use(bodyParser.urlencoded({ extended: true }));
  
  app.get('/logos/currentstatus/:uid', (req, res) => co(function *() {
    
    try {
      const currentStatus = yield neo4jService.getIdentityCurrentStatus(req.params.uid);
	  // Send html page
	  res.status(200).send(currentStatus);
    //res.status(200).send(JSON.stringify(f2f));
    } catch (e) {
	  // En cas d'exception, afficher le message
	  res.status(500).send('<pre>' + (e.stack || e.message) + '</pre>');
    }
  }));

  app.get('/logos/identityhistory/:uid', (req, res) => co(function *() {
    
    try {
      const identityHistory = yield neo4jService.getIdentityHistory(req.params.uid);
    // Send html page
    res.status(200).send(identityHistory);
    //res.status(200).send(JSON.stringify(identityHistory));
    } catch (e) {
    // En cas d'exception, afficher le message
    res.status(500).send('<pre>' + (e.stack || e.message) + '</pre>');
    }
  }));



  let httpServer = http.createServer(app);
  //httpServer.on('connection', function(socket) {
  //});
  httpServer.on('error', function(err) {
    httpServer.errorPropagates(err);
  });
  
  return {
    openConnection: () => co(function *() {
      try {
        yield Q.Promise((resolve, reject) => {
          // Weird the need of such a hack to catch an exception...
          httpServer.errorPropagates = function(err) {
            reject(err);
          };

          httpServer.listen(port, host, (err) => {
            if (err) return reject(err);
            resolve(httpServer);
          });
        });
        console.log('Server listening on http://' + host + ':' + port);
      } catch (e) {
        console.warn('Could NOT listen to http://' + host + ':' + port);
        console.warn(e);
      }
    }),
  };
};
