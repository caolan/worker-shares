var util         = require('util');
var EventEmitter = require('events').EventEmitter;
var helpers      = require('./helpers.js')

var UserSharesDatabase = require('./user_shares_database.js');

/**
 *  UserDatabase
 *
 *  wraps user's databases (user/<hash>) 
 *  and reacts on the respective changes
 *
 */
var UserDatabase = function(databaseName, usersDatabase) {

  this.name               = databaseName;
  this.ownerHash          = databaseName.match(/^([^\/]+)\/([^\/]+)/).pop();

  this.worker             = usersDatabase.worker;
  this.couch              = usersDatabase.worker.couch;
  this.database           = usersDatabase.worker.couch.database(this.name);

  // map of users shares
  this.shares = {}
  
  // give it a 1 sec timeout before creating 
  // the user/<hash>/shares database, otherwise 
  // we get very strange errors like
  // "users/abc/shares cannot be created, it alread exists" 
  // although it clearly does not
  this.initUserSharesDatabase()
  this.sharesDatabase.on( 'ready', this.listenUp.bind(this) )
  this.log('listening on %s …', databaseName)
};
util.inherits(UserDatabase, EventEmitter);


// 
// initializes the shares database for the user.
// 
UserDatabase.prototype.initUserSharesDatabase = function() {
  this.sharesDatabase = new UserSharesDatabase(this.name + '/shares', this);
}


// 
// 
// 
UserDatabase.prototype.listenUp = function() {
  this.database.changes({include_docs:true})
  .on("change", this.handleChange.bind(this))
  .on("error",  this.handleChangeError.bind(this));

  this.on('object:unshared', this.handleObjectUnshare.bind(this) )

  this.worker.on('account:removed', this.handleAccountRemoved.bind(this))
  this.sharesDatabase.on('change', this.handleChangeFromSharesDatabase.bind(this))
}


// 
// handler for changes in the userDb
// The two kind of objects are
// 
// 1. $share objects (these reperesant actual shares)
// 2. shared objects (these belong to one or multiple shares)
// 
UserDatabase.prototype.handleChange = function(change) {
  var doc = change.doc;

  this.log('_changes update: /%s/%s?rev=%s', this.name, change.id, change.doc._rev);


  if ( this.docIsShareObject(doc) ) {
    this.worker.emit('share:change', doc, this.name)
    return;
  }

  // ignore doc updates that have not been updated by me, 
  // as these updates come from my shares database.
  // Not ignoring these would lead to recursion.
  if ( this.docIsShared(doc) && this.docChangedByMe(doc)) {
    this.handleSharedObjectChange(doc)
  }
}


// 
// handle updates to shared objects.
// 
UserDatabase.prototype.handleSharedObjectChange = function(doc) {
  var shareId, filter;

  this.log('handleSharedObjectChange')

  for(shareId in doc.$shares) {

    if ( doc.$shares[shareId] === false ) {
      this.emit('object:unshared', shareId, doc)
    } else {
      this.emit('object:changed', shareId, doc)
    }

  }
}


//
// handle errors occuring when listening to userDb's changes feed.
// A special event we look for is when a database has been dropped
// 
UserDatabase.prototype.handleChangeError = function(error) {
  if (error && error.message.indexOf("Database deleted after change") !== -1) {
    this.log("%s/_changes feed stopped after %s has been dropped", this.name);
    
    return;
  }
  
  this.log("error in %s/_changes: %j", this.name, error);
}


// 
// to unshare an already shared object, the respective entry in
// the object's `$shares` hash gets set to false in the frontend
// and then synced to the user's database. Here the entry gets
// then removed and the doc updated again. That gets synced back
// again to the frontend. The app can listen to that change
// and let the user know that the object has been unshared.
// 
UserDatabase.prototype.handleObjectUnshare = function(shareId, object) {

  // remove entry from shares hash
  delete object.$shares[shareId];

  // if it's empty, remove entire hash
  if ( Object.keys(object.$shares).length === 0)
    delete object.$shares;

  // update in user's db
  this.database.save(object._id, object._rev, object); // TODO: handle error
};


//
// listen to worker's global `account:removed` account. If it's
// this database's account, retrigger the event.
// 
UserDatabase.prototype.handleAccountRemoved = function(dbName) {
  if (dbName === this.name) {
    this.emit('account:removed')
  }
};


// 
// 
// 
UserDatabase.prototype.handleChangeFromSharesDatabase = function(change) {
  var shareDoc, shareId, doc, access;
  var loadObject = this.worker.promisify(this.database, 'get')

  sharedObject = change.doc
  shareId   = sharedObject._id.match(/^share\/([^\/]+)/)[0] // "share/<id>/type/<id>" => "share/<id>"
  objectId  = sharedObject._id.substr(shareId.length + 1)   // "share/<id>/type/<id>" => "type/<id>"

  loadObject(objectId).then(
    this.handleLoadObjectSuccess(sharedObject, shareId, objectId).bind(this),
    this.handleLoadObjectError(sharedObject, shareId, objectId).bind(this)
  );
}


// 
// 
// 
UserDatabase.prototype.handleLoadObjectSuccess = function( sharedObject, shareId, objectId ) {
  
  return function(userObject) {
    this.log(
      "(new change from share/%s) loaded from %s/%s: %j", 
      shareId, this.name, objectId, userObject)

    this.emit("object:merge", sharedObject, userObject)

    // if shared object has been deleted and the object exists
    // in the user database, still connected to the share,
    // then remove the entry from $shares
    if (sharedObject._deleted && userObject.$shares  && userObject.$shares[shareId]) {
      delete userObject.$shares[shareId]
      if ( Object.keys(userObject.$shares).length === 0)
        delete userObject.$shares;

    } else {

      // create / update / remove object in / from shares database
      if (! userObject.$shares) userObject.$shares = {}
      if (! userObject.$shares[shareId]) userObject.$shares[shareId] = true

      userObject = helpers.mergeProperties(userObject, sharedObject, userObject.$shares[shareId])
    }
    
    this.updateObject( userObject )
  }
};


// 
// 
// 
UserDatabase.prototype.handleLoadObjectError = function( sharedObject, shareId, objectId ) {
  
  return function(error) {
    if (error.name === 'not_found') {

      // if shared doc was deleted, we can stop here
      if (sharedObject._deleted) {
        return
      }

      // let's create it.
      sharedObject._id = objectId
      sharedObject.$shares = {}
      sharedObject.$shares[shareId] = true

      this.updateObject( sharedObject )
    }
    return
  }
};


// 
// 
// 
UserDatabase.prototype.updateObject = function( userObject ) {
  options = {
    method : 'PUT', 
    path   : encodeURIComponent(userObject._id) + "?new_edits=false", 
    body   : userObject
  }
  this.couch.database(this.userDatabaseName).query(options, function(error) {
    if (error) {
      this.worker.handleError(error, "Could not update %s/%s ", this.name, userObject._id)
      return;
    } 

    this.log("updated %s/%s ", this.name, userObject._id)
  }.bind(this));
}


// 
// helpers
// 
UserDatabase.prototype.docIsShareObject = function(doc) {
  return doc.type === "$share";
}
UserDatabase.prototype.docIsShared = function(doc) {
  return !! doc.$shares;
}
UserDatabase.prototype.docChangedByMe = function(doc) {
  return doc.updatedBy !== this.ownerHash
}


// 
// 
// 
UserDatabase.prototype.log = function(message) {
  message = "[" + this.name + "]\t" + message
  this.worker.log.apply( this.worker, arguments)
}

module.exports = UserDatabase;