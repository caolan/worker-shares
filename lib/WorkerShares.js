var request = require("request"),
    util    = require("util"),
    url     = require("url"),
    cradle  = require("cradle"),
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


// 
// User Worker
// listens to changes on the user's private database
// 

function UserWorker(database)
{
  this.database_name = database;
  this.sharesWorker = new UserSharesWorker("#{database}/shares");

  this.feed = couch.database(database).changes({include_docs:true});
  this.feed.on("change", this._changeCallback.bind(this));
  this.feed.on("error",  this._errorCallback.bind(this));
}

UserWorker.prototype._errorCallback = function(error)
{
  if (error.indexOf("Database deleted after change") !== -1) {
    console.log("Database %s has been dropped.", this.database_name);
    this.feed.off("change", this._changeCallback.bind(this));
    this.feed.off("error",  this._errorCallback.bind(this));
    this.sharesWorker.dropAllDatabases();
  } else {
    console.log("error in WorkerShares");
    console.log( JSON.stringify(error, "", 2) );
    return;
  }
};

UserWorker.prototype._changeCallback = function(change)
{
  // check for shares in here ...
};

// 
// User Shares Worker
// listens to changes on the user's shares database
// 
function UserSharesWorker(database)
{
  this.database_name = database;

  // make sure database exists
  couch.database(database).create();

  this.feed = couch.database(database).changes({include_docs:true});
  this.feed.on("change", this._changeCallback.bind(this));
  this.feed.on("error",  this._errorCallback.bind(this));
}
UserSharesWorker.prototype._errorCallback = function(error)
{
  console.log("error in WorkerShares");
  console.log( JSON.stringify(error, "", 2) );
};

UserSharesWorker.prototype._changeCallback = function(change)
{
  // check for shares in here ...
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