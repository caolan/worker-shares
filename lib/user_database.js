var util         = require('util');
var EventEmitter = require('events').EventEmitter;

/**
 *  UserDatabase
 *  listens to changes on the user's private database
 */
var UserSharesDatabase = require('./user_shares_database.js');

var UserDatabase = function(databaseName, worker) {

  this.name               = databaseName;
  this.sharesDatabaseName = databaseName + "/shares";
  this.ownerHash          = databaseName.match(/^([^\/]+)\/([^\/]+)/).pop();

  this.worker             = worker;
  this.couch              = worker.couch;
  this.database           = worker.couch.database(this.name);

  // map of users shares
  this.shares = {}
  
  // give it a 1 sec timeout, otherwise I get very strange errors like
  // "users/abc/shares cannot be created, it alread exists" although it does not.
  setTimeout( function() {
    this.initSharesWorker()
    this.listenUp()
  }.bind(this), 1000)
  
  this.log('starting for %s', databaseName)
};
util.inherits(UserDatabase, EventEmitter);


// 
// 
// 
UserDatabase.prototype.initSharesWorker = function() {
  this.sharesWorker  = new UserSharesDatabase(this.sharesDatabaseName, this);
}


// 
// 
// 
UserDatabase.prototype.listenUp = function() {
  this.feed = this.database.changes({include_docs:true})

  this.feed.on("change", this.handleChange.bind(this));
  this.feed.on("error",  this.handleChangeError.bind(this));

  this.worker.on('account:removed', this.handleAccountRemoved.bind(this))

  this.on('object:unshared', this.handleObjectUnshare.bind(this) )
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

  this.log('handleChange: %j', doc)


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
    this.log("Database %s has been dropped.", this.name);
    this.feed.off("change");
    this.feed.off("error");
    
    return;
  } 
  
  this.log("error in Worker: %j", error);
}


//
// listen to worker's global `account:removed` account. If it's
// the one of this worker, trigger the event from this worker.
// 
UserDatabase.prototype.handleAccountRemoved = function(dbName) {
  if (dbName === this.name) {
    this.emit('account:removed')
  }
};


// 
// to unshare an already shared object, the respective entry in
// the object's `$shares` hash gets set to false in the frontend
// and then synced to the user's database. Here the entry gets
// then removed and the doc updated again, what gets synced back
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
UserDatabase.prototype.log = function() {
  this.worker.log.apply( this.worker, arguments)
}

module.exports = UserDatabase;