"use strict";

const Q = require('q');
const co = require('co');
const es = require('event-stream');
const duniter = require('duniter');
const neo4j = require('neo4j-driver').v1;
const ws = require('ws');

module.exports = (duniterServer, neo4jHost, neo4jPort) => {
    return new Neo4jService(duniterServer, neo4jHost, neo4jPort);
};

function Neo4jService(duniterServer, neo4jHost, neo4jPort) {

    const that = this;
    let db;
    var lastBlockNumber;
    var lastBlockHash;

    // Get Wot Stats
    this.getWotStats = (uid,date) => co(function*()  {
        const session = that.db.session();

        try {


            if (date == 0) {
            // Take the time of the last block
                var result = yield session.run(
                    "MATCH (:Root) <-[:NEXT]- (b:Block)\n\
                    RETURN b.medianTime");
                date = result.records[0]._fields[0]
            }


            // Get max diameter
            var result = yield session.run({text:
                "MATCH p=ShortestPath((n:Idty) -[s:CURRENT_CERTIFY*]-> (j:Idty))\n\
                RETURN length(p), [x in nodes(p)| x.uid]\n\
                ORDER BY length(p) DESC LIMIT 10",
                   parameters: {
                    date: date
            }});

            const wotStats = {}
            wotStats['maxDiameter'] = {maxDiameter: result.records[0]._fields[0].getLowBits(), paths:[]}

            for(const r of result.records) {
                wotStats['maxDiameter']['paths'].add(r._fields[1])
            } 

            return [wotStats]

        } catch (e) {
            console.log(e);
        } finally {
            // Completed!
            session.close();
        }
        return []     

    });


    // Get Events (new joiners, sentries, excluded and certifications)
    this.getWotEvents = (uid,fromDate,toDate,limit) => co(function*()  {

        const sigValidity = duniterServer.conf.sigValidity;
        const session = that.db.session();
        
        try {  

            if (toDate == 0) {
            // Take the time of the last block
                var result = yield session.run(
                    "MATCH (:Root) <-[:NEXT]- (b:Block)\n\
                    RETURN b.medianTime");
                toDate = result.records[0]._fields[0]
            }

            if (fromDate == 0) { fromDate = toDate - sigValidity };

            if (fromDate > toDate) {
            // There is an error in the request
                return []
            }

            // Get status events
            result = yield session.run({text:
                "MATCH (n:Idty) -[s:STATE]-> (j)\n\
                WHERE s.from >= {fromDate} AND s.from <= {toDate}\n\
                RETURN n.uid as uid, s.from as fromDate, s.to as toDate, labels(j) as state\n\
                ORDER BY s.from DESC LIMIT {limit}",
                   parameters: {
                    fromDate: fromDate,
                    toDate: toDate,
                    limit: limit
            }});

            const wotEvents = {} 
            wotEvents['membersEvents'] = []

            for(const r of result.records) {
                wotEvents['membersEvents'].add({
                    uid:r._fields[0],
                    event:r._fields[3][0],
                    from:r._fields[1],
                    to:r._fields[2]
                })
            } 

            // Get certifications
            result = yield session.run({text:
                "MATCH (n:Idty) -[s:CERTIFY]-> (j:Idty)\n\
                WHERE s.from >= {fromDate} AND s.from <= {toDate}\n\
                RETURN n.uid as uid, s.from as fromDate, s.to as toDate, j.uid, s.number, s.written\n\
                ORDER BY s.from DESC LIMIT {limit}",
                   parameters: {
                    fromDate: fromDate,
                    toDate: toDate,
                    limit: limit
            }});

            wotEvents['certifications'] = []
            for(const r of result.records) {
                wotEvents['certifications'].add({
                    from:r._fields[0],
                    to:r._fields[3],
                    date:r._fields[1],
                    expiration:r._fields[2],
                    writtenTime:r._fields[5],
                    writtenBlock:r._fields[4]
                })
            } 



        return [wotEvents];

        } catch (e) {
            console.log(e);
        } finally {
            // Completed!
            session.close();
        }
        return []      

    });

    // Get current state of a specified identity
    this.getIdentityStatus = (uid,date) => co(function*() {

        const session = that.db.session();
        try {

            if (date == 0) {
                var result = yield session.run(
                    "MATCH (:Root) <-[:NEXT]- (b:Block)\n\
                    RETURN b.medianTime");
                date = result.records[0]._fields[0]
            }

            var identityStatus = {
                uid: uid,
                date: date,
                status: {
                    joiner: {status: false, since:null},
                    sentry: {status:false, since:null},
                    excluded: {status:false, since:null}
                },
                certifications: {
                    issuedCertifications: [],
                    receivedCertifications: []
                }
            }


            result = yield session.run({text:
                "MATCH (n:Idty {uid:{uid}}) -[s:STATE]-> (j)\n\
                WHERE s.to >= {date} AND s.from <= {date}\n\
                RETURN s.from as date, labels(j) as state",
                   parameters: {
                    uid: uid,
                    date: date
                }});


            for(const r of result.records) {

                switch (r._fields[1][0]) {
                    case "JOINER":
                        console.log("Detect joiner")
                        identityStatus['status']['joiner']['status'] = true
                        identityStatus['status']['joiner']['since'] = r._fields[0]
                        break;
                    case "SENTRY":
                        identityStatus['status']['sentry']['status'] = true
                        identityStatus['status']['sentry']['since'] = r._fields[0]
                        break;
                    case "EXCLUDED":
                        identityStatus['status']['excluded']['status'] = true
                        identityStatus['status']['excluded']['since'] = r._fields[0]

                }
            }

            result = yield session.run({text:
                "MATCH (n:Idty {uid:{uid}}) -[s:CERTIFY]-> (j)\n\
                WHERE s.to >= {date} AND s.from <= {date}\n\
                RETURN s.from as date, s.to, s.written as written, j.uid",
                   parameters: {
                    uid: uid,
                    date: date
                }});

            for(const r of result.records) {
                    identityStatus['certifications']['issuedCertifications'].add({
                    date:  r._fields[0],
                    expiration:  r._fields[1],
                    written:  r._fields[2],
                    to: r._fields[3]
                })
            }

            result = yield session.run({text:
                "MATCH (n:Idty {uid:{uid}}) <-[s:CERTIFY]- (j)\n\
                WHERE s.to >= {date} AND s.from <= {date}\n\
                RETURN s.from as date, s.to, s.written as written, j.uid",
                   parameters: {
                    uid: uid,
                    date: date
                }});

            for(const r of result.records) {
                    identityStatus['certifications']['receivedCertifications'].add({
                    date:  r._fields[0],
                    expiration:  r._fields[1],
                    written:  r._fields[2],
                    to: r._fields[3]
                })
            }

            return [identityStatus];

            } catch (e) {
                console.log(e);
            } finally {
                // Completed!
                session.close();
            }
            return []
        });

    // Get all activity for a scpecified member from the start
    this.getIdentityHistory = (uid) => co(function*() {

        const session = that.db.session();
        try {

            var identityHistory = {};
            identityHistory['uid'] = uid;
            identityHistory['status'] = [];
            identityHistory['issuedCertifications'] = [];
            identityHistory['receivedCertifications'] = []

            // Get all status
            var result = yield session.run({text:
                "MATCH (n:Idty {uid:{uid}}) -[s:STATE]-> (j)\n\
                RETURN s.from as date, s.to as expiration, labels(j) as state\n\
                ORDER BY s.from DESC",
                   parameters: {
                    uid: uid
                }});

            for(const r of result.records) {

                identityHistory['status'].add({
                    date:  r._fields[0],
                    expiration:  r._fields[1],
                    status:  r._fields[2][0]
                })
            }

            // Get all issued certifications
            result = yield session.run({text:
                "MATCH (n:Idty {uid:{uid}}) -[c:CERTIFY]-> (j)\n\
                RETURN c.from as date, c.to as expiration, c.written as written, j.uid\n\
                ORDER BY c.from DESC",
                   parameters: {
                    uid: uid
                }});            

            for(const r of result.records) {

                identityHistory['issuedCertifications'].add({
                    date:  r._fields[0],
                    expiration:  r._fields[1],
                    written:  r._fields[2],
                    to: r._fields[3]
                })
            }

            // Get all received certifications
            result = yield session.run({text:
                "MATCH (n:Idty {uid:{uid}}) <-[c:CERTIFY]- (j)\n\
                RETURN c.from as date, c.to as expiration, c.written as written, j.uid\n\
                ORDER BY c.from DESC",
                   parameters: {
                    uid: uid
                }});            

            for(const r of result.records) {

                identityHistory['receivedCertifications'].add({
                    date:  r._fields[0],
                    expiration:  r._fields[1],
                    written:  r._fields[2],
                    from: r._fields[3]
                })
            }

            return [identityHistory];

            } catch (e) {
                console.log(e);
            } finally {
                // Completed!
                session.close();
            }
            return []
        });


        // Get Indicators for a specified users
        // API to know average path length to xpercent sentries
        this.getIdentityCurrentStats = (uid) => co(function*() {
        const session = that.db.session();
        try {

            const xpercent = duniterServer.conf.xpercent
            // Get stepmax
            const stepMax = duniterServer.conf.stepMax

            // Calculate the xpercent number of sentries
            var result = yield session.run({text:
                    "MATCH (n {sentry : true} )\n\
                    WHERE NOT n.uid = {uid}\n\
                    RETURN ceil({xpercent} * count(n)), count(n)",
                parameters: {
                    uid: uid,
                    xpercent: xpercent
                }});

            const nbxpercentSentries = result.records[0]._fields[0]
            const nbSentries = result.records[0]._fields[1]

            // calculate the average path length to reach xpercent sentries
            result = yield session.run({text:
                    "MATCH (sentry {sentry : true} )\n\
                    WHERE NOT sentry.uid = {uid}\n\
                    MATCH p=ShortestPath((member {uid:{uid}, joiner:true}) <-[:CURRENT_CERTIFY*.. "+ stepMax + "]- (sentry))\n\
                    WITH p, member, sentry\n\
                    ORDER BY length(p) LIMIT " + nbxpercentSentries + "\n\
                    RETURN member.uid, 1.0 * SUM(length(p)) / " + nbxpercentSentries + "\n", 
                parameters: {
                    uid: uid
                }});

           // console.log(result);

            const identityStats = {};
            identityStats['uid'] = result.records[0]._fields[0]
            identityStats['avgPathLength'] = result.records[0]._fields[1]

            // Calculte number of reachable sentries at maxStep
            result = yield session.run({text:
                    "MATCH p=ShortestPath((member {uid:{uid}, joiner:true}) <-[:CURRENT_CERTIFY*.."+ stepMax + "]-(sentry {sentry : true}))\n\
                    WHERE length(p) <= {stepMax} AND member <> sentry\n\
                    RETURN 100.0 * count(sentry) / {nbSentries} AS percent",
                parameters: {
                    uid: uid,
                    stepMax: stepMax,
                    nbSentries: nbSentries
                }});

            identityStats['pctReachableSentries'] = result.records[0]._fields[0]

            return [identityStats];

            } catch (e) {
                console.log(e);
            } finally {
                // Completed!
                session.close();
            }
        return []
    });

    


    // Import Data from blocks table
    this.refreshWot = () => co(function*() {

        console.log("[Refresh Wot] *** Running Refresh Wot ***");
        const session = that.db.session();
        try {

                // Initialize object variables
                var lastBlock = yield session.run("MATCH (n:Root) <-[:NEXT*1]- (b:Block) RETURN b.number as number, b.hash as hash");

                // Check the last block number in the database
                const max = (yield duniterServer.dal.bindexDAL.query('SELECT MAX(number) FROM block WHERE fork = 0'))[0]['MAX(number)'];
                // const max = 9743;

                console.log(lastBlock + " " + max)

                if (!lastBlock.records[0]) {
                    // If it's the first run, there's no block

                    console.log("[Refresh Wot] First run detected, Create Root Nodes")

                    // Create root node
                    yield session.run("MERGE (n:Root)");
                    
                    lastBlockNumber = -1;
                    lastBlockHash = "";
 
                } else if ( lastBlock.records[0]._fields[0] < max ) {
                // There is data to import

                        lastBlockNumber = lastBlock.records[0]._fields[0];
                        lastBlockHash = lastBlock.records[0]._fields[1];
                        

                        var nextBlockNumber = lastBlockNumber + 1;
                        var nextBlock = (yield duniterServer.dal.bindexDAL.query("SELECT number, previousHash\n\
                                                                             FROM block\n\
                                                                             WHERE fork = 0 AND number = " + nextBlockNumber )); 
                        
                        console.log("[Refresh Wot] LastBlock Number in Neo4j: " + lastBlockNumber + " - LastBlock Number in SQLite : " + max)

                    if (nextBlock[0]['previousHash'] != lastBlockHash) {
                        // There is a fork
                        // Find fork point

                        console.log("[Refresh Wot] Fork detected")

                        var i = 2;
                        do {

                            lastBlock = yield session.run("MATCH (n:Root) <-[:NEXT*" + i + "]- (b:Block) RETURN b.number, b.hash, b.medianTime");
                            lastBlockNumber = lastBlock.records[0]._fields[0];
                            lastBlockHash = lastBlock.records[0]._fields[1];

                            nextBlockNumber = lastBlockNumber + 1;
                            nextBlock = (yield duniterServer.dal.bindexDAL.query("SELECT number, previousHash\n\
                                                                                 FROM block\n\
                                                                                 WHERE fork = 0 AND number = " + nextBlockNumber ));  
                            i ++;

                            //console.log("lastBlockNumber : " + lastBlockNumber + ", lastBlockHash : " + lastBlockHash + ", nextBlockPreviousHash : " + nextBlock[0]['previousHash'])

                        } while (nextBlock[0]['previousHash'] != lastBlockHash)

                        // Destroy certification created after the fork point
                        yield session.run({
                        text: "MATCH (i:Idty) -[r:CERTIFY]-> ()\n\
                               WHERE r.written > {medianTime}\n\
                               DELETE r",
                            parameters: {
                                medianTime: lastBlock.records[0]._fields[2]
                            }
                        });

                        // Destroy states created after the fork point
                        yield session.run({
                        text: "MATCH (i:Idty) -[r:STATE]-> ()\n\
                               WHERE r.from > {medianTime}\n\
                               DELETE r",
                            parameters: {
                                medianTime: lastBlock.records[0]._fields[2]
                            }
                        });                        

                        // Destroy nodes created after the fork point
                        yield session.run({
                        text: "MATCH (i:Idty) \n\
                               WHERE NOT (i) --> ()\n\
                               DELETE i",
                            parameters: {
                                medianTime: lastBlock.records[0]._fields[2]
                            }
                        });
                    } 

                }
                else {
                    console.log("[Refresh Wot] Nothing to do")
                    return []
                }

            // Read blocks to import
            const blocks = (yield duniterServer.dal.bindexDAL.query("SELECT number, hash, membersCount, previousHash, medianTime, joiners, excluded, certifications\n\
                                                                                FROM block\n\
                                                                                WHERE fork = 0 AND number > " + lastBlockNumber + " AND number <= " + max + "\n\
                                                                                ORDER BY number"));
            
                // for each block, update Neo4j
                // Note : Using transactions to speed up node creations (10 times faster)

                var tx = session.beginTransaction();
                for(var i = 0; i < blocks.length; i ++) {

                        console.log("[Refresh Wot] Import Block : " + blocks[i]['number']);

                        // Timestamps
                        var medianTime = blocks[i]['medianTime'];
                        const maxlong = 9223372036854775807;

                        // Create join identities
                        const joiners = JSON.parse(blocks[i]['joiners'])

                        for(const joiner of joiners) {

                            console.log("[Refresh Wot] New joiner " + joiner.split(":")[4]);
                            console.log(medianTime)

                            yield tx.run({
                            text: "MERGE (identity:Idty {pubkey:{pubkey}, uid:{uid}})\n\
                            WITH identity\n\
                            OPTIONAL MATCH (identity) -[previousState:STATE {to:{to}}]-> ()\n\
                            SET previousState.to = {from}\n\
                            WITH identity\n\
                            CREATE (identity) -[:STATE {from:{from}, to:{to}, number:{number}}]-> (:JOINER)",
                                parameters: {
                                    number: blocks[i]['number'],
                                    uid: joiner.split(":")[4],
                                    pubkey: joiner.split(":")[0],
                                    from: medianTime,
                                    to: maxlong
                                }
                            });  
                        }

                        // Create excluded identities
                        const excluded = JSON.parse(blocks[i]['excluded'])

                        for(const member of excluded) {

                            console.log("[Refresh Wot] New excluded " + member);

                            yield tx.run({
                            text: "MATCH (identity:Idty {pubkey:{pubkey}}) -[previousState:STATE {to:{to}}]-> () \n\
                            SET previousState.to = {from}",
                                parameters: {
                                    pubkey: member,
                                    from: medianTime,
                                    to: maxlong
                                }
                            }); 

                            // Did in two steps to avoid strange bug (create twe EXCLUDED node for the same member)
                            yield tx.run({
                            text: "MATCH (identity:Idty {pubkey:{pubkey}})\n\
                            CREATE (identity) -[:STATE {from:{from}, to:{to}, number:{number}}]-> (:EXCLUDED)",
                                parameters: {
                                    number: blocks[i]['number'],
                                    pubkey: member,
                                    from: medianTime,
                                    to: maxlong
                                }
                            });  
                        }

                        // Create certifications relationships
                        const certifications = JSON.parse(blocks[i]['certifications'])

                        // Valid certification time
                        const sigValidity = duniterServer.conf.sigValidity;
                        const stepMax = duniterServer.conf.stepMax;
                        const membersCount = blocks[i]['membersCount']
                        const dSen = Math.ceil(Math.pow(membersCount, 1 / stepMax));

                        for(const certificate of certifications) {

                            // Get date of certificate emission (different from date written)
                            const issuedBlock = (yield duniterServer.dal.bindexDAL.query("SELECT medianTime FROM block\n\
                                                                                        WHERE fork = 0 AND number = " + certificate.split(":")[2] ));

                            const issuedTime = issuedBlock[0]['medianTime'];

                            yield tx.run({
                            text: "MATCH (idty_from:Idty {pubkey:{pubkey_from}}), (idty_to:Idty {pubkey:{pubkey_to}})\n\
                            CREATE (idty_from) -[:CERTIFY {from:{from}, to:{to}, written:{written}}]-> (idty_to)",
                                parameters: {
                                    pubkey_from: certificate.split(":")[0],
                                    pubkey_to: certificate.split(":")[1],
                                    written: medianTime,
                                    from: issuedTime,
                                    to: issuedTime + sigValidity
                                }
                            }); 

                            // Pre-Compute Sentries
                            // Check if issuer and/or receiver become sentry

                            for(const pubkey of [certificate.split(":")[0], certificate.split(":")[1]]) {

                                console.log("[RefreshWot] Check Sentry with dSen = " + dSen + " for pubkey " + pubkey);

                                 yield tx.run({
                                text: "MATCH (idty:Idty {pubkey:{pubkey}}) -[c:CERTIFY]-> ()\n\
                                        WHERE c.to >= {from}\n\
                                        WITH idty, count(c) as issuedCount\n\
                                        MATCH (idty) <-[c:CERTIFY]- ()\n\
                                        WHERE c.to >= {from}\n\
                                        WITH idty, count(c) as certCount, issuedCount\n\
                                        WHERE certCount >= {dSen} AND issuedCount >= {dSen}\n\
                                        MERGE (idty) -[s:STATE {to:{to}}]-> (:SENTRY)\n\
                                        ON CREATE SET s.from = {from}",
                                    parameters: {
                                        dSen: dSen,
                                        pubkey: pubkey,
                                        from: medianTime,
                                        to:maxlong
                                    }
                                });
                            }

                        }

                        // Check if current sentries are still sentries
                        // Calcul is done at each block
                        console.log("[RefreshWot] Check if there is expiring sentries");

                            yield tx.run({
                                text: "MATCH (i:Idty) -[s:STATE]-> (:SENTRY)\n\
                                WHERE s.to = {to}\n\
                                WITH i, s\n\
                                MATCH (i) -[c:CERTIFY]-> ()\n\
                                WHERE c.to >= {from}\n\
                                WITH i, s, count(c) as issuedCount\n\
                                MATCH (i) <-[c:CERTIFY]- ()\n\
                                WHERE c.to >= {from}\n\
                                WITH i, s, issuedCount, count(c) as certCount\n\
                                WHERE NOT certCount >= {dSen} OR NOT issuedCount >= {dSen}\n\
                                SET s.to = {from}",
                            parameters: {
                                dSen: dSen,
                                from: medianTime,
                                to: maxlong
                                }
                            });

                    }

                console.log("[RefreshWot] Create the current wot view");

                // Pre-compute current valid certifications in order to facilitate queries
                // Quick and dirty 

                yield tx.run("MATCH () <-[c:CURRENT_CERTIFY]- () DELETE c");
                yield tx.run("MATCH (i:Idty {sentry:true}) REMOVE i.sentry"); 
                yield tx.run("MATCH (i:Idty {joiner:true}) REMOVE i.joiner"); 

                yield tx.run("MATCH (i:Idty) -[s:STATE {to:9223372036854775807}]-> (:JOINER)\n\
                            SET i.joiner = true");
                yield tx.run("MATCH (i:Idty) -[s:STATE {to:9223372036854775807}]-> (:SENTRY)\n\
                            SET i.sentry = true");


                yield tx.run({text:"MATCH (i:Idty) -[c:CERTIFY]-> (j:Idty)\n\
                                    WHERE c.to >= {medianTime}\n\
                                    CREATE (i) <-[:CURRENT_CERTIFY]- (j)",
                                    parameters: {
                                        medianTime: medianTime

                                    }
                                });

                // Update the block tracking (100 last blocks)
                // Quick and dirty way implemented here

                console.log("[RefreshWot] Refresh the block tracking");

                // Remove Blocks Tracking
                yield tx.run({text:"MATCH (block:Block)\n\
                                    DETACH DELETE block"});


                // Read blocks to import
                const blocksTrack = (yield duniterServer.dal.bindexDAL.query("SELECT number, hash, medianTime\n\
                                                                                    FROM block\n\
                                                                                    WHERE fork = 0 AND number <= " + max + "\n\
                                                                                    ORDER BY number DESC\n\
                                                                                    LIMIT 100"));

                // Attach the last block to the root node
                yield tx.run({text:"MATCH (root:Root)\n\
                            CREATE (root) <-[:NEXT]- (block:Block)\n\
                            SET block.number = {number}, block.hash = {hash}, block.medianTime = {medianTime}",
                            parameters: {
                                // need to change the last block element 
                                number: blocksTrack[0]['number'],
                                hash: blocksTrack[0]['hash'],
                                medianTime: blocksTrack[0]['medianTime']
                            }
                });

                // Then create others nodes sequentially
                for(var i = 1; i < blocksTrack.length; i ++) {

                    yield tx.run({text:"MATCH (b:Block)\n\
                                        WHERE NOT (b) <-[:NEXT]- ()\n\
                                        CREATE (b) <-[:NEXT]- (block:Block)\n\
                                        SET block.number = {number}, block.hash = {hash}, block.medianTime = {medianTime}",
                                        parameters: {
                                            number: blocksTrack[i]['number'],
                                            hash: blocksTrack[i]['hash'],
                                            medianTime: blocksTrack[i]['medianTime']

                                        }
                                    });
                }

                yield tx.commit();
                console.log("[Refresh Wot] Commit Changes")
            

        } catch (e) {
            console.log(e);
        } finally {
            // Completed!
            console.log("[Refresh Wot] *** Exiting Refresh Wot ***")
            session.close();
        }
        return []
    });


    this.init = () => co(function*() {

        try {
                that.db = neo4j.driver("bolt://" + neo4jHost,
                neo4j.auth.basic(duniterServer.conf.neo4j.user, duniterServer.conf.neo4j.password));

                //yield that.refreshWot();

                yield that.refreshWot();
                // Update the database every 60 seconds
                setInterval(that.refreshWot, 3 * 60 * 1000);
                

                that.db.onError = (error) => {
                    console.log(error);
                };

        } catch (e) {
            console.log(e);
        }
    });     

}
