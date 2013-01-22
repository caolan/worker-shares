var Q       = require("q"),
    url     = require("url"),
    fs      = require("fs"),
    cradle  = require("cradle");

var package_json = JSON.parse(fs.readFileSync("./package.json"));
// turn 'hoodie-worker-whatever' in 'whatever'
var workerName   = package_json.name.substr(14);


var InstallHelper = function(worker, config) {
  worker.name = workerName;
  worker.config = config;
  var install = new Install(worker);
  return install.assureInstallation().fail( install._handleError );
};

var Install = function(worker) {
  this.worker = worker;
  this.initCouchConnection();
};

Install.prototype = {
  initCouchConnection : function() {
    var options = url.parse(this.worker.config.server);

    if (this.worker.config.admin) {
      options.auth = {
        username: this.worker.config.admin.user,
        password: this.worker.config.admin.pass
      };
    }
    this.worker.couch = new(cradle.Connection)(options);
  },

  assureInstallation : function() {
    return this.readGlobalConfig().then( this.readWorkerConfig.bind(this) );
  },

  readGlobalConfig : function() {
    var defer = Q.defer();

    this.worker.couch.database('modules').get('global_config', function(error, object) {
      if (error) {
        error.context = 'readGlobalConfig';
        defer.reject(error);
        return;
      }

      this.setGlobalConfig(object.config);
      defer.resolve();
    }.bind(this));

    return defer.promise;
  },

  readWorkerConfig : function() {
    var defer = Q.defer();

    this.worker.couch.database('modules').get(this.worker.name, function(error, object) {
      if (error) {
        if (error.reason === "missing" || error.reason === "deleted") {

          this._log("/modules/%s not yet installed", this.worker.name);
          this.installMe().then( defer.resolve ).fail( defer.reject );

        } else {
          error.context = 'assureInstallation';
          defer.reject(error);
          return defer.promise;
        }
      } else {

        // already installed
        this._log("/modules/%s already installed.", this.worker.name);
        console.log(object);
        this.setWorkerConfig(object.config);
        defer.resolve();

      }
    }.bind(this));

    return defer.promise;
  },

  setGlobalConfig : function(object) {
    this.worker.config.app = object;
  },

  setWorkerConfig : function(object) {
    this.worker.config.user = object;
  },

  installMe : function() {
    return Q.all([
      this.createShareSkeleton(), 
      this.createDesignDocsInUsers(), 
      this.createDesignDocsInReplicator()
    ])
    .then( this.createDesignDocsInShareSkeleton.bind(this) )
    .then( this.createConfigInModulesDatabase.bind(this) )
  },

  createShareSkeleton: function() {
    var defer = Q.defer();

    this._log('creating skeleton/share database ...')
    this.worker.couch.database('skeleton/share').create( function(error) {
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
      promisify( this.worker.couch.database('skeleton/share'), 'save', 'createDesignDocsInShareSkeleton' )( docs[0] ),
      promisify( this.worker.couch.database('skeleton/share'), 'save', 'createDesignDocsInShareSkeleton' )( docs[1] )
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

    return promisify( this.worker.couch.database('_users'), 'save', 'createDesignDocsInUsers' )( doc )
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

    return promisify( this.worker.couch.database('_replicator'), 'save', 'createDesignDocsInReplicator' )( doc )
  },

  //    - create object in /modules
  createConfigInModulesDatabase : function() {
    this._log('creatinging object in modules database ...');

    var doc = {
      "_id"       : this.worker.name,
      "createdAt" : new Date(),
      "updatedAt" : new Date(),
      "config"    : {}
    };
    this.setWorkerConfig(doc.config);

    return promisify( this.worker.couch.database('modules'), 'save', 'createConfigInModulesDatabase' )( doc );
  },

  _handleError : function(error) {
    this._log("Something went wrong ... ");
    this._log("%j", error);
  },

  _log : function(message) {
    message = "["+this.worker.name+"Worker install] " + message;
    console.log.apply(null, arguments);
  }
}

// http://howtonode.org/promises
function promisify(context, nodeAsyncFnName, calledFrom) {
  return function() {
    var defer = Q.defer(),
        args = Array.prototype.slice.call(arguments);

    args.push(function(err, val) {

      if (err !== null) {
        err.context = calledFrom;
        return defer.reject(err);
      }

      return defer.resolve(val);
    });

    context[nodeAsyncFnName].apply(context, args);

    return defer.promise;
  };
}

module.exports = InstallHelper;