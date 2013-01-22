var Q = require("q");

var Install = function(couch, callbackWhenInstalled) {
  
  // 1. check if /modules/shares exists in couch
  //    if it does, call callbackWhenInstalled()
  //    otherwise run installMe
  //
  // 2. in installMe:
  //
  //    - create skeleton/share
  //    - create design docs in skeleton/share
  //    - create design docs in _users
  //    - create design docs in _replicator
  //    - create object in /modules
  //    - call callbackWhenInstalled()
  // 


  this.couch    = couch
  this.whenDone = callbackWhenInstalled

  this.assureInstallation().then( this.whenDone ).fail( this._handleError.bind(this) )
};

Install.prototype = {
  assureInstallation: function() {
    var defer = Q.defer();

    this.couch.database('modules').get('shares', function(error, object) {
      if (error) {
        if (error.reason === "missing" || error.reason === "deleted") {

          this._log("/modules/shares not yet installed")
          this.installMe().then( defer.resolve ).fail( defer.reject )

        } else {
          error.context = 'assureInstallation'
          defer.reject(error)
          return defer.promise
        }
      } else {
        // already installed
        this._log("/modules/shares already installed.")
        defer.resolve()
      }
    }.bind(this))

    return defer.promise
  },

  installMe: function() {
    this._log("installMe ...")

    return Q.all([
      this.createShareSkeleton(), 
      this.createDesignDocsInUsers(), 
      this.createDesignDocsInReplicator()
    ])
    .then( this.createDesignDocsInShareSkeleton.bind(this) )
    .then( this.createObjectInModules.bind(this) )
  },

  createShareSkeleton: function() {
    var defer = Q.defer();

    this._log('creating skeleton/share database ...')
    this.couch.database('skeleton/share').create( function(error) {
      if (! error) {
        this._log('skeleton/share database created ...')
        defer.resolve();
        return
      }
        

      if (error.error === 'file_exists') {
        this._log('skeleton/share already exists ...')
        defer.resolve()
      } else {
        error.context = 'createShareSkeleton'
        defer.reject(error)
      }
    }.bind(this))

    
    return defer.promise
  },

  createDesignDocsInShareSkeleton: function() {
    this._log('creatinging design docs in skeleton/share database ...')
    var docs = [
      {
        "_id": "_design/filters",
        "filters": {
             "share": "function(doc, req) { return doc._id.indexOf(req.query.share_id) === 6  };"
        }
      },
      {
        "_id": "_design/write_access",
        "validate_doc_update": "function(newDocument, oldDocument, userContext, securityObject) {   if (!securityObject.writers || securityObject.writers.roles.length === 0) return;   if (userContext.roles.indexOf('_admin') !== -1) return;  for (var i = 0; i < securityObject.writers.roles.length; i++) {     log('securityObject.writers.roles[' + i + ']: ' + securityObject.writers.roles[i]);    for (var j = 0; j < userContext.roles.length; j++) {       log('userContext.roles['+j+']: ' + userContext.roles[j]);      if (securityObject.writers.roles[i] === userContext.roles[j]) return;     }   }   throw({forbidden: 'you are not allowed edit objects in ' + userContext.db}); };"
      }
    ]
    return Q.all([
      promisify( this.couch.database('skeleton/share'), 'save', 'createDesignDocsInShareSkeleton' )( docs[0] ),
      promisify( this.couch.database('skeleton/share'), 'save', 'createDesignDocsInShareSkeleton' )( docs[1] )
    ])
  },

  //    - create design docs in _users
  createDesignDocsInUsers: function() {
    this._log('creatinging design docs in _users database ...')
    var doc = {
      "_id": "_design/views",
      "views": {
        "ownerByUsername": {
          "map": "function(doc) { var username; if (doc.ownerHash) { username = doc.name.replace(/^user(_anonymous)?\\//, ''); emit(username, doc.ownerHash); }; };"
        }
      }
    }

    return promisify( this.couch.database('_users'), 'save', 'createDesignDocsInUsers' )( doc )
  },

  //    - create design docs in _replicator
  createDesignDocsInReplicator: function() {
    this._log('creatinging design docs in _replicator database ...')
    var doc = {
      "_id": "_design/shares",
      "updates": {
        "stop": "function(doc, req) { log('stopping replication ' + doc._id); doc._deleted = true; return [doc, \"OK\"] };",
        "start": "function(doc, req) { var dbs, share_id; if (! doc) doc = {}; doc._id = req.id; dbs = req.id.split(' => '); doc.source = dbs[0]; doc.target = dbs[1]; doc.continuous = true; doc.user_ctx = {name: req.userCtx.name, roles: req.userCtx.roles}; doc.$createdAt = doc.$updatedAt = JSON.stringify(new Date); for (var key in req.query) { doc[key] = req.query[key]; }; share_id = req.id.match('share/([0-9a-z]+)').pop(); doc.query_params = {}; doc.query_params.share_id = share_id; return [doc, \"OK\"] };"
      }
    }

    return promisify( this.couch.database('_replicator'), 'save', 'createDesignDocsInReplicator' )( doc )
  },

  //    - create object in /modules
  createObjectInModules: function() {
    this._log('creatinging object in modules database ...')
    var doc = {
      "_id": "shares",
      "createdAt": new Date,
      "updatedAt": new Date,
      "config": {}
    }

    return promisify( this.couch.database('modules'), 'save', 'createObjectInModules' )( doc )
  },

  _handleError: function(error) {
    this._log("Something went wrong ... ")
    this._log("%j", error)
  },

  _log: function() {
    arguments[0] = "[WorkerShares install] " + arguments[0];
    console.log.apply(null, arguments)
  }
}

// http://howtonode.org/promises
function promisify(context, nodeAsyncFnName, calledFrom) {
  return function() {
    var defer = Q.defer()
      , args = Array.prototype.slice.call(arguments);

    args.push(function(err, val) {

      if (err !== null) {
        err.context = calledFrom
        return defer.reject(err);
      }


      console.log("OHAJ FROM promisify %s", calledFrom)
      return defer.resolve(val);
    });

    context[nodeAsyncFnName].apply(context, args);

    return defer.promise;
  };
};


module.exports = Install;