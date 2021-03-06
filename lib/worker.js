/**
 *  SharesWorker
 *  
 */
var SharesDatabase = require('./shares_database.js');
var UsersDatabase  = require('./users_database.js');
var util           = require('util');
var HoodieWorker   = require('hoodie-worker');

// get JSONs for design docs required by the shares worker
var usersDesignDoc                     = require('../couch_files/_users/_design:users_views')
var replicatorDesignDoc                = require('../couch_files/_replicator/_design:shares')
var userShareFiltersDesignDoc          = require('../couch_files/skeleton:user/_design:share_filters')
var shareFiltersDesignDoc              = require('../couch_files/skeleton:share/_design:share_filters')
var shareAccessDesignDoc               = require('../couch_files/skeleton:share/_design:write_access')
var shareSkeletonSecurityOptions       = require('../couch_files/skeleton:share/_security')
var sharesDatabaseSecurityOptions      = require('../couch_files/shares/_security')

// Listen to changes in _users database and start 
// new share workers for confirmed sign ups
var SharesWorker = function(config, hoodie) {
  this.hoodie = hoodie;
  this.setup(config)
  .then( this.launch.bind(this) )
  .otherwise( this.handleErrorWithMessage("SharesWorker setup failed") )
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
    this.createUserSkeletonDatabase(), 
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
SharesWorker.prototype.createUserSkeletonDatabase = function() {
  var create = this.promisify( this.couch.database('skeleton/user'), 'create' );

  this.log('creating skeleton/user database …')
  return create()
  .otherwise( this.handleCreateDatabaseError('skeleton/user').bind(this) )
  .then( this.createDesignDocsInUserSkeleton.bind(this) )
}


// 
// 
// 
SharesWorker.prototype.createShareSkeletonDatabase = function() {
  var create = this.promisify( this.couch.database('skeleton/share'), 'create' );

  this.log('creating skeleton/share database …')
  return create()
  .otherwise( this.handleCreateDatabaseError('skeleton/share').bind(this) )
  .then( this.handleCreateShareSkeletonSuccess.bind(this) )
}


// 
// when an database cannot be created due to 'file_exists' error
// it's just fine. In this case we return a resolved promise.
// 
SharesWorker.prototype.handleCreateDatabaseError = function(databaseName) {
  return function(error) {
    if (error.name === 'file_exists') {
      return this.when.resolve()
    } else {
      return this.when.reject(error)
    }
  }
}


// 
// 
// 
SharesWorker.prototype.handleCreateShareSkeletonSuccess = function() {
  return this.when.all([
    this.createAccessDesignDocInShareSkeleton(),
    this.createShareDesignDocInShareSkeleton(),
    this.createShareSkeletonSecurity()
  ])
}


// 
// 
// 
SharesWorker.prototype.createShareDesignDocInShareSkeleton = function() {
  this.log('creating design docs in skeleton/share …')

  var save = this.promisify( this.couch.database('skeleton/share'), 'save')
  return save( shareFiltersDesignDoc._id, shareFiltersDesignDoc )
    .otherwise( this.handleErrorWithMessage("Could not save skeleton/share/%s", shareFiltersDesignDoc._id) )
}


// 
// 
// 
SharesWorker.prototype.createAccessDesignDocInShareSkeleton = function() {
  this.log('creating design docs in skeleton/share …')

  var save = this.promisify( this.couch.database('skeleton/share'), 'save')
  return save( shareAccessDesignDoc._id, shareAccessDesignDoc )
    .otherwise( this.handleErrorWithMessage("Could not save skeleton/share/%s", shareAccessDesignDoc._id) )
}


// 
// 
// 
SharesWorker.prototype.createShareSkeletonSecurity = function() {
  this.log('creating skeleton/share/_security …')
  
  var query = this.promisify(this.couch.database("skeleton/share"), 'query')
  var options = {
    path   : '_security',
    method : 'PUT',
    json   : shareSkeletonSecurityOptions
  };

  return query( options )
}




// 
// 
// 
SharesWorker.prototype.createDesignDocsInUserSkeleton = function() {
  this.log('creating design docs in skeleton/share …')

  var save = this.promisify( this.couch.database('skeleton/user'), 'save')
  return save( userShareFiltersDesignDoc._id, userShareFiltersDesignDoc )
    .otherwise( this.handleErrorWithMessage("Could not save skeleton/user/%s", userShareFiltersDesignDoc._id) )
}




// 
// 
// 
SharesWorker.prototype.createSharesDatabase = function() {
  var create = this.promisify( this.couch.database('shares'), 'create' );

  this.log('creating shares database …')
  return create()
  .otherwise( this.handleCreateDatabaseError('shares').bind(this) )
  .then( this.createSharesDatabaseSecurity.bind(this) )
}


// 
// 
// 
SharesWorker.prototype.createSharesDatabaseSecurity = function() {
  this.log('creating shares/_security …')

  var query = this.promisify(this.couch.database("shares"), 'query')
  var options = {
    path   : '_security',
    method : 'PUT',
    json   : sharesDatabaseSecurityOptions
  };

  return query( options );
};


//    
//    
//    
SharesWorker.prototype.createDesignDocsInUsers = function() {
  this.log('creating design docs in _users database …')

  var save = this.promisify( this.couch.database('_users'), 'save');
  return save( usersDesignDoc._id, usersDesignDoc );
}


//    
//    
//    
SharesWorker.prototype.createDesignDocsInReplicator = function() {
  this.log('creating design docs in _replicator database …')

  var save = this.promisify( this.couch.database('_replicator'), 'save')
  return save( replicatorDesignDoc._id, replicatorDesignDoc )
}

module.exports = function (config, hoodie) {
    return new SharesWorker(config, hoodie);
};
