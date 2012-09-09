var request = require("request");
var util    = require("util");
var url     = require("url");
var cradle  = require("cradle");

module.exports = WorkerUserDatabases;

function WorkerShares(config)
{
  var options  = url.parse(config.server);
  options.auth = {
    username: config.admin.user,
    password: config.admin.pass
  };

  this._config = config;
  this._couch  = new(cradle.Connection)(options);
  this.userDb  = this._couch.database("_users");

  var feed    = this.userDb.changes({include_docs:true});

  feed.on("change", this._changeCallback.bind(this));
  feed.on("error",  this._errorCallback.bind(this));
}

//
// report errors nicely
//
WorkerShares.prototype._errorCallback = function(error) {
  if(error !== null) {
    console.log("error in WorkerUserDatabases");
    console.log( JSON.stringify(error, "", 2) );
    return;
  }
};

WorkerUserDatabases.prototype._changeCallback = function(change) {
  
};