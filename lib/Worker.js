/**
 *  Worker
 *  listens to changes on _users database and starts UserDbWorkers
 *  for each confirmed user account.
 */
var UserDbWorker = require('./UserDbWorker.js'),
    install      = require('./install.js');

// Listen to changes in _users database and start 
// new share workers for confirmed sign ups
var Worker = function(config) {
  install(this, config).then( this.bootUp.bind(this) )
};

Worker.prototype = {

  // hash of all running workers
  workers: {},

  bootUp : function() {
      this._log('listening to _users changes ...')
      this.couch.database("_users").changes({since: 0, include_docs: true})
      .on("change", this._handleChange.bind(this))
      .on("error",  this._handleChangeError.bind(this));
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
    
    this.workers[change.doc.database] = new UserDbWorker(change.doc.database, this.couch);

    // TO BE DONE:
    // this.workers[change.doc.database].on("drop", function() {
    //   delete this.workers[change.doc.database];
    // });
  },

  _log: function() {
    arguments[0] = "[Worker] " + arguments[0];
    console.log.apply(null, arguments)
  }
};

module.exports = Worker;