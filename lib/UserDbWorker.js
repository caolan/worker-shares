/**
 *  UserDbWorker
 *  listens to changes on the user's private database
 */

var UserSharesDbWorker = require('./UserSharesDbWorker.js');

var UserDbWorker = function(databaseName, couchConnection) {
  this.databaseName         = databaseName;
  this.couchConnection      = couchConnection;

  this.owner                = databaseName.match(/^user\/([^\/]+)/).pop();
  this.sharesDatabaseName   = databaseName + "/shares";
  this.sharesWorker         = new UserSharesDbWorker(this.sharesDatabaseName, this.couchConnection);

  this.feed = this.couchConnection.database(databaseName).changes({include_docs:true});
  this.feed.on("change", this._handleChange.bind(this));
  this.feed.on("error",  this._handleChangeError.bind(this));
};

UserDbWorker.prototype = {

  // map of users shares
  shares: {},

  //
  // handle errors occuring when listening to userDb's changes feed.
  // A special event we look for is when a database has been dropped
  // 
  _handleChangeError: function(error) {
    if (error && error.message.indexOf("Database deleted after change") !== -1) {
      console.log("Database %s has been dropped.", this.databaseName);
      // this.feed.off("change", this._handleChange.bind(this));
      // this.feed.off("error",  this._handleChangeError.bind(this));
      this.sharesWorker.dropAllDatabases();
      return;
    } 

    console.log("error in WorkerShares");
    console.log( JSON.stringify(error, "", 2) );
  },

  // 
  // handler for changes in the userDb
  // The two kind of objects are
  // 
  // 1. $share objects
  // 2. objects that belong to one or multiple shares
  // 
  _handleChange: function(change) {

    if (change.doc.$type === "$share") {
      this._handleShareObjectUpdate(change.doc);
      return;
    }

    if (change.doc.$shares) {
      this._handleSharedObjectUpdate(change.doc)
    }
  },

  // 
  // handling changes to a $share object
  // 
  _handleShareObjectUpdate: function(doc) {
    console.log('_handleShareObjectUpdate!')

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
      console.log('_updateAccessSettings for ' + shareId + '?')
      console.log('this.sharesWorker.shares[' + shareId + ']:')
      console.log(JSON.stringify(this.sharesWorker.shares[shareId], '', 2))
      console.log('doc:')
      console.log(JSON.stringify(doc, '', 2))
      if(this._accessSettingsChanged(this.sharesWorker.shares[shareId], doc)) {
        this.sharesWorker._updateAccessSettings(shareId, doc);
      } else {
        console.log('nope. no _updateAccessSettings for ' + shareId + '!')
      }
    }
  },

  // 
  // helper methods to check if access settings changed
  // 
  _accessSettingsChanged: function(shareDoc1, shareDoc2) {
    return !this._readAccessSettingIsEqual(shareDoc1, shareDoc2) || !this._writeAccessSettingIsEqual(shareDoc1, shareDoc2);
  },
  _readAccessSettingIsEqual: function(shareDoc1, shareDoc2) {
    var settings1 = shareDoc1.read || shareDoc1, 
        settings2 = shareDoc2.read || shareDoc2;

    this._accessSettingIsEqual(settings1, settings2);
  },
  _writeAccessSettingIsEqual: function(shareDoc1, shareDoc2) {
    var settings1 = shareDoc1.write, 
        settings2 = shareDoc2.write;

    this._accessSettingIsEqual(settings1, settings2);
  },
  _accessSettingIsEqual: function(settings1, settings2) {
    if (settings1 === settings2)
      return true;

    if (Array.isArray(settings1) && Array.isArray(settings2)) {
      // simple array comparision that works for us:
      // http://stackoverflow.com/a/5115066/206879
      settings1.sort();
      settings2.sort();
      return ! (settings1<settings2 || settings2<settings1);
    }
  },

  // 
  // handle updates of objects that belong to one or multiple shares.
  // 
  // we use the new_edits=false flag for our updates, so that we don't need
  // to fetch the document before updating it. Conflicts become possible, but
  // that's something we can take care of at another place.
  // 
  _handleSharedObjectUpdate: function(doc) {
    var shareId, sharedDoc, filter, attribute, options;

    for(shareId in doc.$shares) {
      filter    = doc.$shares[shareId];
      sharedDoc = this._prepareSharedDocUpdate(doc, shareId);

      switch(filter) {

        case false: 

          // stop sharing object
          sharedDoc._deleted = true;

          // update original doc in user database
          delete doc.$shares[shareId];
          if ( Object.keys(doc.$shares).length === 0)
            delete doc.$shares;

          this.couchConnection.database(this.databaseName)
          .save(doc._id, doc._rev, doc); // TODO: handle error
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
      options = {
        method : 'PUT', 
        path   : encodeURIComponent(sharedDoc._id) + "?new_edits=false", 
        body   : sharedDoc
      }
      this.couchConnection.database(this.sharesDatabaseName).query(options, function(error) {
        if (error) {
          console.log("ERROR: Couldn't PUT " + sharedDoc._id + " in " + this.sharesDatabaseName)
          console.log(JSON.stringify(error,'',2))
          console.log("")
          return;
        } 

        console.log("SUCCESS PUT " + sharedDoc._id + " in " + this.sharesDatabaseName)
      }.bind(this));
    }
  },

  // 
  // prepare update for shared doc
  // 
  // 1. prefix _id with "share/{shareId}"
  // 2. generate new _rev and add past and current _red ID in _revisions,
  //    as we use `new_edits=false` flag
  // 
  _prepareSharedDocUpdate: function(originalDoc, shareId) {
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
  },

  // 
  // 
  // 
  _generateNewRevisionId: function() {
    var timestamp, uuid;

    if (! this._timezoneOffset)
      this._timezoneOffset = new Date().getTimezoneOffset() * 60;

    timestamp = Date.now() + this._timezoneOffset;
    uuid = this._uuid();

    return "" + uuid + "#" + timestamp;
  },

  // 
  // 
  // 
  _uuid: function() {
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
};

module.exports = UserDbWorker;