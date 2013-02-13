/**
 *  Worker
 *  listens to changes on _users database and starts UserDbWorkers
 *  for each confirmed user account.
 */
var UserDbWorker   = require('./user_database.js');
var SharesDbWorker = require('./shares_database.js');
var util           = require('util');
var HoodieWorker   = require('hoodie-worker');

// get JSONs for design docs required by the shares worker
var usersDesignDoc                = require('../couch_files/_users/_design:users_views')
var replicatorDesignDoc           = require('../couch_files/_replicator/_design:shares')
var shareFiltersDesignDoc         = require('../couch_files/skeleton:share/_design:share_filters')
var shareAccessDesignDoc          = require('../couch_files/skeleton:share/_design:write_access')
var sharesDatabaseSecurityOptions = require('../couch_files/shares/_security')

// Listen to changes in _users database and start 
// new share workers for confirmed sign ups
var Worker = function(config) {
  this.setup(config).then( this.launch.bind(this) )
};
util.inherits(Worker, HoodieWorker);


// hash of all running workers
Worker.prototype.workers = {};

Worker.prototype.install = function() {
  return this.when.all([
    this.createShareSkeletonDatabase(), 
    this.createSharesDatabase(), 
    this.createDesignDocsInUsers(), 
    this.createDesignDocsInReplicator()
  ])
};

Worker.prototype.launch = function() {
  this.log('launching …');
  this.userDbWorkers = {};

  new SharesDbWorker(this);

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
  this.on("account:added", this.handleCreatedUserAccount.bind(this) )
};

// 
// handler for errors occuring in _users/changes listener.
// Shouldn't happen at all.
// 
Worker.prototype.handleChangeError = function(error) {
  this.handleError( error, 'error in _users/_changes feed' );
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

  // differentiate between `added`, `updated`, `removed` events
  if (change.deleted) {
    eventName = 'removed'
  } else {
    eventName = this.userDbInitialized(change.doc.database) ? 'updated' : 'added';
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
Worker.prototype.createShareSkeletonDatabase = function() {
  var create = this.promisify( this.couch.database('skeleton/share'), 'create' );

  this.log('creating skeleton/share database ...')
  return create()
  .otherwise( this.handleCreateDatabaseError.bind(this) )
  .then( this.handleCreateShareSkeletonSuccess.bind(this) )
}


// 
// when an database cannot be created due to 'file_exists' error
// it's just fine. In this case we return a resolved promise.
// 
Worker.prototype.handleCreateDatabaseError = function(error) {
  if (error.error === 'file_exists') {
    return this.when.resolve()
  } else {
    return this.when.reject(error)
  }
}


// 
// 
// 
Worker.prototype.handleCreateShareSkeletonSuccess = function() {
  return this.createDesignDocsInShareSkeleton()
}


// 
// 
// 
Worker.prototype.createDesignDocsInShareSkeleton = function() {
  this.log('creatinging design docs in skeleton/share database ...')

  var save = this.promisify( this.couch.database('skeleton/share'), 'save')

  return this.when.all([
    save( shareFiltersDesignDoc._id, shareFiltersDesignDoc ),
    save( shareAccessDesignDoc ._id, shareAccessDesignDoc  )
  ])
}


// 
// 
// 
Worker.prototype.createSharesDatabase = function() {
  var create = this.promisify( this.couch.database('shares'), 'create' );

  this.log('creating shares database ...')
  return create()
  .otherwise( this.handleCreateDatabaseError.bind(this) )
  .then( this.handleCreateSharesDatabaseSuccess.bind(this) )
}


// 
// 
// 
Worker.prototype.handleCreateSharesDatabaseSuccess = function() {
  return this.createSharesDatabaseSecurity()
}


// 
// 
// 
Worker.prototype.createSharesDatabaseSecurity = function() {

  var query = this.promisify(this.couch.database("shares"), 'query')

  return query( sharesDatabaseSecurityOptions )
  .otherwise( this.handleCreateSharesDatabaseSecurityError );
};


// 
// 
// 
Worker.prototype.handleCreateSharesDatabaseSecurityError = function(error) {
  this.handleError(error, "could not create/update _security in shares")
  return this.when.reject( error )
}


//    
//    
//    
Worker.prototype.createDesignDocsInUsers = function() {
  this.log('creatinging design docs in _users database ...')

  var save = this.promisify( this.couch.database('_users'), 'save');
  return save( usersDesignDoc._id, usersDesignDoc );
}


//    
//    
//    
Worker.prototype.createDesignDocsInReplicator = function() {
  this.log('creatinging design docs in _replicator database ...')

  var save = this.promisify( this.couch.database('_replicator'), 'save')
  return save( replicatorDesignDoc._id, replicatorDesignDoc )
}

module.exports = Worker;