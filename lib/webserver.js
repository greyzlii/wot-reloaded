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
  

  app.get('/logos/events/:uid', (req, res) => co(function *() {
    
    try {

       var stepsmax = 1; // Default value
       if (typeof(req.query.stepsmax) != 'undefined' ) {
           stepsmax = parseInt(req.query.stepsmax);
       }

       var limitdate = 0
       if (typeof(req.query.limitdate) != 'undefined' ) {
           limitdate = parseInt(req.query.limitdate);
       }

      const closeEvents = yield neo4jService.getCloseEvents(req.params.uid, stepsmax, limitdate);
      // Send html page
      res.status(200).send(closeEvents);


    } catch (e) {
    // En cas d'exception, afficher le message
    res.status(500).send('<pre>' + (e.stack || e.message) + '</pre>');
    }
  }));

  app.get('/logos/wot/stats', (req, res) => co(function *() {
    
    try {

       var date = 0; // Default value
       if (typeof(req.query.date) != 'undefined' ) {
           date = parseInt(req.query.date);
       }

      const wotStats = yield neo4jService.getWotStats(req.params.uid, date);
    // Send html page
    res.status(200).send(wotStats);
    //res.status(200).send(JSON.stringify(f2f));
    } catch (e) {
    // En cas d'exception, afficher le message
    res.status(500).send('<pre>' + (e.stack || e.message) + '</pre>');
    }
  }));


  app.get('/logos/wot/events', (req, res) => co(function *() {
    
    try {

       var fromdate = 0; // Default value
       if (typeof(req.query.fromdate) != 'undefined' ) {
           fromdate = parseInt(req.query.fromdate);
       }
       var todate = 0; // Default value
       if (typeof(req.query.todate) != 'undefined' ) {
           todate = parseInt(req.query.todate);
       }
       var limit = 100; // Default value
       if (typeof(req.query.limit) != 'undefined' ) {
           limit = parseInt(req.query.limit);
       }

      const currentStatus = yield neo4jService.getWotEvents(req.params.uid, fromdate, todate, limit);
    // Send html page
    res.status(200).send(currentStatus);
    //res.status(200).send(JSON.stringify(f2f));
    } catch (e) {
    // En cas d'exception, afficher le message
    res.status(500).send('<pre>' + (e.stack || e.message) + '</pre>');
    }
  }));

  app.get('/logos/status/:uid', (req, res) => co(function *() {
    
    try {

       var date = 0; // Default value
       if (typeof(req.query.date) != 'undefined' ) {
           date = parseInt(req.query.date);
       }

      const currentStatus = yield neo4jService.getIdentityStatus(req.params.uid, date);
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

  app.get('/logos/currentstats/:uid', (req, res) => co(function *() {
    
    try {
      const currentStats = yield neo4jService.getIdentityCurrentStats(req.params.uid);
    // Send html page
    res.status(200).send(currentStats);
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
