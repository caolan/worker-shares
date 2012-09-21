/**
 *  WorkerShares
 *  listens to changes on _users database and starts UserDbWorkers
 *  for each confirmed user account.
 */
var url     = require("url"),
    cradle  = require("cradle"),
    UserDbWorker = require('./UserDbWorker.js');

// Listen to changes in _users database and start 
// new share workers for confirmed sign ups
var WorkerShares = function(config) {
  this._initCouchConnection(config);

  this.couchConnection.database("_users").changes({since: 0, include_docs: true})
  .on("change", this._handleChange.bind(this))
  .on("error",  this._handleChangeError.bind(this));
};

WorkerShares.prototype = {

  // hash of all running workers
  workers: {},
  
  // 
  // initialize the connection to Couch using cradle
  // 
  _initCouchConnection: function(config) {
    var options = url.parse(config.server);
    options.auth = {
      username: config.admin.user,
      password: config.admin.pass
    };
    this.couchConnection = new(cradle.Connection)(options);
  },

  // 
  // handler for errors occuring in _users/changes listener.
  // Shouldn't happen at all.
  // 
  _handleChangeError: function(error) {
    console.log("error in WorkerShares");
    console.log( JSON.stringify(error, "", 2) );
  },

  // 
  // handler for changes from the _users/changes feed.
  // We start new UserDbWorkers for every new confirmed user account
  // 
  _handleChange: function(change)
  {
    if (! change.doc.database)
      return;

    if (change.deleted)
      return;

    if (this.workers[change.doc.database])
      return;
    
    if (change.doc.$state !== 'confirmed')
      return;
    
    this.workers[change.doc.database] = new UserWorker(change.doc.database, this.couchConnection);

    // TO BE DONE:
    // this.workers[change.doc.database].on("drop", function() {
    //   delete this.workers[change.doc.database];
    // });
  }
};

module.exports = WorkerShares;


// TODOs / next steps
// 
// 1. copy objects belonging to $shares from userDB => userSharesDB
// 2. create database and continuous replicatiosn for new $share objects
// 3. tricky one:
//    when changes to objects by others get replicate to a userSharesDB, copy the 
//    changes over to the userDB. Tricky part will be to distinguish between changes
//    my own changes and changes by others.
//    Idea: when copying objects from userDB => userSharesDB, add a $lastChangeBy
//          attribute, set to user's owner hash. Then do only replicate copy
//          userSharesDB => userDB when $lastChangeBy != user's owner hash