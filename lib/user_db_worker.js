/**
 *  UserDbWorker
 *  listens to changes on the user's private database
 */
var UserSharesDbWorker = require('./user_shares_db_worker.js');
var util          = require('util');
var HoodieWorker  = require('hoodie-worker');

var UserDbWorker = function(databaseName, couch) {
  this._log('starting for %s', databaseName)
  
  this.databaseName         = databaseName;
  this.couch                = couch;

  this.owner                = databaseName.match(/^user\/([^\/]+)/).pop();
  this.sharesDatabaseName   = databaseName + "/shares";
  
  // give it a 1 sec timeout, otherwise I get very strange errors like
  // "users/abc/shares cannot be created, it alread exists" although it does not.
  setTimeout( function() {
    this.sharesWorker         = new UserSharesDbWorker(this.sharesDatabaseName, this.couch);
    this.feed = this.couch.database(databaseName).changes({include_docs:true});
    this.feed.on("change", this._handleChange.bind(this));
    this.feed.on("error",  this._handleChangeError.bind(this));
  }.bind(this), 1000)
};
util.inherits(UserDbWorker, HoodieWorker);



// map of users shares
UserDbWorker.prototype.shares = {}

//
// handle errors occuring when listening to userDb's changes feed.
// A special event we look for is when a database has been dropped
// 
UserDbWorker.prototype._handleChangeError = function(error) {
  if (error && error.message.indexOf("Database deleted after change") !== -1) {
    this._log("Database %s has been dropped.", this.databaseName);
    // this.feed.off("change", this._handleChange.bind(this));
    // this.feed.off("error",  this._handleChangeError.bind(this));
    
    return;
  } 

  this._log("error in Worker: %j", error);
}

// 
// handler for changes in the userDb
// The two kind of objects are
// 
// 1. $share objects
// 2. objects that belong to one or multiple shares
// 
UserDbWorker.prototype._handleChange = function(change) {
  var doc = change.doc;

  this._log('_handleChange: %j', doc)
  if (doc.$type === "$share") {
    this._handleShareObjectUpdate(doc);
    return;
  }

  if (doc.$shares) {
    this._log('%s !== %s', doc.$updatedBy, this.owner)

    if (doc.$updatedBy && doc.$updatedBy !== this.owner) {
      // updates with updatedBy != my hash have been copied over
      // from my shares db. I don't want to copy them back again
      // this would end up in endless recursion.
      return
    }
    this._handleSharedObjectUpdate(doc)
  }
}

// 
// handling changes to a $share object
// 
UserDbWorker.prototype._handleShareObjectUpdate = function(doc) {

  var shareId = doc._id.substr(1); // $share/123 => share/123

  // if (doc.$createdBy === '$subscription') {
  if (this.sharesWorker.shares[shareId] && this.sharesWorker.shares[shareId].$createdBy !== this.owner) {
    this._log("Subscription Update: %s", shareId)
    
    // when a share gets deleted, remove its database, replications and objects
    if (doc._deleted) {
      this.sharesWorker.unsubscribeFromShare(shareId);
      return;
    }

    this.sharesWorker.subscribeToShare(shareId);
  } else {

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
      this._log('_updateAccessSettings for ' + shareId + '?')
      if(this._accessSettingsChanged(this.sharesWorker.shares[shareId], doc)) {
        this.sharesWorker._updateAccessSettings(shareId, doc);
      } else {
        this._log('nope. no security changes found for ' + shareId + '!')
      }
    }
  }
}

// 
// helper methods to check if access settings changed
// 
UserDbWorker.prototype._accessSettingsChanged = function(shareDoc1, shareDoc2) {
  return !this._readAccessSettingIsEqual(shareDoc1, shareDoc2) || !this._writeAccessSettingIsEqual(shareDoc1, shareDoc2);
}
UserDbWorker.prototype._readAccessSettingIsEqual = function(shareDoc1, shareDoc2) {
  var settings1 = shareDoc1.read || shareDoc1, 
      settings2 = shareDoc2.read || shareDoc2;

  this._accessSettingIsEqual(settings1, settings2);
}
UserDbWorker.prototype._writeAccessSettingIsEqual = function(shareDoc1, shareDoc2) {
  var settings1 = shareDoc1.write, 
      settings2 = shareDoc2.write;

  this._accessSettingIsEqual(settings1, settings2);
}
UserDbWorker.prototype._accessSettingIsEqual = function(settings1, settings2) {
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
// handle updates of objects that belong to one or multiple shares.
// 
// we use the new_edits=false flag for our updates, so that we don't need
// to fetch the document before updating it. Conflicts become possible, but
// that's something we can take care of at another place.
// 
UserDbWorker.prototype._handleSharedObjectUpdate = function(doc) {
  var shareId, sharedObject, filter, attribute, options;

  this._log('_handleSharedObjectUpdate')
  for(shareId in doc.$shares) {

    filter    = doc.$shares[shareId];
    this._log('shareId %s with filter %j', shareId, filter)
    sharedObject = this._prepareSharedDocUpdate(doc, shareId);

    switch(filter) {

      case false: 

        // stop sharing object
        sharedObject._deleted = true;

        // update original doc in user database
        delete doc.$shares[shareId];
        if ( Object.keys(doc.$shares).length === 0)
          delete doc.$shares;

        this.couch.database(this.databaseName)
        .save(doc._id, doc._rev, doc); // TODO: handle error
        break;

      case true: 

        // share entire object
        for (var key in doc) {
          if (typeof sharedObject[key] === 'undefined' && key !== '$shares') {
            sharedObject[key] = doc[key];
          }
        }
        break;

      default: 

        // when filter is an Array, share only the passed Attributes
        for (var i = 0; i < filter.length; i++) {
          attribute = filter[i];
          sharedObject[attribute] = doc[attribute];
        }
    }

    // create / update / remove object in / from shares database
    this._updateSharedObject(sharedObject)
  }
}

UserDbWorker.prototype._updateSharedObject = function(sharedObject) {
  this._log('_updateSharedObject: %s', sharedObject._id)
  options = {
    method : 'PUT', 
    path   : encodeURIComponent(sharedObject._id) + "?new_edits=false", 
    body   : sharedObject
  }
  this.couch.database(this.sharesDatabaseName).query(options, function(error) {
    if (error) {
      this._log("ERROR: Couldn't PUT %s in %s: %j", sharedObject._id, this.sharesDatabaseName, error)
      return;
    } 

    this._log("SUCCESS PUT " + sharedObject._id + " in " + this.sharesDatabaseName)
  }.bind(this));
}

// 
// prepare update for shared doc
// 
// 1. prefix _id with "share/{shareId}"
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
    _id        : "share/" + shareId + "/" + originalDoc._id,
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
}

// 
// 
// 
UserDbWorker.prototype._generateNewRevisionId = function() {
  var timestamp, uuid;

  if (! this._timezoneOffset)
    this._timezoneOffset = new Date().getTimezoneOffset() * 60;

  timestamp = Date.now() + this._timezoneOffset;
  uuid = this._uuid();

  return "" + uuid + "#" + timestamp;
}

// 
// 
// 
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
}

UserDbWorker.prototype._log = function() {
  arguments[0] = "[" + this.databaseName + "Worker] " + arguments[0];
  console.log.apply(null, arguments)
}

module.exports = UserDbWorker;