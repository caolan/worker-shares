/**
 *  UserSharesDbWorker
 *  handle share related changes in user's shares database
 */
var Q = require("q");

var UserSharesDbWorker = function(databaseName)
{
  this.shares = {};
  this.databaseName = databaseName;

  // "user/hash345/shares" => "hash345"
  this.owner = databaseName.match(/^user\/([^\/]+)/).pop(); 

  // make sure database exists
  this._createUserSharesDatabase();

  this.feed = this.couchConnection.database(databaseName).changes({include_docs:true});
  this.feed.on("change", this._changeCallback.bind(this));
  this.feed.on("error",  this._errorCallback.bind(this));
};


UserSharesDbWorker.prototype = {

  // 
  // 
  // 
  _createUserSharesDatabase: function()
  {
    this.couchConnection.database(this.databaseName).create( function(error) {
      if (error) {
        console.log("Error creating datbase %s.", this.databaseName);
        console.log(error);
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
    var readAccess  = shareDoc && (shareDoc.access.read || shareDoc.access),
        writeAccess = shareDoc && shareDoc.access.write,
        readers = [],
        writers = [],
        readersDeferred = Q.defer(),
        writersDeferred = Q.defer(),
        keys;

    // update readers
    switch (true) {
      case readAccess === true:
        readersDeferred.resolve([]);
        break;

      case readAccess === undefined:
      case readAccess === false:
        // share is private. Only owner has read access
        readersDeferred.resolve([this.owner]);
        break;

      case Array.isArray(readAccess):

        // share read only for passed user names
        // First, add owner to readers list
        this.couchConnection.database("_users").view('views/ownerByUsername', { keys: readAccess}, function(error, results) {
          var readers = [this.owner];

          // TOOD: handle errors

          results.forEach( function(result) { readers.push(result.value); });
          readersDeferred.resolve(readers);
        }.bind(this));
        break;
    }

    // update writers
    switch (true) {
      case writeAccess === true:
        writersDeferred.resolve([]);
        break;

      case writeAccess === undefined:
      case writeAccess === false:
        // Only owner has write access
        writersDeferred.resolve([this.owner]);
        break;

      case Array.isArray(writeAccess):

        // share write only for passed user names
        // First, add owner to writers list
        this.couchConnection.database("_users").view('views/ownerByUsername', { keys: writeAccess}, function(error, results) {
          var writers = [this.owner];

          // TOOD: handle errors

          results.forEach( function(result) { writers.push(result.value); });
          writersDeferred.resolve(writers);
        }.bind(this));
        break;
    }

    Q.when([readersDeferred.promise, writersDeferred.promise]).then(function(promises) {
      var readers = promises[0].valueOf(),
          writers = promises[1].valueOf();

      this._sendSecurityUpdateRequest(databaseName, readers, writers);
      this.shares[shareId] = shareDoc;
    }.bind(this));
  },


  // 
  // 
  // 
  _sendSecurityUpdateRequest: function(databaseName, readers, writers) {
    var options = {
      path   : '_security',
      method : 'PUT',
      json   : {
        readers: {
          roles: readers
        },
        writers: {
          roles: writers
        }
      }
    };

    this.couchConnection.database(databaseName).query(options, function(error, response) {

      // TODO: handle errors

      console.log("security created for %s", databaseName);
    }.bind(this));
  },


  // 
  // 
  // 
  _errorCallback: function(error) {
    console.log("error in WorkerShares");
    console.log( JSON.stringify(error, "", 2) );
  },


  // 
  // 
  // 
  _changeCallback: function(change) {
    // if somebody else made a change to one of our shared
    if (change.doc.$updatedBy !== this.owner) {
      // TODO:
      // 1. load object counterpart in user database (remove "share/uuid567/" from doc._id)
      // 2. If object exists, update it based on the docs $shares["shareId"] filter settings
      // 3. If object does not exist, create it. Add a $shares attribute.
    }
  },


  // 
  // 
  // 
  dropAllDatabases: function(change) {
    // this.feed.off("change", this._changeCallback.bind(this));
    // this.feed.off("error",  this._errorCallback.bind(this));

    this.couchConnection.database(this.databaseName).all({
      startkey     : "$share/",
      endkey       : "$share0",
      include_docs : true
    }, function(error, response) {
      var share_database;

      if (error) {
        console.log("Couldn't drop $share databases:");
        console.log("Error loading all $share docs from %s.", this.databaseName);
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
        console.log("Error creating share datbase %s.", share_databaseName);
        return;
      }

      this._updateAccessSettings(share_databaseName, shareDoc);

      this.couchConnection.database('_replicator').update("shares/start", replication1_name);
      this.couchConnection.database('_replicator').update("shares/start", replication2_name);
    }.bind(this));

    this.shares[share_databaseName] = shareDoc;
  },

  // 
  // 
  // 
  dropShare: function(share_databaseName)
  {
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
        console.log("Error loading objects belonging to %s from %s", doc._id, this.sharesDatabaseName);
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
  }
};


module.exports = UserSharesDbWorker;