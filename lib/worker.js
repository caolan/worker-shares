/**
 *  SharesWorker
 *  
 */
var SharesDatabase = require('./shares_database.js');
var UsersDatabase  = require('./users_database.js');
var util           = require('util');
var HoodieWorker   = require('hoodie-worker');

// get JSONs for design docs required by the shares worker
var usersDesignDoc                = require('../couch_files/_users/_design:users_views')
var replicatorDesignDoc           = require('../couch_files/_replicator/_design:shares')
var shareFiltersDesignDoc         = require('../couch_files/skeleton:share/_design:share_filters')
var shareAccessDesignDoc          = require('../couch_files/skeleton:share/_design:write_access')
var shareSkeletonSecurityOptions  = require('../couch_files/skeleton:share/_security')
var sharesDatabaseSecurityOptions = require('../couch_files/shares/_security')

// Listen to changes in _users database and start 
// new share workers for confirmed sign ups
var SharesWorker = function(config) {
  this.setup(config)
  .then( this.launch.bind(this) )
  .otherwise( this.handleError.bind(this) )
};
util.inherits(SharesWorker, HoodieWorker);


// 
// install is called within the setup and can 
// return a promise for asynchronous tasks.
// 
// the shares worker several databases in
// _design docs in here.
// 
SharesWorker.prototype.install = function() {
  return this.when.all([
    this.createShareSkeletonDatabase(), 
    this.createSharesDatabase(), 
    this.createDesignDocsInUsers(), 
    this.createDesignDocsInReplicator()
  ])
};


// 
// 
// 
SharesWorker.prototype.launch = function() {
  this.log('launching …');
  new SharesDatabase(this);
  new UsersDatabase(this);
}


// 
// 
// 
SharesWorker.prototype.createShareSkeletonDatabase = function() {
  var create = this.promisify( this.couch.database('skeleton/share'), 'create' );

  this.log('creating skeleton/share database …')
  return create()
  .otherwise( this.handleCreateDatabaseError.bind(this) )
  .then( this.handleCreateShareSkeletonSuccess.bind(this) )
}


// 
// when an database cannot be created due to 'file_exists' error
// it's just fine. In this case we return a resolved promise.
// 
SharesWorker.prototype.handleCreateDatabaseError = function(error) {
  if (error.error === 'file_exists') {
    return this.when.resolve()
  } else {
    return this.when.reject(error)
  }
}


// 
// 
// 
SharesWorker.prototype.handleCreateShareSkeletonSuccess = function() {
  return this.when.all([
    this.createDesignDocsInShareSkeleton(),
    this.createShareSkeletonSecurity()
  ])

}


// 
// 
// 
SharesWorker.prototype.createDesignDocsInShareSkeleton = function() {
  this.log('creatinging design docs in skeleton/share …')

  var save = this.promisify( this.couch.database('skeleton/share'), 'save')

  return this.when.all([
    save( shareFiltersDesignDoc._id, shareFiltersDesignDoc ),
    save( shareAccessDesignDoc ._id, shareAccessDesignDoc  )
  ])
}


// 
// 
// 
SharesWorker.prototype.createShareSkeletonSecurity = function() {
  
  var query = this.promisify(this.couch.database("skeleton/share"), 'query')

  return query( shareSkeletonSecurityOptions )
  .otherwise( this.handleCreateSharesDatabaseSecurityError );
}


// 
// 
// 
SharesWorker.prototype.createSharesDatabase = function() {
  var create = this.promisify( this.couch.database('shares'), 'create' );

  this.log('creating shares database …')
  return create()
  .otherwise( this.handleCreateDatabaseError.bind(this) )
  .then( this.handleCreateSharesDatabaseSuccess.bind(this) )
}


// 
// 
// 
SharesWorker.prototype.handleCreateSharesDatabaseSuccess = function() {
  return this.createSharesDatabaseSecurity()
}


// 
// 
// 
SharesWorker.prototype.createSharesDatabaseSecurity = function() {

  var query = this.promisify(this.couch.database("shares"), 'query')

  return query( sharesDatabaseSecurityOptions )
  .otherwise( this.handleCreateSharesDatabaseSecurityError );
};


// 
// 
// 
SharesWorker.prototype.handleCreateSharesDatabaseSecurityError = function(error) {
  this.handleError(error, "could not create/update _security in shares")
  return this.when.reject( error )
}


//    
//    
//    
SharesWorker.prototype.createDesignDocsInUsers = function() {
  this.log('creatinging design docs in _users database …')

  var save = this.promisify( this.couch.database('_users'), 'save');
  return save( usersDesignDoc._id, usersDesignDoc );
}


//    
//    
//    
SharesWorker.prototype.createDesignDocsInReplicator = function() {
  this.log('creatinging design docs in _replicator database …')

  var save = this.promisify( this.couch.database('_replicator'), 'save')
  return save( replicatorDesignDoc._id, replicatorDesignDoc )
}

module.exports = SharesWorker;