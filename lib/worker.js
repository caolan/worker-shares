/**
 *  Worker
 *  listens to changes on _users database and starts UserDbWorkers
 *  for each confirmed user account.
 */
var UserDbWorker = require('./user_db_worker.js');
var util         = require('util');
var HoodieWorker = require('hoodie-worker');

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
  this.log('launching …')
  this.userDbWorkers = {}

  this.listenUp()
}

// 
// 
// 
Worker.prototype.listenUp = function() {

  // _users changes feed events
  this.couch.database("_users").changes({since: 0, include_docs: true})
  .on("change", this.handleChange.bind(this))
  .on("error",  this.handleChangeError.bind(this));

  // worker events
  this.on("account:removed", this.handleRemovedUserAccount.bind(this) )
  this.on("account:created", this.handleCreatedUserAccount.bind(this) )
};

// 
// handler for errors occuring in _users/changes listener.
// Shouldn't happen at all.
// 
Worker.prototype.handleChangeError = function(error) {
  this.handleError( error, 'error in _changes feed' );
}

// 
// handler for changes from the _users/changes feed.
// We start new UserDbWorkers for every new confirmed user account
// 
Worker.prototype.handleChange = function(change)
{ 
  var eventName;

  // this filters out things like password resets, that also create
  // new docs in _users database, as it is the only datbase that
  // can work as a secure drop box in CouchDB land.
  if (! change.doc.database)
    return

  // we wait until an account has been confirmed before we create
  // the user shares database. That also filters out removed user
  // accounts that have not been confirmed yet.
  if (change.doc.$state !== 'confirmed')
    return

  // just a convinience check to ignore valid accounts that have been
  // deleted but we did not initialize yet
  if (change.deleted && ! this.userDbInitialized(change.doc.database)) 
    return

  // differentiate between `added`, `changed`, `removed` events
  if (change.deleted) {
    eventName = 'removed'
  } else {
    eventName = this.userDbInitialized(change.doc.database) ? 'changed' : 'added';
  }
  this.emit( "account:" + eventName, change.doc.database )
}


// 
// 
// 
Worker.prototype.userDbInitialized = function( dbName ) {
  return !!this.userDbWorkers[dbName];
}

// 
// 
// 
Worker.prototype.handleCreatedUserAccount = function( dbName ) {
  this.log("User account created: %s", dbName)
  this.userDbWorkers[dbName] = new UserDbWorker(dbName, this);
}

// 
// 
// 
Worker.prototype.handleRemovedUserAccount = function( dbName ) {
  this.log("User account destroyed: %s", dbName);
  delete this.userDbWorkers[dbName];
}


// 
// 
// 
Worker.prototype.createShareSkeleton = function() {
  var defer = this.when.defer();

  this.log('creating skeleton/share database ...')
  this.couch.database('skeleton/share').create( function(error) {
    if (! error) {
      this.log('skeleton/share database created ...')
      defer.resolve();
      return
    }
      

    if (error.error === 'file_exists') {
      this.log('skeleton/share already exists ...')
      defer.resolve()
    } else {
      error.context = 'createShareSkeleton'
      defer.reject(error)
    }
  }.bind(this))

  
  return defer.promise
}



Worker.prototype.createDesignDocsInShareSkeleton = function() {
  this.log('creatinging design docs in skeleton/share database ...')
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
  var save = this.promisify( this.couch.database('skeleton/share'), 'save')
  return this.when([
    save( docs[0]._id, docs[0] ),
    save( docs[1]._id, docs[1] )
  ])
}

//    - create design docs in _users
Worker.prototype.createDesignDocsInUsers = function() {
  this.log('creatinging design docs in _users database ...')
  var doc = {
    "_id": "_design/views",
    "views": {
      "ownerByUsername": {
        "map": "function(doc) { var username; if (doc.ownerHash) { username = doc.name.replace(/^user(_anonymous)?\\//, ''); emit(username, doc.ownerHash); }; };"
      }
    }
  }
  var save = this.promisify( this.couch.database('_users'), 'save');
  return save( doc._id, doc );
}

//    - create design docs in _replicator
Worker.prototype.createDesignDocsInReplicator = function() {
  this.log('creatinging design docs in _replicator database ...')
  this.log('WFTOFNWTYUFWNUYFWTNFWOYUTNFWUYTNFWYUTN')
  var doc = {
    "_id": "_design/shares",
    "updates": {
      "stop": "function(doc, req) { log('stopping replication ' + doc._id); doc._deleted = true; return [doc, \"OK\"] };",
      "start": "function(doc, req) { var dbs, share_id; if (! doc) doc = {}; doc._id = req.id; dbs = req.id.split(' => '); doc.source = dbs[0]; doc.target = dbs[1]; doc.continuous = true; doc.user_ctx = {name: req.userCtx.name, roles: req.userCtx.roles}; doc.createdAt = doc.updatedAt = JSON.stringify(new Date); for (var key in req.query) { doc[key] = req.query[key]; }; share_id = req.id.match('share/([0-9a-z]+)').pop(); doc.query_params = {}; doc.query_params.share_id = share_id; return [doc, \"OK\"] };"
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
  //   doc.createdAt = doc.updatedAt = JSON.stringify(new Date); 
  //   for (var key in req.query) { 
  //     doc[key] = req.query[key]; 
  //   }; 
  //   share_id = req.id.match('share/([0-9a-z]+)').pop(); 
  //   doc.query_params = {};
  //   doc.query_params.share_id = share_id;
  //   return [doc, "OK"] 
  // };


  return this.promisify( this.couch.database('_replicator'), 'save')( doc._id, doc )
}

module.exports = Worker;