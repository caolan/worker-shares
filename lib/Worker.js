/**
 *  Worker
 *  listens to changes on _users database and starts UserDbWorkers
 *  for each confirmed user account.
 */
var UserDbWorker = require('./user_db_worker.js');
var util          = require('util');
var HoodieWorker  = require('hoodie-worker');

// Listen to changes in _users database and start 
// new share workers for confirmed sign ups
var Worker = function(config) {
  this.setup(config).then( this.launch.bind(this) )
};
util.inherits(Worker, HoodieWorker);


// hash of all running workers
Worker.prototype.workers = {};

Worker.prototype.install = function() {
  return this.when([
    this.createShareSkeleton(), 
    this.createDesignDocsInUsers(), 
    this.createDesignDocsInReplicator()
  ])
  .then( this.createDesignDocsInShareSkeleton.bind(this) )
};

Worker.prototype.launch = function() {
  this._log('listening to _users changes ...')
  this.couch.database("_users").changes({since: 0, include_docs: true})
  .on("change", this._handleChange.bind(this))
  .on("error",  this._handleChangeError.bind(this));
}

// 
// handler for errors occuring in _users/changes listener.
// Shouldn't happen at all.
// 
Worker.prototype._handleChangeError = function(error) {
  this._log( 'Error: %j', error );
}

// 
// handler for changes from the _users/changes feed.
// We start new UserDbWorkers for every new confirmed user account
// 
Worker.prototype._handleChange = function(change)
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
}

Worker.prototype._log = function(message) {
  message = "[" + this.name + "Worker] " + message;
  console.log.apply(null, arguments)
}

Worker.prototype.createShareSkeleton = function() {
  var defer = this.defer();

  this._log('creating skeleton/share database ...')
  this.couch.database('skeleton/share').create( function(error) {
    if (! error) {
      this._log('skeleton/share database created ...')
      defer.resolve();
      return
    }
      

    if (error.error === 'file_exists') {
      this._log('skeleton/share already exists ...')
      defer.resolve()
    } else {
      error.context = 'createShareSkeleton'
      defer.reject(error)
    }
  }.bind(this))

  
  return defer.promise
}



Worker.prototype.createDesignDocsInShareSkeleton = function() {
  this._log('creatinging design docs in skeleton/share database ...')
  var docs = [
    {
      "_id": "_design/filters",
      "filters": {
           "share": "function(doc, req) { return doc._id.indexOf(req.query.share_id) === 6  };"
      },
      // https://github.com/cloudhead/cradle#creating-validation
      views: {}
    },
    {
      "_id": "_design/write_access",
      "validate_doc_update": "function(newDocument, oldDocument, userContext, securityObject) {   if (!securityObject.writers || securityObject.writers.roles.length === 0) return;   if (userContext.roles.indexOf('_admin') !== -1) return;  for (var i = 0; i < securityObject.writers.roles.length; i++) {     log('securityObject.writers.roles[' + i + ']: ' + securityObject.writers.roles[i]);    for (var j = 0; j < userContext.roles.length; j++) {       log('userContext.roles['+j+']: ' + userContext.roles[j]);      if (securityObject.writers.roles[i] === userContext.roles[j]) return;     }   }   throw({forbidden: 'you are not allowed edit objects in ' + userContext.db}); };",
      // https://github.com/cloudhead/cradle#creating-validation
      views: {}
    }
  ]
  return this.when([
    this.promisify( this.couch.database('skeleton/share'), 'save', 'createDesignDocsInShareSkeleton' )( docs[0]._id, docs[0] ),
    this.promisify( this.couch.database('skeleton/share'), 'save', 'createDesignDocsInShareSkeleton' )( docs[1]._id, docs[1] )
  ])
}

//    - create design docs in _users
Worker.prototype.createDesignDocsInUsers = function() {
  this._log('creatinging design docs in _users database ...')
  var doc = {
    "_id": "_design/views",
    "views": {
      "ownerByUsername": {
        "map": "function(doc) { var username; if (doc.ownerHash) { username = doc.name.replace(/^user(_anonymous)?\\//, ''); emit(username, doc.ownerHash); }; };"
      }
    }
  }
  return this.promisify( this.couch.database('_users'), 'save', 'createDesignDocsInUsers' )( doc._id, doc )
}

//    - create design docs in _replicator
Worker.prototype.createDesignDocsInReplicator = function() {
  this._log('creatinging design docs in _replicator database ...')
  this._log('WFTOFNWTYUFWNUYFWTNFWOYUTNFWUYTNFWYUTN')
  var doc = {
    "_id": "_design/shares",
    "updates": {
      "stop": "function(doc, req) { log('stopping replication ' + doc._id); doc._deleted = true; return [doc, \"OK\"] };",
      "start": "function(doc, req) { var dbs, share_id; if (! doc) doc = {}; doc._id = req.id; dbs = req.id.split(' => '); doc.source = dbs[0]; doc.target = dbs[1]; doc.continuous = true; doc.user_ctx = {name: req.userCtx.name, roles: req.userCtx.roles}; doc.$createdAt = doc.$updatedAt = JSON.stringify(new Date); for (var key in req.query) { doc[key] = req.query[key]; }; share_id = req.id.match('share/([0-9a-z]+)').pop(); doc.query_params = {}; doc.query_params.share_id = share_id; return [doc, \"OK\"] };"
    },

    // https://github.com/cloudhead/cradle#creating-validation
    views: {}
  }

  // // updates.start
  // function(doc, req) { 
  //   var dbs, share_id; 
  //   if (! doc) doc = {}; 
  //   doc._id = req.id; 
  //   dbs = req.id.split(' => '); 
  //   doc.source = dbs[0]; 
  //   doc.target = dbs[1]; 
  //   doc.continuous = true; 
  //   doc.user_ctx = {name: req.userCtx.name, roles: req.userCtx.roles}; 
  //   doc.$createdAt = doc.$updatedAt = JSON.stringify(new Date); 
  //   for (var key in req.query) { 
  //     doc[key] = req.query[key]; 
  //   }; 
  //   share_id = req.id.match('share/([0-9a-z]+)').pop(); 
  //   doc.query_params = {};
  //   doc.query_params.share_id = share_id;
  //   return [doc, "OK"] 
  // };


  return this.promisify( this.couch.database('_replicator'), 'save', 'createDesignDocsInReplicator' )( doc._id, doc )
}

module.exports = Worker;