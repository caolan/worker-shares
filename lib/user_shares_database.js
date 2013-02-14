var util         = require('util');
var EventEmitter = require('events').EventEmitter;

/**
 *  UserSharesDatabase
 *  handle share related changes in user's shares database
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

  // map of user shares
  this.shares = {}

  // make sure that the User's shares database exists
  this.createDatabase();

  this.listenUp()
};
util.inherits(UserSharesDatabase, EventEmitter);


// 
// 
// 
UserSharesDatabase.prototype.listenUp = function() {
  this.userDatabase.on('account:removed', this.handleAccountRemoved.bind(this))

  this.userDatabase.on('object:unshared', this.handleUnsharedObject.bind(this))
  this.userDatabase.on('object:changed', this.handleObjectUpdate.bind(this))
}


// 
// 
// 
UserSharesDatabase.prototype.handleAccountRemoved = function() {
  this.dropDatabase();
};


// 
// prepare update for shared doc
// 
// 1. prefix _id with "share/{shareId}"
// 2. generate new _rev and add past and current _rev IDs in _revisions,
//    as we use `new_edits=false` flag
// 
UserSharesDatabase.prototype.prepareSharedObjectUpdate = function(shareId, originalDoc) {
  var sharedDoc, currentRevNr, currentRevId, newRevisionId;

  if (originalDoc._rev) {
    currentRevNr = parseInt(originalDoc._rev, 10);
    currentRevId = originalDoc._rev.split(/-/).pop();
  } else {
    currentRevNr = 0;
  }

  newRevisionId = this.generateNewRevisionId();

  sharedDoc = {
    _id        : "share/" + shareId + "/" + originalDoc._id,
    _rev       : '' + (currentRevNr + 1) + '-' + newRevisionId,
    _revisions : { start : 1, ids : [newRevisionId]},
    createdBy : originalDoc.createdBy,
    updatedBy : this.ownerHash,
    createdAt : originalDoc.createdAt,
    updatedAt : originalDoc.updatedAt
  };

  if (originalDoc._rev) {
    sharedDoc._revisions.start += currentRevNr;
    sharedDoc._revisions.ids.push(currentRevId);
  }

  return sharedDoc;
}


// 
// 
// 
UserSharesDatabase.prototype.handleUnsharedObject = function( shareId, object) {
  var sharedObject = this.prepareSharedObjectUpdate(shareId, object);
  sharedObject._deleted = true
  this.updateSharedObject( sharedObject )
}

// 
// 
// 
UserSharesDatabase.prototype.handleObjectUpdate = function( shareId, object) {
  var filter = object.$shares[shareId];
  var sharedObject = this.prepareSharedObjectUpdate(shareId, object);

  if (filter === true) {

    // share entire object
    for (var key in object) {
      if (typeof sharedObject[key] === 'undefined' && key !== '$shares') {
        sharedObject[key] = object[key];
      }
    }

  } else {

    // when filter is an Array, share only the passed Attributes
    for (var i = 0; i < filter.length; i++) {
      attribute = filter[i];
      sharedObject[attribute] = object[attribute];
    }
  }

  this.updateSharedObject( sharedObject )
}


// 
// 
// 
UserSharesDatabase.prototype.updateSharedObject = function(object) {
  var shareId = object._id.split('/').pop()
  var sharedObject = this.prepareSharedObjectUpdate(shareId, object);

  this.log('updateSharedObject: %s', sharedObject._id)
  options = {
    method : 'PUT', 
    path   : encodeURIComponent(sharedObject._id) + "?new_edits=false", 
    body   : sharedObject
  }

  this.database.query(options, function(error) {
    if (error) {
      this.log("ERROR: Couldn't PUT %s in %s: %j", sharedObject._id, this.name, error)
      return;
    } 

    this.log("SUCCESS PUT " + sharedObject._id + " in " + this.name)
  }.bind(this));
}


// 
// 
// 
UserSharesDatabase.prototype.createDatabase = function() {
  var create = this.worker.promisify( this.database, 'create' )

  this.log('timeout done. Creating database %s ...', this.name)
  return create()
  .otherwise( this.handleCreateDatabaseError.bind(this) )
  .then( this.handleCreateDatabaseSucces.bind(this) )
}


// 
// when an database cannot be created due to 'file_exists' error
// it's just fine. In this case we return a resolved promise.
// 
UserSharesDatabase.prototype.handleCreateDatabaseSucces = function() {
  this.emit('ready');
  this.startListeningToChanges();
  this.setSecurity();
}


// 
// 
// 
UserSharesDatabase.prototype.setSecurity = function() {
  var query = this.worker.promisify( this.couch.database(databaseName), 'query' )

  var options = {
    path   : '_security',
    method : 'PUT',
    json   : {
      members: {
        roles: ['_admin']
      }
    }
  };

  return query(options).otherwise( this.handleError.bind(this) )
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
// 
// 
UserSharesDatabase.prototype.startListeningToChanges = function () {
  this.log('starting to listen for changes on %s', this.name)
  this.feed = this.database.changes({include_docs:true});
  this.feed.on("change", this.handleChange.bind(this));
  this.feed.on("error",  this.handleChangeError.bind(this));
}


// 
// 
// 
UserSharesDatabase.prototype.handleChangeError = function(error) {
  this.log("ERROR: %j", error);
}


// 
// 
// 
UserSharesDatabase.prototype.handleChange = function(change) {
  var shareId, doc, access;

  // updates to docs in user/shares dbs that have been made
  // by the SharesWorker get a special _rev ending with
  // "-auto". These have to be ignored to avoid recursion.
  if ( /-auto$/.test(change.doc._rev)) {
    return
  }

  // to only react on changes from others, as changes
  // by myself will do not need to get replicated to
  // my own usreDB. It would end up in a recursion.
  if ( change.doc.updatedBy === this.ownerHash ||
       change.id.indexOf('share\/') !== 0) {
    return
  }

  sharedDoc = change.doc
  shareId  = sharedDoc._id.match(/^share\/([^\/]+)/)[0]
  docId    = sharedDoc._id.substr(shareId.length + 1)

  this.log("BOOM, an update from %s:", shareId)
  this.log("%j", change)
  
  this.couch.database(this.userDatabaseName).get(docId, function (error, userDoc) {
    if (error) {

      if (error.error === 'not_found') {

        // if shared doc was deleted, we can stop here
        if (sharedDoc._deleted) {
          return
        }

        // let's create it.
        sharedDoc._id = docId
        sharedDoc.$shares = {}
        sharedDoc.$shares[shareId] = true

        // create / update / remove object in / from shares database
        options = {
          method : 'PUT', 
          path   : encodeURIComponent(docId) + "?new_edits=false", 
          body   : sharedDoc
        }
        this.couch.database(this.userDatabaseName).query(options, function(error) {
          if (error) {
            this.log("ERROR: Couldn't PUT %s in %s: %j", sharedDoc._id, this.userDatabaseName, error)
            return;
          } 

          this.log("SUCCESS PUT " + sharedDoc._id + " in " + this.userDatabaseName)
        }.bind(this));

      } else {
        this.log("ERROR getting %s from %s:", docId, this.userDatabaseName)
        this.log("%j", error)
      }
      return
    }

    this.log("%s loaded from %s:", docId, this.userDatabaseName)
    this.log(userDoc);

    if (sharedDoc._deleted && userDoc.$shares  && userDoc.$shares[shareId]) {
      delete userDoc.$shares[shareId]
    } else {
      // we're good. Doc has been removed in share and our userDoc
      // is not connected to it anyway
    }

    if (userDoc.$shares) {
      // If object is also shared in other places, update them
      this.updateObjectForOtherShares(userDoc, sharedDoc, shareId)
    } else {
      userDoc.$shares = {}
    }

    // create / update / remove object in / from shares database
    if (! userDoc.$shares[shareId]) userDoc.$shares[shareId] = true
    userDoc = this.merge(userDoc, sharedDoc, userDoc.$shares[shareId])
    options = {
      method : 'PUT', 
      path   : encodeURIComponent(docId) + "?new_edits=false", 
      body   : userDoc
    }
    this.couch.database(this.userDatabaseName).query(options, function(error) {
      if (error) {
        this.log("ERROR: Couldn't PUT %s in %s: %j", userDoc._id, this.userDatabaseName, error)
        return;
      } 

      this.log("SUCCESS PUT " + userDoc._id + " in " + this.userDatabaseName)
    }.bind(this));
  }.bind(this))
}


// 
// 
// 
UserSharesDatabase.prototype.dropDatabase = function() {
  this.database.destroy();
}



// 
// just as `createShare`, only without creating the share db
// or updating access settings
//
UserSharesDatabase.prototype.subscribeToShare = function(shareDatabaseName) {
  this.log("subscribeToShare: " + shareDatabaseName)

  var replication_to_share = this.name + " => " + shareDatabaseName,
      replication_to_user = shareDatabaseName + " => " + this.name,
      shareId = shareDatabaseName.split('/').pop();

  this.couch.database('_replicator').update("shares/start", replication_to_share, {filter: 'filters/share' });
  this.couch.database('_replicator').update("shares/start", replication_to_user);
}

// 
// 
// 
UserSharesDatabase.prototype.dropShare = function(shareDatabaseName)
{
  this.log("dropShare: " + shareDatabaseName)

  var replication_to_share = this.name + " => " + shareDatabaseName,
      replication_to_user = shareDatabaseName + " => " + this.name;

  this.log('stopping replication %s', replication_to_share)
  this.log('stopping replication %s', replication_to_user)
  this.couch.database('_replicator').update("shares/stop", replication_to_share);
  this.couch.database('_replicator').update("shares/stop", replication_to_user);

  // give it a time out so that replication docs can be dropped
  // without being updated due to "target/source db does not exist"  errors
  setTimeout( function() {
    this.couch.database(shareDatabaseName).destroy();
  }.bind(this), 3000)

  this.database.all({
    startkey: shareDatabaseName + "/",
    endkey: shareDatabaseName + "0"
  }, function(error, response) {
    var docsToDelete = [];
    if (error) {
      this.log("Error loading objects belonging to %s. %j", this.name, error);
      return;
    }

    // gather docs to be deleted
    for (var sharedDoc, i = 0; i < response.rows.length; i++) {
      sharedDoc = response.rows[i];
      docsToDelete.push({
        _id: sharedDoc._id,
        _rev: sharedDoc._rev,
        _deleted: true
      });
    }

    // delete 'em all at once
    this.database.save(docsToDelete);
  }.bind(this)); 
}

// 
// just as `createShare`, only without creating the share db
// or updating access settings
//
UserSharesDatabase.prototype.unsubscribeFromShare = function(shareDatabaseName) {
  this.log("unsubscribeFromShare: " + shareDatabaseName)

  var replication_to_share = this.name + " => " + shareDatabaseName,
      replication_to_user = shareDatabaseName + " => " + this.name;

  this.couch.database('_replicator').update("shares/stop", replication_to_share);
  this.couch.database('_replicator').update("shares/stop", replication_to_user);
}

// 
// If an update comes from somebody else and the object in question does
// exist in my userDB, check if it's also shared at other places. If yes,
// update the object for these shares as well.
// Make sure to only update the fields that are shared if an array of
// properties is set.
// 
UserSharesDatabase.prototype.updateObjectForOtherShares = function(userDoc, sharedDoc, currentShareId) {
  var shareId, access, docId;
  for (shareId in userDoc.$shares) {
    if (shareId === currentShareId) continue

    // all 
    docId = "share/" + shareId + "/" + userDoc._id
    this.mergeRemote(docId, sharedDoc, userDoc.$shares[shareId])
  }
}

// 
// 
// 
UserSharesDatabase.prototype.merge = function(userDoc, sharedDoc, access) {

  var attributes = ['updatedAt', 'updatedBy'],
      attribute

  if ( access === true ) {
    attributes = Object.keys(sharedDoc)
  } else {
    attributes = attributes.concat(access) 
  }

  for (var i = 0; i < attributes.length; i++) {
    attribute = attributes[i]
    userDoc[attribute] = sharedDoc[attribute]
  }

  return userDoc 
}

// 
// 
// 
UserSharesDatabase.prototype.mergeRemote = function(docId, sharedDoc, access) {
  var attributes;
  this.database.get(docId, function (error, otherSharedDoc) {
    if (error) {
      this.log("ERROR: cannot find %s. %j", docId, error)
      return
    }

    otherSharedDoc = this.merge(otherSharedDoc, sharedDoc, access)


    // updates to docs in user/shares dbs that have been made
    // by the SharesWorker get a special _rev ending with
    // "-auto" to prevent recursion.
    otherSharedDoc._rev = otherSharedDoc._rev += "-auto"
    options = {
      method : 'PUT', 
      path   : encodeURIComponent(docId) + "?new_edits=false", 
      body   : otherSharedDoc
    }
    this.database.query(options, function(error) {
      if (error) {
        this.log("ERROR: Couldn't PUT %s in %s: %j", otherSharedDoc._id, this.name, error)
        return;
      } 

      this.log("SUCCESS PUT " + otherSharedDoc._id + " in " + this.name)
    }.bind(this));
  }.bind(this))
}


// 
// 
// 
UserSharesDatabase.prototype.generateNewRevisionId = function() {
  var timestamp, uuid;

  if (! this._timezoneOffset)
    this._timezoneOffset = new Date().getTimezoneOffset() * 60;

  timestamp = Date.now() + this._timezoneOffset;
  uuid = this.uuid();

  return "" + uuid + "#" + timestamp;
}


// 
// 
// 
UserSharesDatabase.prototype.uuid = function() {
  var chars, i, radix, len = 5;
  chars = '0123456789abcdefghijklmnopqrstuvwxyz'.split('');
  radix = chars.length;
  return ((function() {
    var _i, _results;
    _results = [];
    for (i = _i = 0; 0 <= len ? _i < len : _i > len; i = 0 <= len ? ++_i : --_i) {
      _results.push(chars[0 | Math.random() * radix]);
    }
    return _results;
  })()).join('');
}


// 
// 
// 
UserSharesDatabase.prototype.log = function() {
  this.worker.log.apply( this.worker, arguments)
}

module.exports = UserSharesDatabase;