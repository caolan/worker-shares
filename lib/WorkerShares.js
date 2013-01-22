/**
 *  WorkerShares
 *  listens to changes on _users database and starts UserDbWorkers
 *  for each confirmed user account.
 */
var url          = require("url"),
    fs           = require("fs"),
    cradle       = require("cradle"),
    UserDbWorker = require('./UserDbWorker.js');

// Listen to changes in _users database and start 
// new share workers for confirmed sign ups
var WorkerShares = function(config) {
  this._initCouchConnection(config);

  this._install( function() {

    this._log('listening to _users changes ...')
    this.couchConnection.database("_users").changes({since: 0, include_docs: true})
    .on("change", this._handleChange.bind(this))
    .on("error",  this._handleChangeError.bind(this));

  }.bind(this));
};

WorkerShares.prototype = {

  // install
  _install: function( callback) {
    var install_file = __dirname + "/install.js";
    if(fs.existsSync(install_file)) {
      var install = require(install_file);
      new install(this.couchConnection, callback);
    } else {
      callback()
    }
  },

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
    this._log( 'Error: %j', error );
  },

  // 
  // handler for changes from the _users/changes feed.
  // We start new UserDbWorkers for every new confirmed user account
  // 
  _handleChange: function(change)
  {
    this._log('hangle change: %j', change)
    if (! change.doc.database)
      return;

    if (change.deleted) {
      if (this.workers[change.doc.database]) {
        this._log("User account destroyed: %s", change.doc.database)
        this.workers[change.doc.database].sharesWorker.dropAllDatabases();
      }
      return;
    }

    if (this.workers[change.doc.database])
      return;
    
    if (change.doc.$state !== 'confirmed')
      return;
    
    this.workers[change.doc.database] = new UserDbWorker(change.doc.database, this.couchConnection);

    // TO BE DONE:
    // this.workers[change.doc.database].on("drop", function() {
    //   delete this.workers[change.doc.database];
    // });
  },

  _log: function() {
    arguments[0] = "[WorkerShares] " + arguments[0];
    console.log.apply(null, arguments)
  }
};

module.exports = WorkerShares;