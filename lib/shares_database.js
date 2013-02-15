var util         = require('util');
var EventEmitter = require('events').EventEmitter;

var ShareDatabase = require('./share_database.js');
var Replication   = require('./replication.js');

/**
 *  SharesDatabase
 *
 *  maintains a special database "shares" which contains
 *  objects representing the share databases and their
 *  access settings as well as subscriptions to and from
 *  these shares to user accounts.
 *
 *  On the on side it keeps the objects in "shares" up
 *  to date, on the other side it listens to its changes
 *  and reacts on it. For example, instead of creating 
 *  a share database directly, it firsts creates the
 *  respictive object in "shares". From the _changes 
 *  feed it sees the newly created share and then creates
 *  the actual share database. That allows us to control
 *  shares from the outside by making changes in "shares"
 *  database
 *
 */
var SharesDatabase = function(worker) {
  this.name     = 'shares';
  this.worker   = worker;
  this.couch    = worker.couch;
  this.database = worker.couch.database('shares')

  this.bootstrap()
  .then( this.listenUp.bind(this) )
  .otherwise( this.worker.handleErrorWithMessage("bootstrap failed.") )
};
util.inherits(SharesDatabase, EventEmitter);


// 
// load all existing shares and keep them
// as reference in memory. Once bootstrap
// is ready, start to listen to changes.
// 
SharesDatabase.prototype.bootstrap = function() {
  this.log("bootstrapping ...")

  // stores for share & subscription objects in memory
  this.shares = {};
  this.subscriptions = {};

  // references for actual share databases
  // and docs in _replicator databases
  this.shareDatabases = {};
  this.replications = {};

  // load all existing objects with the _changes API
  // so that we get th last seq number with the same 
  // requset.
  var options = {
    method : 'GET', 
    path   : "_changes?include_docs=true"
  }
  var query = this.worker.promisify( this.database, 'query')

  return query(options).then(
    this.handleBootstrapSucces.bind(this),
    this.handleBootstrapError.bind(this)
  )
}


// 
// 
// 
SharesDatabase.prototype.handleBootstrapSucces = function (response) {
  var lastSeq = response.last_seq,
      object,
      id;

  if (! response.results) {
    return this.worker.when.resolve(lastSeq)
  }

  for (var i = 0; i < response.results.length; i++) {
    object = response.results[i].doc

    // handle shares
    if ( this.isShareObject(object) ) {
      id = this.getShareId( object )
      this.shares[ id ]         = object
      this.shareDatabases[ id ] = new ShareDatabase(object)
    }

    // handle subscriptions
    if ( this.isSubscriptionObject(object) ) {
      id = this.getSubscriptionId( doc.id )
      this.subscriptions[ id ] = object
      this.replications[ id ]  = new Replication(object)
    }
  }

  return this.worker.when.resolve(lastSeq)
}


// 
// 
// 
SharesDatabase.prototype.handleBootstrapError = function (error) {
  this.handleError(error, "could not bootstrap shares")
}


// 
// 
// 
SharesDatabase.prototype.listenUp = function( last_seq ) {
  this.database.changes({since: last_seq, include_docs: true})
  .on("change", this.handleChange.bind(this))
  .on("error",  this.handleChangeError.bind(this));

  this.worker.on('account:removed', this.handleAccountRemoved.bind(this))
  this.worker.on('share:change',    this.handleGlobalShareObjectChange.bind(this))

  // new share / subscription coming in from user database
  this.on('share:add',           this.handleShareAdd.bind(this) )
  this.on('share:update',        this.handleShareUpdate.bind(this) )
  this.on('share:remove',        this.handleShareRemove.bind(this) )
  this.on('subscription:add',    this.handleSubscriptionAdd.bind(this) )
  this.on('subscription:update', this.handleSubscriptionUpdate.bind(this) )
  this.on('subscription:remove', this.handleSubscriptionRemove.bind(this) )

  this.emit('ready')
}


// 
// 
// 
SharesDatabase.prototype.handleChange = function( change ) {

  if ( this.isShareObject( change.doc) ) {
    this.handleShareObjectChange( change )
    return
  }

  if ( this.isSubscriptionObject( change.doc) ) {
    this.handleSubscriptionObjectChange( change )
    return
  }
}


// 
// 
// 
SharesDatabase.prototype.handleShareObjectChange = function( change ) 
{
  var eventName;

  if ( change.deleted ) {
    this.handleShareObjectRemove( change.doc )
    eventName = "remove"
  }

  if ( ! this.shareDatabaseExists( change.doc )) {
    this.handleShareObjectAdd( change.doc )
  } else {
    this.handleShareObjectUpdate( change.doc )
  }
}


// 
// 
// 
SharesDatabase.prototype.handleSubscriptionObjectChange = function( change )
{
  var eventName;

  if ( change.deleted ) {
    this.handleSubscriptionObjectRemove( change.doc )
  }

  if ( ! this.replicationExists( change.doc )) {
    this.handleSubscriptionObjectAdd( change.doc )
  } else {
    this.handleSubscriptionObjectUpdate( change.doc )
  }
}


// 
// 
// 
SharesDatabase.prototype.handleChangeError = function( change ) {
  this.handleError( error, 'error in shares/_changes feed' );
}


// 
// handling changes to a $share objects
// 
SharesDatabase.prototype.handleGlobalShareObjectChange = function( shareObject, originDatabaseName ) {

  var shareId = this.getShareId(shareObject); // $share/123 => 123
  var originOwnerHash = originDatabaseName.split(/\//).pop()

  if (! this.shareExists( shareObject ) ) {
    this.emit('share:add', shareObject, originDatabaseName)
    return
  }

  // prevent others from hijacking shares
  if ( this.shareCreatedBy(shareObject, originOwnerHash) && ! this.shareBelongsTo(shareObject, originOwnerHash) ) {

    this.worker.emit( 'share:error:' + originDatabaseName, "This share belongs to another user")
    return
  }

  if ( this.shareBelongsTo(shareObject, originOwnerHash)) {

    // when a share gets deleted, remove its database, replications and objects
    if (shareObject._deleted && this.shares[shareId]) {
      this.emit('share:remove', shareObject, originDatabaseName)
    } else {
      this.emit('share:update', shareObject, originDatabaseName)
    }

    return
  } 


  // passed shareObject does not belong to origin
  // => create a subscription
  this.log("Subscription update for share/%s by %s", shareId, originOwnerHash)
  
  // when a share gets removed that does not belong to its origin,
  // it means the user unsubscribed from somebody elses share
  if (shareObject._deleted) {
    this.emit('subscription:remove', shareObject, originDatabaseName)
    return
  }

  // 
  if (this.subscriptionExists(shareObject, originDatabaseName)) {
    this.emit('subscription:update', shareObject, originDatabaseName)
  } else {
    this.emit('subscription:add', shareObject, originDatabaseName)
  }
}


// 
// 
// 
SharesDatabase.prototype.handleAccountRemoved = function( databaseName ) {
  var ownerHash = originDatabaseName.split(/\//).pop()
  
  this.findAllObjectsBelongingTo( ownerHash )
  .then( this.removeObjects.bind(this) )
  .otherwise( this.handleAccountRemovedError.bind(this) )

  // this.log('dropping all databases for %s', this.userDatabaseName)

  // this.couch.database(this.userDatabaseName).all({
  //   startkey     : "$share/",
  //   endkey       : "$share0",
  //   include_docs : true
  // }, function(error, response) {
  //   var share_database;

  //   if (error) {
  //     this.log("Couldn't drop $share databases:");
  //     this.log("Error loading all $share docs from %s. %j", this.userDatabaseName, error);
  //     return;
  //   }

  //   this.log('$share docs loaded: %s', response.rows.length)
  //   for (var i = 0; i < response.rows.length; i++) {
  //     row = response.rows[i];
  //     if (row.doc.type === '$share' && row.doc.createdBy === this.ownerHash) {
  //       this.dropShare(row.id.substr(1)); // $share/123 => share/123
  //     } else {
  //       this.log('not dropping share %s', row.id.substr(1))
  //       this.log('row.doc.createdBy === %s (%s)', row.doc.createdBy, this.ownerHash)
  //     }
  //   }
  // }.bind(this));
}


// 
// 
// 
SharesDatabase.prototype.findAllObjectsBelongingTo = function( ownerHash ) {
  var share, subscription, objects = [];

  // find shares
  for( var shareId in this.shares ) {
    share = this.shares[shareId];
    if ( this.shareBelongsTo(share, ownerHash) ) {
      objects.push( share );
    }
  }

  // find subscriptions
  for( var subscriptionId in this.subscriptions ) {
    subscription = this.subscriptions[shareId];
    if ( this.subscriptionBelongsTo(subscription, ownerHash) ) {
      objects.push( subscription );
    }
  }

  return this.worker.when.resolve( objects )
}


// 
// 
// 
SharesDatabase.prototype.removeObjects = function( objects ) {
  var save = this.worker.promisify( this.database.save )

  for (var i = 0; i < objects.length; i++) {
    objects[i]._deleted = true;
  }

  return save(objects)
}


// 
// 
// 
SharesDatabase.prototype.handleAccountRemovedError = function( error ) {
  this.handleError(error, "could not cleanup objects after account:removed")
}


// 
// 
// 
SharesDatabase.prototype.handleShareAdd = function(shareObject, originDatabaseName) {
  var originOwnerHash = originDatabaseName.split(/\//).pop()

  // … unless this share is not mine. That should not happen, really
  if (shareObject.createdBy !== originOwnerHash) {
    this.handleError({ error: 'invalid_share'}, "Cannot create " + shareId + ", as it does not belong to user " + originOwnerHash)
    this.worker.emit( 'share:error:' + originDatabaseName, "Share cannot be created, it belongs to another user")
    return
  }

  this.addShareObject(shareObject);
};


// 
// 
// 
SharesDatabase.prototype.handleShareUpdate = function(shareObject, originDatabaseName) {
  var shareId = this.getShareId(shareObject)
  this.shares[shareId].update( shareObject )
};


// 
// 
// 
SharesDatabase.prototype.handleShareRemove = function(shareObject, originDatabaseName) {
  var updateObject = this.worker.promisify( this.database, 'save')

  shareObject._deleted = true
  updateObject( shareObject )
  .otherWise( this.worker.handleErrorWithMessage("could remove shares/%s", shareObject._id).bind(this) )
};


// 
// 
// 
SharesDatabase.prototype.addShareObject = function(shareObject) {
  var save = this.worker.promisify( this.database, 'save' )
  var shareId = this.getShareId(shareObject);
  this.shares[shareId] = shareObject;

  save(shareObject)
  .otherwise( this.worker.handleErrorWithMessage('could not add shares/%s', shareObject._id) )
};


// 
// 
// 
SharesDatabase.prototype.handleSubscriptionAdd = function(shareObject, originDatabaseName) {
  var save = this.worker.promisify( this.database, 'save' )

  var shareDatabaseName = shareObject._id.substr(1);
  var ownerHash = originDatabaseName.split(/\//).pop()
  var subscriptionObject = {}

  // 1. If share belongs to originDatabase
  //    a) add a push replication from originDatabase to the share
  //    b) if share has write access, add pull replication
  // 2. If share does not belong to originDatabase
  //    a) add pull replication
  //    b) origin has write access, add push replication
  // 
  // … but for now, fuck that, shares are read only atm.

  if ( this.shareBelongsTo(shareObject, originDatabase) ) {
    subscriptionObject.source = originDatabaseName
    subscriptionObject.target = shareDatabaseName
  } else {
    subscriptionObject.source = originDatabaseName
    subscriptionObject.target = shareDatabaseName
  }

  subscriptionObject._id = this.makeSubscriptionId(subscriptionObject.source, subscriptionObject.target)
  subscriptionObject.createdAt = new Date()
  subscriptionObject.updatedAt = new Date()
  subscriptionObject.createdBy = ownerHash

  this.subscriptions[subscriptionObject._id] = subscriptionObject;
  save(subscriptionObject)
};


// 
// 
// 
SharesDatabase.prototype.handleSubscriptionUpdate = function(shareObject, originDatabaseName) {
  // nada
};


// 
// 
// 
SharesDatabase.prototype.handleSubscriptionRemove = function(shareObject, originDatabaseName) {
  var shareDatabaseName = this.getShareDatabaseName(shareObject)
  var subscriptionId = this.makeSubscriptionId(shareDatabaseName, originDatabaseName)
  var subscriptionObject = this.subscriptions[subscriptionId];

  if (! subscriptionObject) {
    this.handleError({ error: 'invalid_subscription'}, "Tried to remove subscription "+subscriptionId+", but it does not exist")
    return
  }

  this.removeSubscriptionObject(subscriptionObject)
};


// 
// 
// 
SharesDatabase.prototype.removeSubscriptionObject = function(subscriptionObject) {
  throw ('removeSubscriptionObject not yet implemented.');
};





// 
// 
// 
SharesDatabase.prototype.getShareId = function(shareObject) {
  return shareObject._id.substr(7); // "$share/123" => "123"
};


// 
// 
// 
SharesDatabase.prototype.getSubscriptionId = function(shareObject) {
  return shareObject._id.substr(14);  // "$subscription/source => target" => "source => target"
};


// 
// 
// 
SharesDatabase.prototype.isShareObject = function(object) {
  return /^\$share\//.test(object._id);
};


// 
// 
// 
SharesDatabase.prototype.isSubscriptionObject = function(object) {
  return /^\$subscription\//.test(object._id);
};


// 
// 
// 
SharesDatabase.prototype.getShareDatabaseName = function(shareObject) {
  return shareObject._id.substr(1);
};


// 
// 
// 
SharesDatabase.prototype.makeSubscriptionId = function(databaseName1, databaseName2) {
  return [databaseName1, databaseName2 + "/shares"].join(' => ');
};


// 
// 
// 
SharesDatabase.prototype.shareExists = function(shareObject) {
  var shareId = this.getShareId(shareObject);
  return !! this.shares[shareId];
};


// 
// 
// 
SharesDatabase.prototype.subscriptionExists = function(shareObject, originDatabaseName) {
  var shareDatabaseName = this.getShareDatabaseName(shareObject)
  var subscriptionId = this.makeSubscriptionId(shareDatabaseName, originDatabaseName)
  return !! this.subscriptions[subscriptionId];
};


// 
// 
// 
SharesDatabase.prototype.shareCreatedBy = function(shareObject, ownerHash) {
  return shareObject.createdBy === originOwnerHash
};


// 
// 
// 
SharesDatabase.prototype.shareBelongsTo = function(shareObject, ownerHash) {
  var shareId = this.getShareId(shareObject);
  return this.shares[shareId].createdBy === originOwnerHash
};


// 
// 
// 
SharesDatabase.prototype.subscriptionBelongsTo = function(subscriptionObject, ownerHash) {
  var userDatabaseName = "user/"+ownerHash+"/shares";
  return subscriptionObject.source === userDatabaseName || subscriptionObject.target === userDatabaseName;
};





// 
// 
// 
SharesDatabase.prototype.shareDatabaseExists = function( shareObject ) {
  var shareId = this.getShareId(shareObject);
  return !! this.shareDatabases[ shareId ]
}


// 
// 
// 
SharesDatabase.prototype.replicationExists = function( replicationObject ) {
  var replicationId = this.getSubscriptionId( replicationObject );
  return !! this.shareDatabases[ replicationId ]
}


// 
// 
// 
SharesDatabase.prototype.handleShareObjectAdd = function( shareObject ) {
  var shareId = this.getShareId(shareObject);
  this.shareDatabases[ shareId ] = new ShareDatabase(shareObject, this)
}


// 
// 
// 
SharesDatabase.prototype.handleShareObjectUpdate = function( shareObject ) {
  // nothin' happens in here yet
}


// 
// 
// 
SharesDatabase.prototype.handleShareObjectRemove = function( shareObject ) {
  var shareId = this.getShareId(shareObject);
  this.shareDatabases[ shareId ].drop();
  delete this.shareDatabases[ shareId ];
}


// 
// 
// 
SharesDatabase.prototype.handleSubscriptionObjectAdd = function( replicationObject ) {
  var replicationId = this.getSubscriptionId( replicationObject );
  this.replications[ replicationId ] = new Replication(replicationObject, this)
}


// 
// 
// 
SharesDatabase.prototype.handleSubscriptionObjectUpdate = function( replicationObject ) {
  // nothin' in here yet
}


// 
// 
// 
SharesDatabase.prototype.handleSubscriptionObjectRemove = function( replicationObject ) {
  var replicationId = this.getSubscriptionId( replicationObject );
  this.replications[ replicationId ].stop();
  delete this.replications[ replicationId ];
}



// 
// 
// 
SharesDatabase.prototype.log = function() {
  this.worker.log.apply( this.worker, arguments)
}

module.exports = SharesDatabase;





// // 
// // just as `createShare`, only without creating the share db
// // or updating access settings
// //
// UserSharesDatabase.prototype.subscribeToShare = function(shareDatabaseName) {
//   this.log("subscribeToShare: " + shareDatabaseName)

//   var replication_to_share = this.name + " => " + shareDatabaseName,
//       replication_to_user = shareDatabaseName + " => " + this.name,
//       shareId = shareDatabaseName.split('/').pop();

//   this.couch.database('_replicator').update("shares/start", replication_to_share, {filter: 'filters/share' });
//   this.couch.database('_replicator').update("shares/start", replication_to_user);
// }

// // 
// // 
// // 
// UserSharesDatabase.prototype.dropShare = function(shareDatabaseName)
// {
//   this.log("dropShare: " + shareDatabaseName)

//   var replication_to_share = this.name + " => " + shareDatabaseName,
//       replication_to_user = shareDatabaseName + " => " + this.name;

//   this.log('stopping replication %s', replication_to_share)
//   this.log('stopping replication %s', replication_to_user)
//   this.couch.database('_replicator').update("shares/stop", replication_to_share);
//   this.couch.database('_replicator').update("shares/stop", replication_to_user);

//   // give it a time out so that replication docs can be dropped
//   // without being updated due to "target/source db does not exist"  errors
//   setTimeout( function() {
//     this.couch.database(shareDatabaseName).destroy();
//   }.bind(this), 3000)

//   this.database.all({
//     startkey: shareDatabaseName + "/",
//     endkey: shareDatabaseName + "0"
//   }, function(error, response) {
//     var docsToDelete = [];
//     if (error) {
//       this.log("Error loading objects belonging to %s. %j", this.name, error);
//       return;
//     }

//     // gather docs to be deleted
//     for (var sharedDoc, i = 0; i < response.rows.length; i++) {
//       sharedDoc = response.rows[i];
//       docsToDelete.push({
//         _id: sharedDoc._id,
//         _rev: sharedDoc._rev,
//         _deleted: true
//       });
//     }

//     // delete 'em all at once
//     this.database.save(docsToDelete);
//   }.bind(this)); 
// }

// // 
// // just as `createShare`, only without creating the share db
// // or updating access settings
// //
// UserSharesDatabase.prototype.unsubscribeFromShare = function(shareDatabaseName) {
//   this.log("unsubscribeFromShare: " + shareDatabaseName)

//   var replication_to_share = this.name + " => " + shareDatabaseName,
//       replication_to_user = shareDatabaseName + " => " + this.name;

//   this.couch.database('_replicator').update("shares/stop", replication_to_share);
//   this.couch.database('_replicator').update("shares/stop", replication_to_user);
// }