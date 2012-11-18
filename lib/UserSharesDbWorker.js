/**
 *  UserSharesDbWorker
 *  handle share related changes in user's shares database
 */
var Q = require("q");
var util = require("util");

var UserSharesDbWorker = function(databaseName, couchConnection)
{
  this.databaseName     = databaseName;
  this.userDatabaseName = databaseName.replace(/\/shares$/, '');
  this.couchConnection  = couchConnection;

  // "user/hash345/shares" => "hash345"
  this.owner = databaseName.match(/^user\/([^\/]+)/).pop(); 

  // make sure that the User's shares database exists
  this._createUserSharesDatabase();

  this.feed = this.couchConnection.database(databaseName).changes({include_docs:true});
  this.feed.on("change", this._handleChange.bind(this));
  this.feed.on("error",  this._handleChangeError.bind(this));
};


UserSharesDbWorker.prototype = {

  // 
  // 
  // 
  shares: {},

  // 
  // 
  // 
  _createUserSharesDatabase: function() {
    this.couchConnection.database(this.databaseName).create( function(error) {
      if (error) {
        this._log("Error creating datbase %s: %j", this.databaseName, error);
        return;
      }

      // this method is usually used for the individual share databases, but it
      // works perfectly fine for the shares database as well
      this._updateAccessSettings(this.databaseName, {access: false});
    }.bind(this));
  },


  // 
  // Only the user is allowed to access his shares database
  // 
  _updateAccessSettings: function(databaseName, shareDoc) {
    this._log('_updateAccessSettings for ' + databaseName)
    var readAccess  = shareDoc && shareDoc.access && (shareDoc.access.read || shareDoc.access),
        writeAccess = shareDoc && shareDoc.access && shareDoc.access.write;

    Q.all([
      this._updateAccess(readAccess), 
      this._updateAccess(writeAccess)
    ]).then(function(promises) {
      var members = promises[0].valueOf(),
          writers = promises[1].valueOf();

      this._sendSecurityUpdateRequest(databaseName, members, writers);
    }.bind(this), function(error) {
      this._log("ERROR in _updateAccessSettings: %j", error)
    });
  },
  _updateAccess: function(accessSetting) {
    var defer = Q.defer();

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
    this.couchConnection.database("_users").view('views/ownerByUsername', { keys: accessSetting}, function(error, results) {
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
  },


  // 
  // 
  // 
  _sendSecurityUpdateRequest: function(databaseName, members, writers) {
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
    this.couchConnection.database(databaseName).query(options, function(error, response) {
      if (error) {
        this._log("ERROR updating " + databaseName + "/_security: %j", error)
        return
      }

      this._log("security created for %s", databaseName);
    }.bind(this));
  },


  // 
  // 
  // 
  _handleChangeError: function(error) {
    this._log("ERROR: %j", error);
  },


  // 
  // 
  // 
  _handleChange: function(change) {
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
    if ( change.doc.$updatedBy === this.owner ||
         change.id.indexOf('share\/') !== 0) {
      return
    }

    sharedDoc = change.doc
    shareId  = sharedDoc._id.match(/^share\/([^\/]+)/)[0]
    docId    = sharedDoc._id.substr(shareId.length + 1)

    this._log("BOOM, an update from %s:", shareId)
    this._log("%j", change)
    
    this.couchConnection.database(this.userDatabaseName).get(docId, function (error, userDoc) {
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
          this.couchConnection.database(this.userDatabaseName).query(options, function(error) {
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
      this.couchConnection.database(this.userDatabaseName).query(options, function(error) {
        if (error) {
          this._log("ERROR: Couldn't PUT %s in %s: %j", userDoc._id, this.userDatabaseName, error)
          return;
        } 

        this._log("SUCCESS PUT " + userDoc._id + " in " + this.userDatabaseName)
      }.bind(this));
    }.bind(this))
  },


  // 
  // 
  // 
  dropAllDatabases: function(change) {
    // this.feed.off("change", this._handleChange.bind(this));
    // this.feed.off("error",  this._handleChangeError.bind(this));

    this.couchConnection.database(this.userDatabaseName).all({
      startkey     : "$share/",
      endkey       : "$share0",
      include_docs : true
    }, function(error, response) {
      var share_database;

      if (error) {
        this._log("Couldn't drop $share databases:");
        this._log("Error loading all $share docs from %s.", this.userDatabaseName);
        return;
      }

      for (var i = 0; i < response.rows.length; i++) {
        row = response.rows[i];
        if (row.doc.$type === '$share' && row.doc.$owner === this.owner) {
          this.dropShare(row.id.substr(1)); // $share/123 => share/123
        }
      }

      this.couchConnection.database(this.databaseName).destroy();
    }.bind(this));
    // get all $share objects and drop their databases and replications,
    // then:
    // this.couchConnection.database(this.databaseName).destroy();
  },


  // 
  // 
  //
  createShare: function(share_databaseName, shareDoc) {
    this._log("createShare: " + share_databaseName)

    // TODO:
    // create _design doc in share database to mirror the share writer settings
    // create continuous replications as needed
    // upate $state attribute

    var replication1_name = this.databaseName + " => " + share_databaseName,
        replication2_name = share_databaseName + " => " + this.databaseName;

    this.couchConnection.replicate({
      source        : "skeleton/share",
      target        : share_databaseName,
      create_target : true
    }, function(error) {
      if (error) {
        this._log("Error creating share datbase %s.", share_databaseName);
        return;
      }

      this._updateAccessSettings(share_databaseName, shareDoc);

      this.couchConnection.database('_replicator').update("shares/start", replication1_name);
      this.couchConnection.database('_replicator').update("shares/start", replication2_name);
    }.bind(this));

    this.shares[share_databaseName] = shareDoc;
  },

  // 
  // just as `createShare`, only without creating the share db
  // or updating access settings
  //
  subscribeToShare: function(share_databaseName) {
    this._log("subscribeToShare: " + share_databaseName)

    var replication1_name = this.databaseName + " => " + share_databaseName,
        replication2_name = share_databaseName + " => " + this.databaseName;

    this.couchConnection.database('_replicator').update("shares/start", replication1_name);
    this.couchConnection.database('_replicator').update("shares/start", replication2_name);
  },

  // 
  // 
  // 
  dropShare: function(share_databaseName)
  {
    this._log("dropShare: " + share_databaseName)

    var replication1_name = this.databaseName + " => " + share_databaseName,
        replication2_name = share_databaseName + " => " + this.databaseName;

    this.couchConnection.database('_replicator').update("shares/stop", replication1_name);
    this.couchConnection.database('_replicator').update("shares/stop", replication2_name);
    this.couchConnection.database(share_databaseName).destroy();

    this.couchConnection.database(this.databaseName).all({
      startkey: "$" + share_databaseName + "/",
      endkey: "$" + share_databaseName + "0"
    }, function(error, response) {
      var docsToDelete = [];
      if (error) {
        this._log("Error loading objects belonging to %s from %s", doc._id, this.sharesDatabaseName);
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
      this.couchConnection.database(this.sharesDatabaseName).save(docsToDelete);
    }.bind(this)); 
  },

  // 
  // just as `createShare`, only without creating the share db
  // or updating access settings
  //
  unsubscribeFromShare: function(share_databaseName) {
    this._log("unsubscribeFromShare: " + share_databaseName)

    var replication1_name = this.databaseName + " => " + share_databaseName,
        replication2_name = share_databaseName + " => " + this.databaseName;

    this.couchConnection.database('_replicator').update("shares/stop", replication1_name);
    this.couchConnection.database('_replicator').update("shares/stop", replication2_name);
  },

  // 
  // If an update comes from somebody else and the object in question does
  // exist my userDB, check if it's also shared at other places. If yes,
  // update the object for these shares as well.
  // Make sure to only update the fields that are shared if an array of
  // properties is set.
  // 
  _updateObjectForOtherShares: function(userDoc, sharedDoc, currentShareId) {
    var shareId, access, docId;
    for (shareId in userDoc.$shares) {
      if (shareId === currentShareId) continue

      // all 
      docId = "share/" + shareId + "/" + userDoc._id
      this._mergeRemote(docId, sharedDoc, userDoc.$shares[shareId])
    }
  },

  // 
  // 
  // 
  _merge: function(userDoc, sharedDoc, access) {

    var attributes = ['$updatedAt', '$updatedBy'],
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
  },

  // 
  // 
  // 
  _mergeRemote: function(docId, sharedDoc, access) {
    var attributes;
    this.couchConnection.database(this.databaseName).get(docId, function (error, otherSharedDoc) {
      if (error) {
        this._log("ERROR: cannot find %s", docId)
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
      this.couchConnection.database(this.databaseName).query(options, function(error) {
        if (error) {
          this._log("ERROR: Couldn't PUT %s in %s: %j", otherSharedDoc._id, this.databaseName, error)
          return;
        } 

        this._log("SUCCESS PUT " + otherSharedDoc._id + " in " + this.databaseName)
      }.bind(this));
    }.bind(this))
  },

  // 
  _log: function() {
    arguments[0] = "[" + this.databaseName + " worker] " + arguments[0];
    console.log.apply(null, arguments)
  }
};

module.exports = UserSharesDbWorker;