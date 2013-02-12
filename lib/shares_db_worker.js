/**
 *  SharesDbWorker
 *  handle share related changes in user's shares database
 */
var util          = require('util');
var HoodieWorker  = require('hoodie-worker');

var SharesDbWorker = function(databaseName, userDbWorker)
{
  this.name             = databaseName;
  this.userDatabaseName = databaseName.replace(/\/shares$/, '');
  
  this.userDbWorker = userDbWorker;
  this.couch        = userDbWorker.couch;

  // "user/hash345/shares" => "hash345"
  this.ownerHash = databaseName.match(/^user\/([^\/]+)/).pop(); 

  // map of user shares
  this.shares = {}

  // make sure that the User's shares database exists
  this.createDatabase();

  this.listenUp()
};
util.inherits(SharesDbWorker, HoodieWorker);


// 
// 
// 
SharesDbWorker.prototype.listenUp = function() {
  this.userDbWorker.on('account:removed', this.handleAccountRemoved.bind(this))
  this.userDbWorker.on('share:change', this.handleShareObjectChange.bind(this))

  this.userDbWorker.on('object:unshared', this.handleUnsharedObject.bind(this))
  this.userDbWorker.on('object:changed', this.handleObjectUpdate.bind(this))
}


// 
// 
// 
SharesWorker.prototype.handleAccountRemoved = function() {
  this.dropAllDatabases.bind(this);
};


// 
// handling changes to a $share object
// 
SharesDbWorker.prototype.handleShareObjectChange = function(doc) {

  var shareId = doc._id.substr(1); // $share/123 => share/123

  if (this.shares[shareId] && this.shares[shareId].createdBy !== this.ownerHash) {
    this.log("Subscription Update: %s", shareId)
    
    // when a share gets deleted, remove its database, replications and objects
    if (doc._deleted) {
      this.unsubscribeFromShare(shareId);
      return;
    }

    this.subscribeToShare(shareId);
  } else {

    // when a share gets deleted, remove its database, replications and objects
    if (doc._deleted && this.shares[shareId]) {
      this.dropShare(shareId);
      return;
    }

    // if this is a new share, create its database and replications
    if (! this.shares[shareId]) {
      this.createShare(shareId, doc);
      return;
    }

    // if this is a share update
    if (this.shares[shareId]) {
      this.log('_updateAccessSettings for ' + shareId + '?')
      if(this.accessSettingsChanged(this.shares[shareId], doc)) {
        this._updateAccessSettings(shareId, doc);
      } else {
        this.log('nope. no security changes found for ' + shareId + '!')
      }
    }
  }
}


// 
// prepare update for shared doc
// 
// 1. prefix _id with "share/{shareId}"
// 2. generate new _rev and add past and current _rev IDs in _revisions,
//    as we use `new_edits=false` flag
// 
SharesDbWorker.prototype.prepareSharedObjectUpdate = function(shareId, originalDoc) {
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
SharesDbWorker.prototype.handleUnsharedObject = function( shareId, object) {
  var sharedObject = this.prepareSharedObjectUpdate(shareId, object);
  sharedObject._deleted = true
  this.updateSharedObject( sharedObject )
}

// 
// 
// 
SharesDbWorker.prototype.handleObjectUpdate = function( shareId, object) {
  var filter = object.$shares[shareId];
  var sharedObject = this.prepareSharedObjectUpdate(shareId, object);

  if (filter === true) {

    // share entire object
    for (var key in doc) {
      if (typeof sharedObject[key] === 'undefined' && key !== '$shares') {
        sharedObject[key] = doc[key];
      }
    }

  } else {

    // when filter is an Array, share only the passed Attributes
    for (var i = 0; i < filter.length; i++) {
      attribute = filter[i];
      sharedObject[attribute] = doc[attribute];
    }
  }

  this.updateSharedObject( sharedObject )
}


// 
// 
// 
SharesDbWorker.prototype.updateSharedObject = function(object) {
  var sharedObject = this.prepareSharedObjectUpdate(shareId, object);

  this.log('updateSharedObject: %s', sharedObject._id)
  options = {
    method : 'PUT', 
    path   : encodeURIComponent(sharedObject._id) + "?new_edits=false", 
    body   : sharedObject
  }

  this.couch.database(this.name).query(options, function(error) {
    if (error) {
      this.log("ERROR: Couldn't PUT %s in %s: %j", sharedObject._id, this.name, error)
      return;
    } 

    this.log("SUCCESS PUT " + sharedObject._id + " in " + this.name)
  }.bind(this));
}

// 
// helper methods to check if access settings changed
// 
SharesDbWorker.prototype.accessSettingsChanged = function(shareDoc1, shareDoc2) {
  return !this.readAccessSettingIsEqual(shareDoc1, shareDoc2) || !this.writeAccessSettingIsEqual(shareDoc1, shareDoc2);
}
SharesDbWorker.prototype.readAccessSettingIsEqual = function(shareDoc1, shareDoc2) {
  var settings1 = shareDoc1.read || shareDoc1, 
      settings2 = shareDoc2.read || shareDoc2;

  this.accessSettingIsEqual(settings1, settings2);
}
SharesDbWorker.prototype.writeAccessSettingIsEqual = function(shareDoc1, shareDoc2) {
  var settings1 = shareDoc1.write, 
      settings2 = shareDoc2.write;

  this.accessSettingIsEqual(settings1, settings2);
}
SharesDbWorker.prototype.accessSettingIsEqual = function(settings1, settings2) {
  if (settings1 === settings2)
    return true;

  if (Array.isArray(settings1) && Array.isArray(settings2)) {
    // simple array comparision that works for us:
    // http://stackoverflow.com/a/5115066/206879
    settings1.sort();
    settings2.sort();
    return ! (settings1<settings2 || settings2<settings1);
  }
}


// 
// 
// 
SharesDbWorker.prototype.createDatabase = function() {
  this.log('timeout done. Creating database %s ...', this.name)
  this.couch.database(this.name).create( function(error) {
    if (error) {
      this.log("Error creating datbase %s: %j", this.name, error);

      if (error.error === 'file_exists') {
        this.startListeningToChanges();
      }
      return;
    }

    this.log("Success! Created datbase %s", this.name);
    this.startListeningToChanges();

    // this method is usually used for the individual share databases, but it
    // works perfectly fine for the shares database as well
    this.updateAccessSettings(this.name, {access: false});
  }.bind(this));
}


// 
// 
// 
SharesDbWorker.prototype.startListeningToChanges = function () {
  this.log('starting to listen for changes on %s', this.name)
  this.feed = this.couch.database(this.name).changes({include_docs:true});
  this.feed.on("change", this.handleChange.bind(this));
  this.feed.on("error",  this.handleChangeError.bind(this));
}

// 
// Only the user is allowed to access his shares database
// 
SharesDbWorker.prototype.updateAccessSettings = function(databaseName, shareDoc) {
  this.log('updateAccessSettings for ' + databaseName)
  var readAccess  = shareDoc && shareDoc.access && (shareDoc.access.read || shareDoc.access),
      writeAccess = shareDoc && shareDoc.access && shareDoc.access.write;

  this.when([
    this.updateAccess(readAccess), 
    this.updateAccess(writeAccess)
  ]).then(function(promises) {
    var members = promises[0].valueOf(),
        writers = promises[1].valueOf();

    this.sendSecurityUpdateRequest(databaseName, members, writers);
  }.bind(this), function(error) {
    this.log("ERROR in updateAccessSettings: %j", error)
  });
}
SharesDbWorker.prototype.updateAccess = function(accessSetting) {
  var defer = this.defer();

  if (accessSetting === true) {
    defer.resolve([])
    return defer.promise;
  }

  if (accessSetting === undefined || accessSetting === false) {
    this.log("accessSetting is %s", accessSetting)
    this.log("this.ownerHash is %s", this.ownerHash)
    defer.resolve([this.ownerHash])
    return defer.promise;
  }

  // accessSetting is array of names
  this.couch.database("_users").view('views/ownerByUsername', { keys: accessSetting}, function(error, results) {
    this.log("views/ownerByUsername: \n%j", results)
    this.log("accessSetting: \n%j", accessSetting)


    var list = [this.ownerHash];

    // TOOD: handle errors
    results.forEach( function(result) { 
      this.log("result: %j", result)
      list.push(result.value); 
    });

    this.log("list: %j", list)
    defer.resolve(list);
  }.bind(this));

  return defer.promise;
}


// 
// 
// 
SharesDbWorker.prototype.sendSecurityUpdateRequest = function(databaseName, members, writers) {
  var options = {
    path   : '_security',
    method : 'PUT',
    json   : {
      members: {
        roles: members
      },
      writers: {
        roles: writers
      }
    }
  };

  this.log("updating " + databaseName + "/_security with: %j", options.json)
  this.couch.database(databaseName).query(options, function(error, response) {
    if (error) {
      this.log("ERROR updating " + databaseName + "/_security: %j", error)
      return
    }

    this.log("security created for %s", databaseName);
  }.bind(this));
}


// 
// 
// 
SharesDbWorker.prototype.handleChangeError = function(error) {
  this.log("ERROR: %j", error);
}


// 
// 
// 
SharesDbWorker.prototype.handleChange = function(change) {
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
SharesDbWorker.prototype.dropAllDatabases = function() {
  // this.feed.off("change", this.handleChange.bind(this));
  // this.feed.off("error",  this.handleChangeError.bind(this));
  this.log('dropping all databases for %s', this.userDatabaseName)

  this.couch.database(this.userDatabaseName).all({
    startkey     : "$share/",
    endkey       : "$share0",
    include_docs : true
  }, function(error, response) {
    var share_database;

    if (error) {
      this.log("Couldn't drop $share databases:");
      this.log("Error loading all $share docs from %s. %j", this.userDatabaseName, error);
      return;
    }

    this.log('$share docs loaded: %s', response.rows.length)
    for (var i = 0; i < response.rows.length; i++) {
      row = response.rows[i];
      if (row.doc.type === '$share' && row.doc.createdBy === this.ownerHash) {
        this.dropShare(row.id.substr(1)); // $share/123 => share/123
      } else {
        this.log('not dropping share %s', row.id.substr(1))
        this.log('row.doc.createdBy === %s (%s)', row.doc.createdBy, this.ownerHash)
      }
    }

    // give it a time out so that replication docs can be dropped
    // without being updated due to "target/source db does not exist"  errors
    setTimeout( function() {
      this.couch.database(this.name).destroy();
    }.bind(this), 3000)
  }.bind(this));
}


// 
// 
//
SharesDbWorker.prototype.createShare = function(share_databaseName, shareDoc) {
  this.log("createShare: " + share_databaseName)

  // TODO:
  // create _design doc in share database to mirror the share writer settings
  // create continuous replications as needed
  // upate $state attribute

  var replication_to_share = this.name + " => " + share_databaseName,
      replication_to_user  = share_databaseName + " => " + this.name,
      shareId = share_databaseName.split('/').pop();


  this.couch.replicate({
    source        : "skeleton/share",
    target        : share_databaseName,
    create_target : true
  }, function(error) {
    if (error) {
      this.log("Error creating share datbase %s. %j", share_databaseName, error);
      return;
    }

    this.updateAccessSettings(share_databaseName, shareDoc);

    this.couch.database('_replicator').update("shares/start", replication_to_share, {filter: 'filters/share' });
    this.couch.database('_replicator').update("shares/start", replication_to_user);
  }.bind(this));

  this.shares[share_databaseName] = shareDoc;
}

// 
// just as `createShare`, only without creating the share db
// or updating access settings
//
SharesDbWorker.prototype.subscribeToShare = function(share_databaseName) {
  this.log("subscribeToShare: " + share_databaseName)

  var replication_to_share = this.name + " => " + share_databaseName,
      replication_to_user = share_databaseName + " => " + this.name,
      shareId = share_databaseName.split('/').pop();

  this.couch.database('_replicator').update("shares/start", replication_to_share, {filter: 'filters/share' });
  this.couch.database('_replicator').update("shares/start", replication_to_user);
}

// 
// 
// 
SharesDbWorker.prototype.dropShare = function(share_databaseName)
{
  this.log("dropShare: " + share_databaseName)

  var replication_to_share = this.name + " => " + share_databaseName,
      replication_to_user = share_databaseName + " => " + this.name;

  this.log('stopping replication %s', replication_to_share)
  this.log('stopping replication %s', replication_to_user)
  this.couch.database('_replicator').update("shares/stop", replication_to_share);
  this.couch.database('_replicator').update("shares/stop", replication_to_user);

  // give it a time out so that replication docs can be dropped
  // without being updated due to "target/source db does not exist"  errors
  setTimeout( function() {
    this.couch.database(share_databaseName).destroy();
  }.bind(this), 3000)

  this.couch.database(this.name).all({
    startkey: share_databaseName + "/",
    endkey: share_databaseName + "0"
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
    this.couch.database(this.name).save(docsToDelete);
  }.bind(this)); 
}

// 
// just as `createShare`, only without creating the share db
// or updating access settings
//
SharesDbWorker.prototype.unsubscribeFromShare = function(share_databaseName) {
  this.log("unsubscribeFromShare: " + share_databaseName)

  var replication_to_share = this.name + " => " + share_databaseName,
      replication_to_user = share_databaseName + " => " + this.name;

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
SharesDbWorker.prototype.updateObjectForOtherShares = function(userDoc, sharedDoc, currentShareId) {
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
SharesDbWorker.prototype.merge = function(userDoc, sharedDoc, access) {

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
SharesDbWorker.prototype.mergeRemote = function(docId, sharedDoc, access) {
  var attributes;
  this.couch.database(this.name).get(docId, function (error, otherSharedDoc) {
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
    this.couch.database(this.name).query(options, function(error) {
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
SharesDbWorker.prototype.generateNewRevisionId = function() {
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
UserDbWorker.prototype.uuid = function() {
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


module.exports = SharesDbWorker;