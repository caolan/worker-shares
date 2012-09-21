/**
 *  UserDbWorker
 *  listens to changes on the user's private database
 */

var UserSharesDbWorker = require('./UserSharesDbWorker.js');

var UserDbWorker = function(database, couchConnection)
{
  this.databaseName         = database;
  this.couchConnection      = couchConnection;
  this.owner                = database.match(/^user\/([^\/]+)/).pop(); 
  this.sharesDatabaseName   = database + "/shares";
  this.sharesWorker         = new UserSharesDbWorker(this.sharesDatabaseName);

  this.feed = this.couchConnection.database(database).changes({include_docs:true});
  this.feed.on("change", this._changeCallback.bind(this));
  this.feed.on("error",  this._errorCallback.bind(this));
};

// map of users shares
UserDbWorker.prototype.shares = {};

UserDbWorker.prototype._errorCallback = function(error)
{
  if (error && error.message.indexOf("Database deleted after change") !== -1) {
    console.log("Database %s has been dropped.", this.databaseName);
    // this.feed.off("change", this._changeCallback.bind(this));
    // this.feed.off("error",  this._errorCallback.bind(this));
    this.sharesWorker.dropAllDatabases();
    return;
  } 

  console.log("error in WorkerShares");
  console.log( JSON.stringify(error, "", 2) );
};

UserDbWorker.prototype._changeCallback = function(change)
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

UserDbWorker.prototype._handleShareObjectUpdate = function(doc)
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

UserDbWorker.prototype._readSettingIsEqual = function(shareDoc1, shareDoc2) {
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

UserDbWorker.prototype._writeSettingIsEqual = function(shareDoc1, shareDoc2) {
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
UserDbWorker.prototype._handleSharedObjectUpdate = function(doc) {
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
        this.couchConnection.database(this.databaseName).query({
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
    console.log("Updating shared doc in %s/%s", this.sharesDatabaseName, encodeURIComponent(sharedDoc._id) + "?new_edits=false")
    console.log(sharedDoc)

    this.couchConnection.database(this.sharesDatabaseName).query({
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
UserDbWorker.prototype._prepareSharedDocUpdate = function(originalDoc, shareId) {
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
UserDbWorker.prototype._generateNewRevisionId = function() {
  var timestamp, uuid;

  this._timezoneOffset || (this._timezoneOffset = new Date().getTimezoneOffset() * 60);
  timestamp = Date.now() + this._timezoneOffset;
  uuid = this._uuid();

  return "" + uuid + "#" + timestamp;
};

UserDbWorker.prototype._uuid = function() {
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

module.exports = UserDbWorker;