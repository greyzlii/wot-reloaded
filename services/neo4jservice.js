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


    // Import Data from blocks table
    this.refreshWot = () => co(function*() {

        console.log("[Refresh Wot] *** Running Refresh Wot ***");
        const session = that.db.session();
        try {

                // Initialize object variables
                var lastBlock = yield session.run("MATCH (n:Root) <-[:NEXT*1]- (b:Block) RETURN b.number as number, b.hash as hash");

                // Check the last block number in the database
                const max = (yield duniterServer.dal.bindexDAL.query('SELECT MAX(number) FROM block WHERE fork = 0'))[0]['MAX(number)'];
                //const max = 10;

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
                            CREATE (identity) -[:STATE {from:{from}, to:{to}}]-> (:JOINER)",
                                parameters: {
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
                            SET previousState.to = {from}\n\
                            WITH identity\n\
                            CREATE (identity) -[:STATE {from:{from}, to:{to}}]-> (:EXCLUDED)",
                                parameters: {
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

                // Update the block tracking (100 last blocks)
                // Quick and dirty way implemented here

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
                setInterval(that.refreshWot, 10 * 1000);
                

                that.db.onError = (error) => {
                    console.log(error);
                };

        } catch (e) {
            console.log(e);
        }
    });     

}
