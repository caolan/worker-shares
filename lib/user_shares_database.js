var util         = require('util');
var EventEmitter = require('events').EventEmitter;
var helpers      = require('./helpers.js')

/**
 *  UserSharesDatabase
 *
 *  handles changes in user's shares database
 *
 */
var UserSharesDatabase = function(databaseName, userDatabase)
{
  this.name             = databaseName;
  this.userDatabaseName = databaseName.replace(/\/shares$/, '');
  
  this.userDatabase = userDatabase;
  this.worker       = userDatabase.worker;
  this.couch        = userDatabase.couch;
  this.database     = this.couch.database(databaseName)
  this.ownerHash    = userDatabase.ownerHash;

  // make sure that the User's shares database exists
  this.createDatabase()
  .then( this.listenUp.bind(this) )
  .otherwise( this.worker.handleError.bind(this) );
};
util.inherits(UserSharesDatabase, EventEmitter);


// 
// Database setup 
// ----------------
// 

// 
// 
// 
UserSharesDatabase.prototype.createDatabase = function() {
  var create = this.worker.promisify( this.database, 'create' )

  this.log('Creating database %s …', this.name)
  return create()
  .otherwise( this.handleCreateDatabaseError.bind(this) )
  .then( this.handleCreateDatabaseSuccess.bind(this) )
}


// 
// when an database cannot be created due to 'file_exists' error
// it's just fine. In this case we return a resolved promise.
// 
UserSharesDatabase.prototype.handleCreateDatabaseError = function(error) {
  if (error.error === 'file_exists') {
    return this.worker.when.resolve()
  } else {
    return this.worker.when.reject(error)
  }
}


// 
// when an database cannot be created due to 'file_exists' error
// it's just fine. In this case we return a resolved promise.
// 
UserSharesDatabase.prototype.handleCreateDatabaseSuccess = function() {
  this.emit('ready');
  return this.setSecurity();
}


// 
// 
// 
UserSharesDatabase.prototype.setSecurity = function() {
  var query = this.worker.promisify( this.database, 'query' )

  var options = {
    path   : '_security',
    method : 'PUT',
    json   : {
      members: {
        roles: ['_admin']
      }
    }
  };

  return query(options)
}




// 
// Event handling 
// -----------------------
// 

// 
// 
// 
UserSharesDatabase.prototype.listenUp = function() {
  this.log('%s is listening …', this.name)

  this.database.changes( {include_docs:true} )
  .on("change", this.handleChange.bind(this))
  .on("error",  this.handleChangeError.bind(this));

  this.userDatabase.on('account:removed', this.handleAccountRemoved.bind(this))

  this.userDatabase.on('object:changed', this.handleObjectUpdate.bind(this))
  this.userDatabase.on('object:unshared', this.handleObjectUnshare.bind(this))

  // object:merge gets triggered in UserDatabase
  // before an update coming from remote will be 
  // merged into the respective object in
  // users database
  this.userDatabase.on('object:merge', this.updateObjectForOtherShares.bind(this))
}



// 
// 
// 
UserSharesDatabase.prototype.handleChange = function(change) {

  // prevent recursion case I
  // 
  // when an object is shared more than once,
  // the actual object exists multiple times
  // in the user/<hash>/shares database.
  // If one was changed, the others need 
  // to be updated. That is taken care of
  // by the UserDatabaseWorker. The new 
  // revision ids get a special ending: "#auto".
  // These revisions need to be ignored by this
  // change handler, otherwise it would end 
  // up in recursion.
  // 
  if ( /#auto$/.test(change.doc._rev)) {
    return
  }

  // prevent recursion case II
  // 
  // changes, that have been made by the user this
  // shares database belongs to, must be ignored.
  // If we'd copy these over to the users database
  // again, it would end up in recursion.
  if ( change.doc.updatedBy === this.ownerHash) {
    return
  }

  // that should not happen …
  if ( change.id.indexOf('share\/') !== 0 ) {
    this.worker.handleError(
      {error: 'invalid_change', change: change}, 
      "invalid change in %s/_changes. doc._id must begin with 'share/<shareId>', but is '%s'.", this.name, change.id
    )
    return
  }
       
  this.worker.log("%s/_changes: new update from share/%s: %j", this.name, shareId, change)
  this.emit("change", change)
}


// 
// 
// 
UserSharesDatabase.prototype.handleChangeError = function(error) {
  this.log("error in %s/_changes", this.name, error);
}


// 
// 
// 
UserSharesDatabase.prototype.handleAccountRemoved = function() {
  this.database.destroy();
};


// 
// prepares a new revision of a shared doc
// 
// 1. generates new rev id
// 2. prefixes _id with "share/<shareId>"
//    "car/123" => "share/<shareId>/car/123"
// 3. generates new _rev and adds past and
//    current _rev IDs to _revisions property,
//    as we use `new_edits=false` flag
// 
UserSharesDatabase.prototype.prepareSharedObjectRevision = function(shareId, originalDoc) {
  var sharedObject, currentRevNr, currentRevId, newRevisionId, revisions;

  newRevisionId = helpers.generateNewRevisionId();

  // handle revision history
  if (originalDoc._rev) {
    currentRevNr = parseInt(originalDoc._rev, 10) + 1
    currentRevId = originalDoc._rev.split(/-/).pop()
    ids = [newRevisionId, currentRevId]
  } else {
    currentRevNr = 1
    ids = [newRevisionId]
  }

  // prepare our sharedObject
  sharedObject = {
    _id        : "share/" + shareId + "/" + originalDoc._id,
    _rev       : '' + currentRevNr + '-' + newRevisionId,
    _revisions : { start : currentRevNr, ids : [ids] }
  }

  return sharedObject;
}


// 
// when a shared object gets updated,
// we check it's sharing filter. If
// it's true, we copy over the entire
// object. if it's an array of attributes,
// we copy only the listed attributes.
// 
UserSharesDatabase.prototype.handleObjectUpdate = function( shareId, originalObject) {
  var filter = originalObject.$shares[shareId];
  var sharedObject = this.prepareSharedObjectRevision(shareId, originalObject);

  originalObject = helpers.mergeProperties(originalObject, sharedObject, filter)

  // in any case, do not copy the `$shares` property
  delete sharedObject.$shares

  this.updateSharedObject( sharedObject )
}


// 
// 
// 
UserSharesDatabase.prototype.updateSharedObject = function(sharedObject) {
  var updateObject = this.worker.promisify( this.database, 'query' )
  this.log('updating shared object: %s/%s', this.name, sharedObject._id)

  options = {
    method : 'PUT', 
    path   : encodeURIComponent(sharedObject._id) + "?new_edits=false", 
    body   : sharedObject
  }

  updateObject(options)
  .otherwise(
    this.worker.handleErrorWithMessage("ERROR: Couldn't PUT %s/%s: %j", this.name, sharedObject._id, error)
  );
}


// 
// when an object that has been unshared, 
// we need to remove it from the user's
// shares database, from where the delete
// gets replicated to the respective
// share databse.
// 
UserSharesDatabase.prototype.handleObjectUnshare = function( shareId, object) {
  var sharedObject = this.prepareSharedObjectRevision(shareId, object);
  sharedObject._deleted = true
  this.updateSharedObject( sharedObject )
}


// 
// If an update comes from somebody else and the object in question does
// exist in my userDB, check if it's also shared at other places. If yes,
// update the object for these shares as well.
// Make sure to only update the fields that are shared if an array of
// properties is set.
// 
UserSharesDatabase.prototype.updateObjectForOtherShares = function(userObject, sharedObject) {
  var shareId, access, objectId;
  var currentShareId = sharedObject._id.match(/^share\/([^\/]+)/)[0];

  if (! userObject.$shares) return

  for (shareId in userObject.$shares) {
    if (shareId === currentShareId) continue

    objectId = "share/" + shareId + "/" + userObject._id
    this.merge(objectId, sharedObject, userObject.$shares[shareId])
  }
}


// 
// 
// 
UserSharesDatabase.prototype.merge = function(objectId, sharedDoc, access) {
  var attributes;
  var get = this.worker.promisify( this.database, "get" )

  this.database.get(objectId)
  .then( this.mergeAndUpdateObject(objectId, sharedDoc, access).bind(this) )
  .otherwise( this.handleMergeError(objectId, sharedDoc).bind(this) );
}


// 
// 
// 
UserSharesDatabase.prototype.mergeAndUpdateObject = function(objectId, sharedDoc, access) {
  var updateObject = this.worker.promisify( this.database, 'query' )

  return function(otherSharedDoc) {

    otherSharedDoc = helpers.mergeProperties(otherSharedDoc, sharedDoc, access)

    // automated updates to docs in user/shares dbs that 
    // have been made by the SharesWorker get a special 
    // _rev ending with "#auto" to prevent recursion.
    otherSharedDoc._rev += "#auto"
    options = {
      method : 'PUT', 
      path   : encodeURIComponent(objectId) + "?new_edits=false", 
      body   : otherSharedDoc
    }

    return updateObject(options); 
  }.bind(this)
}


// 
// 
// 
UserSharesDatabase.prototype.handleMergeError = function(objectId, sharedDoc) {
  return function(error) {
    this.worker.handleError(error, "could merge %s into %s/%s", sharedDoc._id, this.name, objectId)
  }.bind(this)
}


// 
// 
// 
UserSharesDatabase.prototype.log = function() {
  this.worker.log.apply( this.worker, arguments)
}

module.exports = UserSharesDatabase;