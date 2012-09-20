var request = require("request"),
    util    = require("util"),
    url     = require("url"),
    cradle  = require("cradle"),
    clone   = require("clone"),
    Q       = require("q"),
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

  couch.database("_users").changes({since: 0, include_docs: true})
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

  if (this.workers[change.doc.database])
    return;
  
  if (change.doc.$state !== 'confirmed')
    return;
  
  this.workers[change.doc.database] = new UserWorker(change.doc.database);

  // TO BE DONE:
  // this.workers[change.doc.database].on("drop", function() {
  //   delete this.workers[change.doc.database];
  // });
};


/////////////////////////////////////////////////////////////////////////// 
// User Worker
// listens to changes on the user's private database
/////////////////////////////////////////////////////////////////////////// 
function UserWorker(database)
{
  this.database_name        = database;
  this.owner                = database.match(/^user\/([^\/]+)/).pop(); 
  this.shares_database_name = database + "/shares";
  this.sharesWorker         = new UserSharesWorker(this.shares_database_name);

  this.feed = couch.database(database).changes({include_docs:true});
  this.feed.on("change", this._changeCallback.bind(this));
  this.feed.on("error",  this._errorCallback.bind(this));
}

// map of users shares
UserWorker.prototype.shares = {};

UserWorker.prototype._errorCallback = function(error)
{
  if (error && error.message.indexOf("Database deleted after change") !== -1) {
    console.log("Database %s has been dropped.", this.database_name);
    // this.feed.off("change", this._changeCallback.bind(this));
    // this.feed.off("error",  this._errorCallback.bind(this));
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
  var shareId = doc._id.substr(1); // $share/123 => share/123

  // when a share gets deleted, remove its database, replications and objects
  if (doc._deleted && this.sharesWorker.shares[shareId]) {
    this.sharesWorker.dropShare(shareId);
    return;
  }

  // if this is a new share, create its database and replications
  if (! this.sharesWorker.shares[shareId]) {
    this.sharesWorker.createShare(shareId, doc);
    return;
  }

  // if this is a share update
  if (this.sharesWorker.shares[shareId]) {
    if(! this._readSettingIsEqual(this.sharesWorker.shares[shareId], doc) || ! this._writeSettingIsEqual(this.sharesWorker.shares[shareId], doc)) {
      this.sharesWorker._updateAccessSettings(shareId, doc);
    }
  }
};

UserWorker.prototype._readSettingIsEqual = function(shareDoc1, shareDoc2) {
  var settings1 = shareDoc1.read || shareDoc1, 
      settings2 = shareDoc2.read || shareDoc2;

  if (settings1 === settings2)
    return true;

  if (Array.isArray(settings1) && Array.isArray(settings2)) {
    // simple array comparision that works for us:
    // http://stackoverflow.com/a/5115066/206879
    settings1.sort();
    settings2.sort();
    return ! (settings1<settings2 || settings2<settings1);
  }
};

UserWorker.prototype._writeSettingIsEqual = function(shareDoc1, shareDoc2) {
  var settings1 = shareDoc1.write, 
      settings2 = shareDoc2.write;

  if (settings1 === settings2)
    return true;

  if (Array.isArray(settings1) && Array.isArray(settings2)) {
    // simple array comparision that works for us:
    // http://stackoverflow.com/a/5115066/206879
    settings1.sort();
    settings2.sort();
    return ! (settings1<settings2 || settings2<settings1);
  }
};

// 
// we use the new_edits=false flag for our updates, so that we don't need
// to fetch the document before updating it. Conflicts become possible, but
// that's something we can take care of at another place.
// 
UserWorker.prototype._handleSharedObjectUpdate = function(doc) {
  var shareId, sharedDoc, filter, attribute;


  for(shareId in doc.$shares) {
    filter    = doc.$shares[shareId];
    sharedDoc = this._prepareSharedDocUpdate(doc, shareId);

    console.log("filter: %s", filter);

    switch(filter) {

      case false: 

        // stop sharing object
        sharedDoc._deleted = true;

        // update original doc in user database
        delete doc.$shares[shareId];
        if ( Object.keys(doc.$shares).length === 0)
          delete doc.$shares;
        couch.database(this.database_name).query({
          method: 'PUT', 
          path: encodeURIComponent(doc._id) + "?new_edits=false",
          body: doc
        }); // TODO: handle error
        break;

      case true: 

        // share entire object
        for (var key in doc) {
          if (typeof sharedDoc[key] === 'undefined' && key !== '$shares') {
            sharedDoc[key] = doc[key];
          }
        }
        break;

      default: 

        // when filter is an Array, share only the passed Attributes
        for (var i = 0; i < filter.length; i++) {
          attribute = filter[i];
          sharedDoc[attribute] = doc[attribute];
        }
    }

    // create / update / remove object in / from shares database
    console.log("Updating shared doc in %s/%s", this.shares_database_name, encodeURIComponent(sharedDoc._id) + "?new_edits=false")
    console.log(sharedDoc)

    couch.database(this.shares_database_name).query({
      method : 'PUT', 
      path   : encodeURIComponent(sharedDoc._id) + "?new_edits=false", 
      body   : sharedDoc
    }); // TODO: handle error
  }
};

// 
// prepare update for shared doc
// 
// 1. prefix _id with "$share/{shareId}"
// 2. generate new _rev and add past and current _red ID in _revisions,
//    as we use `new_edits=false` flag
// 
UserWorker.prototype._prepareSharedDocUpdate = function(originalDoc, shareId) {
  var sharedDoc, currentRevNr, currentRevId, newRevisionId;

  if (originalDoc._rev) {
    currentRevNr = parseInt(originalDoc._rev, 10);
    currentRevId = originalDoc._rev.split(/-/).pop();
  } else {
    currentRevNr = 0;
  }

  newRevisionId = this._generateNewRevisionId();

  sharedDoc = {
    _id        : "$share/" + shareId + "/" + originalDoc._id,
    _rev       : '' + (currentRevNr + 1) + '-' + newRevisionId,
    _revisions : { start : 1, ids : [newRevisionId]},
    $createdBy : originalDoc.$createdBy,
    $updatedBy : this.owner,
    $createdAt : originalDoc.$createdAt,
    $updatedAt : originalDoc.$updatedAt
  };

  if (originalDoc._rev) {
    sharedDoc._revisions.start += currentRevNr;
    sharedDoc._revisions.ids.push(currentRevId);
  }

  return sharedDoc;
};

// 
// 
// 
UserWorker.prototype._generateNewRevisionId = function() {
  var timestamp, uuid;

  this._timezoneOffset || (this._timezoneOffset = new Date().getTimezoneOffset() * 60);
  timestamp = Date.now() + this._timezoneOffset;
  uuid = this._uuid();

  return "" + uuid + "#" + timestamp;
};

UserWorker.prototype._uuid = function() {
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
};


/////////////////////////////////////////////////////////////////////////// 
// User Shares Worker
// listens to changes on the user's shares database
/////////////////////////////////////////////////////////////////////////// 
function UserSharesWorker(database_name)
{
  this.shares = {};
  this.database_name = database_name;

  // "user/hash345/shares" => "hash345"
  this.owner = database_name.match(/^user\/([^\/]+)/).pop(); 

  // make sure database exists
  this._createUserSharesDatabase();

  this.feed = couch.database(database_name).changes({include_docs:true});
  this.feed.on("change", this._changeCallback.bind(this));
  this.feed.on("error",  this._errorCallback.bind(this));
}

// 
// 
// 
UserSharesWorker.prototype._createUserSharesDatabase = function()
{
  couch.database(this.database_name).create( function(error) {
    if (error) {
      console.log("Error creating datbase %s.", this.database_name);
      console.log(error);
      return;
    }

    // this method is usually used for the individual share databases, but it
    // works perfectly fine for the shares database as well
    this._updateAccessSettings(this.database_name, {access: false});
  }.bind(this));
};

// 
// Only the user is allowed to access his shares database
// 
UserSharesWorker.prototype._updateAccessSettings = function(database_name, shareDoc) {
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
      couch.database("_users").view('views/ownerByUsername', { keys: readAccess}, function(error, results) {
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
      couch.database("_users").view('views/ownerByUsername', { keys: writeAccess}, function(error, results) {
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


    console.log("")
    console.log("Q resolved!")
    console.log("_sendSecurityUpdateRequest")
    console.log("database_name %s", database_name)
    console.log("readers %s",readers)
    console.log("writers %s", writers)
    console.log("")
    this._sendSecurityUpdateRequest(database_name, readers, writers);
    this.shares[shareId] = shareDoc;
  }.bind(this));
};

UserSharesWorker.prototype._sendSecurityUpdateRequest = function(database_name, readers, writers) {
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

  couch.database(database_name).query(options, function(error, response) {

    // TODO: handle errors

    console.log("security created for %s", database_name);
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
  // this.feed.off("change", this._changeCallback.bind(this));
  // this.feed.off("error",  this._errorCallback.bind(this));

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
      if (row.doc.$type === '$share' && row.doc.$owner === this.owner) {
        this.dropShare(row.id.substr(1)); // $share/123 => share/123
      }
    }

    couch.database(this.database_name).destroy();
  }.bind(this));
  // get all $share objects and drop their databases and replications,
  // then:
  // couch.database(this.database_name).destroy();
};

// 
// 
// 
UserSharesWorker.prototype.dropShare = function(share_database_name)
{
  var replication1_name = this.database_name + " => " + share_database_name,
      replication2_name = share_database_name + " => " + this.database_name;

  couch.database('_replicator').update("shares/stop", replication1_name);
  couch.database('_replicator').update("shares/stop", replication2_name);
  couch.database(share_database_name).destroy();

  couch.database(this.database_name).all({
    startkey: "$" + share_database_name + "/",
    endkey: "$" + share_database_name + "0"
  }, function(error, response) {
    var docsToDelete = [];
    if (error) {
      console.log("Error loading objects belonging to %s from %s", doc._id, this.shares_database_name);
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
    couch.database(this.shares_database_name).save(docsToDelete);
  }.bind(this)); 
};

// 
// 
//
UserSharesWorker.prototype.createShare = function(share_database_name, shareDoc)
{
  // TODO:
  // create _design doc in share database to mirror the share writer settings
  // create continuous replications as needed
  // upate $state attribute

  var replication1_name = this.database_name + " => " + share_database_name,
      replication2_name = share_database_name + " => " + this.database_name;

  couch.replicate({
    source        : "skeleton/share",
    target        : share_database_name,
    create_target : true
  }, function(error) {
    if (error) {
      console.log("Error creating share datbase %s.", share_database_name);
      return;
    }

    this._updateAccessSettings(share_database_name, shareDoc);

    couch.database('_replicator').update("shares/start", replication1_name);
    couch.database('_replicator').update("shares/start", replication2_name);
  }.bind(this));

  this.shares[share_database_name] = shareDoc;
};


// TODOs / next steps
// 
// 1. copy objects belonging to $shares from userDB => userSharesDB
// 2. create database and continuous replicatiosn for new $share objects
// 3. tricky one:
//    when changes to objects by others get replicate to a userSharesDB, copy the 
//    changes over to the userDB. Tricky part will be to distinguish between changes
//    my own changes and changes by others.
//    Idea: when copying objects from userDB => userSharesDB, add a $lastChangeBy
//          attribute, set to user's owner hash. Then do only replicate copy
//          userSharesDB => userDB when $lastChangeBy != user's owner hash