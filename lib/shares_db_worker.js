/**
 *  SharesDbWorker
 *  handle share related changes in user's shares database
 */
var util          = require('util');
var HoodieWorker  = require('hoodie-worker');

var SharesDbWorker = function(databaseName, couch)
{
  this.databaseName     = databaseName;
  this.userDatabaseName = databaseName.replace(/\/shares$/, '');
  this.couch  = couch;

  // "user/hash345/shares" => "hash345"
  this.owner = databaseName.match(/^user\/([^\/]+)/).pop(); 

  // make sure that the User's shares database exists
  this._createUserSharesDatabase();
};
util.inherits(SharesDbWorker, HoodieWorker);


// 
// 
// 
SharesDbWorker.prototype.shares = {}


// 
// 
// 
SharesDbWorker.prototype._createUserSharesDatabase = function() {
  this._log('timeout done. Creating database %s ...', this.databaseName)
  this.couch.database(this.databaseName).create( function(error) {
    if (error) {
      this._log("Error creating datbase %s: %j", this.databaseName, error);

      if (error.error === 'file_exists') {
        this._startListeningToChanges();
      }
      return;
    }

    this._log("Success! Created datbase %s", this.databaseName);
    this._startListeningToChanges();

    // this method is usually used for the individual share databases, but it
    // works perfectly fine for the shares database as well
    this._updateAccessSettings(this.databaseName, {access: false});
  }.bind(this));
}


// 
// 
// 
SharesDbWorker.prototype._startListeningToChanges = function () {
  this._log('starting to listen for changes on %s', this.databaseName)
  this.feed = this.couch.database(this.databaseName).changes({include_docs:true});
  this.feed.on("change", this._handleChange.bind(this));
  this.feed.on("error",  this._handleChangeError.bind(this));
}

// 
// Only the user is allowed to access his shares database
// 
SharesDbWorker.prototype._updateAccessSettings = function(databaseName, shareDoc) {
  this._log('_updateAccessSettings for ' + databaseName)
  var readAccess  = shareDoc && shareDoc.access && (shareDoc.access.read || shareDoc.access),
      writeAccess = shareDoc && shareDoc.access && shareDoc.access.write;

  this.when([
    this._updateAccess(readAccess), 
    this._updateAccess(writeAccess)
  ]).then(function(promises) {
    var members = promises[0].valueOf(),
        writers = promises[1].valueOf();

    this._sendSecurityUpdateRequest(databaseName, members, writers);
  }.bind(this), function(error) {
    this._log("ERROR in _updateAccessSettings: %j", error)
  });
}
SharesDbWorker.prototype._updateAccess = function(accessSetting) {
  var defer = this.defer();

  if (accessSetting === true) {
    defer.resolve([])
    return defer.promise;
  }

  if (accessSetting === undefined || accessSetting === false) {
    this._log("accessSetting is %s", accessSetting)
    this._log("this.owner is %s", this.owner)
    defer.resolve([this.owner])
    return defer.promise;
  }

  // accessSetting is array of names
  this.couch.database("_users").view('views/ownerByUsername', { keys: accessSetting}, function(error, results) {
    this._log("views/ownerByUsername: \n%j", results)
    this._log("accessSetting: \n%j", accessSetting)


    var list = [this.owner];

    // TOOD: handle errors
    results.forEach( function(result) { 
      this._log("result: %j", result)
      list.push(result.value); 
    });

    this._log("list: %j", list)
    defer.resolve(list);
  }.bind(this));

  return defer.promise;
}


// 
// 
// 
SharesDbWorker.prototype._sendSecurityUpdateRequest = function(databaseName, members, writers) {
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

  this._log("updating " + databaseName + "/_security with: %j", options.json)
  this.couch.database(databaseName).query(options, function(error, response) {
    if (error) {
      this._log("ERROR updating " + databaseName + "/_security: %j", error)
      return
    }

    this._log("security created for %s", databaseName);
  }.bind(this));
}


// 
// 
// 
SharesDbWorker.prototype._handleChangeError = function(error) {
  this._log("ERROR: %j", error);
}


// 
// 
// 
SharesDbWorker.prototype._handleChange = function(change) {
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
  if ( change.doc.updatedBy === this.owner ||
       change.id.indexOf('share\/') !== 0) {
    return
  }

  sharedDoc = change.doc
  shareId  = sharedDoc._id.match(/^share\/([^\/]+)/)[0]
  docId    = sharedDoc._id.substr(shareId.length + 1)

  this._log("BOOM, an update from %s:", shareId)
  this._log("%j", change)
  
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
            this._log("ERROR: Couldn't PUT %s in %s: %j", sharedDoc._id, this.userDatabaseName, error)
            return;
          } 

          this._log("SUCCESS PUT " + sharedDoc._id + " in " + this.userDatabaseName)
        }.bind(this));

      } else {
        this._log("ERROR getting %s from %s:", docId, this.userDatabaseName)
        this._log("%j", error)
      }
      return
    }

    this._log("%s loaded from %s:", docId, this.userDatabaseName)
    this._log(userDoc);

    if (sharedDoc._deleted && userDoc.$shares  && userDoc.$shares[shareId]) {
      delete userDoc.$shares[shareId]
    } else {
      // we're good. Doc has been removed in share and our userDoc
      // is not connected to it anyway
    }

    if (userDoc.$shares) {
      // If object is also shared in other places, update them
      this._updateObjectForOtherShares(userDoc, sharedDoc, shareId)
    } else {
      userDoc.$shares = {}
    }

    // create / update / remove object in / from shares database
    if (! userDoc.$shares[shareId]) userDoc.$shares[shareId] = true
    userDoc = this._merge(userDoc, sharedDoc, userDoc.$shares[shareId])
    options = {
      method : 'PUT', 
      path   : encodeURIComponent(docId) + "?new_edits=false", 
      body   : userDoc
    }
    this.couch.database(this.userDatabaseName).query(options, function(error) {
      if (error) {
        this._log("ERROR: Couldn't PUT %s in %s: %j", userDoc._id, this.userDatabaseName, error)
        return;
      } 

      this._log("SUCCESS PUT " + userDoc._id + " in " + this.userDatabaseName)
    }.bind(this));
  }.bind(this))
}


// 
// 
// 
SharesDbWorker.prototype.dropAllDatabases = function() {
  // this.feed.off("change", this._handleChange.bind(this));
  // this.feed.off("error",  this._handleChangeError.bind(this));

  this._log('dropping all databases for %s', this.userDatabaseName)

  this.couch.database(this.userDatabaseName).all({
    startkey     : "$share/",
    endkey       : "$share0",
    include_docs : true
  }, function(error, response) {
    var share_database;

    if (error) {
      this._log("Couldn't drop $share databases:");
      this._log("Error loading all $share docs from %s. %j", this.userDatabaseName, error);
      return;
    }

    this._log('$share docs loaded: %s', response.rows.length)
    for (var i = 0; i < response.rows.length; i++) {
      row = response.rows[i];
      if (row.doc.type === '$share' && row.doc.createdBy === this.owner) {
        this.dropShare(row.id.substr(1)); // $share/123 => share/123
      } else {
        this._log('not dropping share %s', row.id.substr(1))
        this._log('row.doc.createdBy === %s (%s)', row.doc.createdBy, this.owner)
      }
    }

    // give it a time out so that replication docs can be dropped
    // without being updated due to "target/source db does not exist"  errors
    setTimeout( function() {
      this.couch.database(this.databaseName).destroy();
    }.bind(this), 3000)
  }.bind(this));
}


// 
// 
//
SharesDbWorker.prototype.createShare = function(share_databaseName, shareDoc) {
  this._log("createShare: " + share_databaseName)

  // TODO:
  // create _design doc in share database to mirror the share writer settings
  // create continuous replications as needed
  // upate $state attribute

  var replication_to_share = this.databaseName + " => " + share_databaseName,
      replication_to_user = share_databaseName + " => " + this.databaseName,
      shareId = share_databaseName.split('/').pop();


  this.couch.replicate({
    source        : "skeleton/share",
    target        : share_databaseName,
    create_target : true
  }, function(error) {
    if (error) {
      this._log("Error creating share datbase %s. %j", share_databaseName, error);
      return;
    }

    this._updateAccessSettings(share_databaseName, shareDoc);

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
  this._log("subscribeToShare: " + share_databaseName)

  var replication_to_share = this.databaseName + " => " + share_databaseName,
      replication_to_user = share_databaseName + " => " + this.databaseName,
      shareId = share_databaseName.split('/').pop();

  this.couch.database('_replicator').update("shares/start", replication_to_share, {filter: 'filters/share' });
  this.couch.database('_replicator').update("shares/start", replication_to_user);
}

// 
// 
// 
SharesDbWorker.prototype.dropShare = function(share_databaseName)
{
  this._log("dropShare: " + share_databaseName)

  var replication_to_share = this.databaseName + " => " + share_databaseName,
      replication_to_user = share_databaseName + " => " + this.databaseName;

  this._log('stopping replication %s', replication_to_share)
  this._log('stopping replication %s', replication_to_user)
  this.couch.database('_replicator').update("shares/stop", replication_to_share);
  this.couch.database('_replicator').update("shares/stop", replication_to_user);

  // give it a time out so that replication docs can be dropped
  // without being updated due to "target/source db does not exist"  errors
  setTimeout( function() {
    this.couch.database(share_databaseName).destroy();
  }.bind(this), 3000)

  this.couch.database(this.databaseName).all({
    startkey: share_databaseName + "/",
    endkey: share_databaseName + "0"
  }, function(error, response) {
    var docsToDelete = [];
    if (error) {
      this._log("Error loading objects belonging to %s. %j", this.databaseName, error);
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
    this.couch.database(this.databaseName).save(docsToDelete);
  }.bind(this)); 
}

// 
// just as `createShare`, only without creating the share db
// or updating access settings
//
SharesDbWorker.prototype.unsubscribeFromShare = function(share_databaseName) {
  this._log("unsubscribeFromShare: " + share_databaseName)

  var replication_to_share = this.databaseName + " => " + share_databaseName,
      replication_to_user = share_databaseName + " => " + this.databaseName;

  this.couch.database('_replicator').update("shares/stop", replication_to_share);
  this.couch.database('_replicator').update("shares/stop", replication_to_user);
}

// 
// If an update comes from somebody else and the object in question does
// exist my userDB, check if it's also shared at other places. If yes,
// update the object for these shares as well.
// Make sure to only update the fields that are shared if an array of
// properties is set.
// 
SharesDbWorker.prototype._updateObjectForOtherShares = function(userDoc, sharedDoc, currentShareId) {
  var shareId, access, docId;
  for (shareId in userDoc.$shares) {
    if (shareId === currentShareId) continue

    // all 
    docId = "share/" + shareId + "/" + userDoc._id
    this._mergeRemote(docId, sharedDoc, userDoc.$shares[shareId])
  }
}

// 
// 
// 
SharesDbWorker.prototype._merge = function(userDoc, sharedDoc, access) {

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
SharesDbWorker.prototype._mergeRemote = function(docId, sharedDoc, access) {
  var attributes;
  this.couch.database(this.databaseName).get(docId, function (error, otherSharedDoc) {
    if (error) {
      this._log("ERROR: cannot find %s. %j", docId, error)
      return
    }

    otherSharedDoc = this._merge(otherSharedDoc, sharedDoc, access)


    // updates to docs in user/shares dbs that have been made
    // by the SharesWorker get a special _rev ending with
    // "-auto" to prevent recursion.
    otherSharedDoc._rev = otherSharedDoc._rev += "-auto"
    options = {
      method : 'PUT', 
      path   : encodeURIComponent(docId) + "?new_edits=false", 
      body   : otherSharedDoc
    }
    this.couch.database(this.databaseName).query(options, function(error) {
      if (error) {
        this._log("ERROR: Couldn't PUT %s in %s: %j", otherSharedDoc._id, this.databaseName, error)
        return;
      } 

      this._log("SUCCESS PUT " + otherSharedDoc._id + " in " + this.databaseName)
    }.bind(this));
  }.bind(this))
}

// 
SharesDbWorker.prototype._log = function() {
  arguments[0] = "[" + this.databaseName + "Worker] " + arguments[0];
  console.log.apply(null, arguments)
}

module.exports = SharesDbWorker;