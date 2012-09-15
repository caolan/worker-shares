var request = require("request"),
    util    = require("util"),
    url     = require("url"),
    cradle  = require("cradle"),
    clone   = require("clone"),
    couch;

module.exports = WorkerShares;

// Listen to changes in _users database and start 
// new share workers for confirmed sign ups
function WorkerShares(config)
{
  var options = url.parse(config.server);
  options.auth = {
    username: config.admin.user,
    password: config.admin.pass
  };
  couch = new(cradle.Connection)(options);
  this.workers = {};

  couch.database("_users").changes({since: 0})
  .on("change", this._changeCallback.bind(this))
  .on("error",  this._errorCallback.bind(this));
}
WorkerShares.prototype._errorCallback = function(error)
{
  console.log("error in WorkerShares");
  console.log( JSON.stringify(error, "", 2) );
};

WorkerShares.prototype._changeCallback = function(change)
{
  if (! change.doc.database)
    return;

  if (change.deleted)
    return;

  if (workers[change.doc.database])
    return;
  
  if (change.doc.$state !== 'confirmed')
    return;
  
  workers[change.doc.database] = new UserWorker(change.doc.database);

  // TO BE DONE:
  // workers[change.doc.database].on("drop", function() {
  //   delete workers[change.doc.database];
  // });
};


/////////////////////////////////////////////////////////////////////////// 
// User Worker
// listens to changes on the user's private database
/////////////////////////////////////////////////////////////////////////// 
function UserWorker(database)
{
  this.database_name        = database;
  this.owner                = database.match(/^funky\/([^\/]+)/).pop(); 
  this.shares_database_name = "#{database}/shares";
  this.sharesWorker         = new UserSharesWorker(this.shares_database_name);

  this.feed = couch.database(database).changes({include_docs:true});
  this.feed.on("change", this._changeCallback.bind(this));
  this.feed.on("error",  this._errorCallback.bind(this));
}

// map of users shares
UserWorker.prototype.shares = {};

UserWorker.prototype._errorCallback = function(error)
{
  if (error.indexOf("Database deleted after change") !== -1) {
    console.log("Database %s has been dropped.", this.database_name);
    this.feed.off("change", this._changeCallback.bind(this));
    this.feed.off("error",  this._errorCallback.bind(this));
    this.sharesWorker.dropAllDatabases();
    return;
  } 

  console.log("error in WorkerShares");
  console.log( JSON.stringify(error, "", 2) );
};

UserWorker.prototype._changeCallback = function(change)
{
  if (change.doc.type === "$share") {
    this._handleShareObjectUpdate(change.doc);
    return;
  }

  if (change.doc.$shares) {
    this._handleSharedObjectUpdate(change.doc);
    return;
  }
};

UserWorker.prototype._handleShareObjectUpdate = function(doc)
{
  if (doc._deleted) {

    // if we know this share
    if (this.shares[doc._id]) {
      // TODO:
      // drop share database, delete all docs belonging to share.
    }

    return;
  }

  // if this is a new share
  if (! this.shares[doc._id]) {
    // TODO:
    // create share database
    // set _security of share database to mirror the share reader settings
    // create _design doc in share database to mirror the share writer settings
    // create continuous replications as needed
    // upate $state attribute
    return;
  }

  // if this is a share update
  if (this.shares[doc._id]) {
    // TODO
    // compare the share we know to the update. If something changed to its settings
    // update the _design doc and / or the _security settings of the share database.
  }
};


UserWorker.prototype._handleSharedObjectUpdate = function(doc) {
  var shareId, sharedDoc, filter, attribute;

  for(shareId in doc.$shares) {
    filter = doc.$shares[shareId];

    switch(filter) {

      case false: // stop sharing object
        delete doc.$shares[shareId];
        // TODO
        // 1. remove object from shares database
        // 2. update object in user database
        break;

      case true: // share entire object
        sharedDoc = clone(doc);
        sharedDoc._id = "$share/" + shareId + "/" + doc._id;
        delete sharedDoc.$shares;
        sharedDoc.$updatedBy = this.owner;

        // TODO
        // create / update object in shares database
        break;

      default: // filter is an array of attributes to be shared
        sharedDoc = {
          _id        : "$share/" + shareId + "/" + doc._id,
          _rev       : doc._rev,
          _deleted   : doc._deleted,
          $updatedBy : this.owner,
          $createdAt : doc.$createdAt,
          $updatedAt : doc.$updatedAt
        };
        for (var i = 0; i < filter.length; i++) {
          attribute = filter[i];
          sharedDoc[attribute] = doc[attribute];
        }

        // TODO
        // create / update object in shares database
    }
  }
};


/////////////////////////////////////////////////////////////////////////// 
// User Shares Worker
// listens to changes on the user's shares database
/////////////////////////////////////////////////////////////////////////// 
function UserSharesWorker(database)
{
  this.database_name = database;

  // "user/hash345/shares" => "hash345"
  this.owner = database.match(/^funky\/([^\/]+)/).pop(); 

  // make sure database exists
  this._create();

  this.feed = couch.database(database).changes({include_docs:true});
  this.feed.on("change", this._changeCallback.bind(this));
  this.feed.on("error",  this._errorCallback.bind(this));
}

UserSharesWorker.prototype._create = function()
{
  couch.database(this.database_name).create( function(error) {
    if (error) {
      console.log("Error creating datbase %s.", this.database_name);
      return;
    }

    this._createDatabaseSecuritySetting();
  }.bind(this));
};

// 
// Only the user is allowed to access his shares database
// 
UserSharesWorker.prototype._createDatabaseSecuritySetting = function() {
  var options = {
    path   : '_security',
    method : 'PUT',
    json   : {
      admins: {
        names: [],
        roles: []
      },
      readers: {
        names:[],
        roles:[this.owner]
      }
    }
  };

  this._couch.database(this.database_name).query(options, function(error, response) {
    if(error) {
      console.log("error setting security for %s", this.database_name);
      return;
    }
    
    console.log("security created for %s", this.database_name);
  }.bind(this));
};

UserSharesWorker.prototype._errorCallback = function(error)
{
  console.log("error in WorkerShares");
  console.log( JSON.stringify(error, "", 2) );
};

UserSharesWorker.prototype._changeCallback = function(change)
{
  // if somebody else made a change to one of our shared
  if (change.doc.$updatedBy !== this.owner) {
    // TODO:
    // 1. load object counterpart in user database (remove "share/uuid567/" from doc._id)
    // 2. If object exists, update it based on the docs $shares["shareId"] filter settings
    // 3. If object does not exist, create it. Add a $shares attribute.
  }
};

UserSharesWorker.prototype.dropAllDatabases = function(change)
{
  this.feed.off("change", this._changeCallback.bind(this));
  this.feed.off("error",  this._errorCallback.bind(this));

  couch.database(this.database_name).all({
    startkey     : "$share/",
    endkey       : "$share0",
    include_docs : true
  }, function(error, response) {
    var share_database;

    if (error) {
      console.log("Couldn't drop $share databases:");
      console.log("Error loading all $share docs from %s.", this.database_name);
      return;
    }

    for (var i = 0; i < response.rows.length; i++) {
      row = response.rows[i];
      if (row.doc.$state === '$confirmed') {
        this.dropShareDatabase(row.id.substr(1)); // $share/123 => share/123
      }
    }

    couch.database(this.database_name).drop();
  }.bind(this));
  // get all $share objects and drop their databases and replications,
  // then:
  // couch.database(this.database_name).drop();
};

UserSharesWorker.prototype.dropShareDatabase = function(share_database)
{
  var replication1   = "#{this.database_name}  => #{share_database}",
      replication2   = "#{share_database} => #{this.database_name}";

  couch.database('_replicator').update("shares/cancel", replication1);
  couch.database('_replicator').update("shares/cancel", replication2);
  couch.database(share_database).drop(); 
};


// TODOs / next steps
// 
// 1. copy $share objects and objects belonging to $shares from userDB => userSharesDB
// 2. create database and continuous replicatiosn for new $share objects
// 3. tricky one:
//    when changes to objects by others get replicate to a userSharesDB, copy the 
//    changes over to the userDB. Tricky part will be to distinguish between changes
//    my own changes and changes by others.
//    Idea: when copying objects from userDB => userSharesDB, add a $lastChangeBy
//          attribute, set to user's owner hash. Then do only replicate copy
//          userSharesDB => userDB when $lastChangeBy != user's owner hash