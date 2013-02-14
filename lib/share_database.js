/**
 *  ShareDatabase
 *  creates, updates and removes share databases
 */
var ShareDatabase = function(shareObject, sharesDatabase) {
  this.id         = shareObject._id.substr(7);
  this.name       = "share/" + this.id
  this.properties = shareObject;

  this.sharesDatabase = sharesDatabase
  this.worker         = sharesDatabase.worker
  this.couch          = sharesDatabase.couch
  this.database       = sharesDatabase.couch.database(this.name)

  this.create()
  this.listenUp()
}


// 
// 
// 
ShareDatabase.prototype.listenUp = function() {
  this.sharesDatabase.on('share:object:update', this.handleUpdate.bind(this));
  this.sharesDatabase.on('share:object:remove', this.handleRemove.bind(this));
};


// 
// 
// 
ShareDatabase.prototype.handleUpdate = function( shareObject ) {
  this.properties = shareObject
};


// 
// 
// 
ShareDatabase.prototype.handleRemove = function() {
  
};


// 
// 
//
ShareDatabase.prototype.create = function() 
{ 
  var replicate = this.worker.promisify(this.couch, 'replicate')
  var options = {
    source        : "skeleton/share",
    target        : this.name,
    create_target : true
  }
  
  this.log("creating …")
  return replicate( options )
  .then( this.updateAccessSettings.bind(this) )
  .otherwise( this.handleCreateError.bind(this) )
}


// 
// 
//
ShareDatabase.prototype.handleCreateError = function(error) 
{ 
  this.log(error, "could not create database.")
}


// 
// Only the user is allowed to access his shares database
// 
ShareDatabase.prototype.updateAccessSettings = function() {
  this.log('updateAccessSettings for ' + this.name)

  var readAccess  = this.properties && this.properties.access && (this.properties.access.read || this.properties.access),
      writeAccess = this.properties && this.properties.access && this.properties.access.write;

  return this.worker.when.all([
    this.resolveAccess(readAccess), 
    this.resolveAccess(writeAccess)
  ])
  .then( this.handleUpdatAccessSettingsSuccess.bind(this) )
  .then( this.sendSecurityUpdateRequest.bind(this) )
  .otherwise( this.handleUpdatAccessSettingsError.bind(this) )
}


// 
// 
// 
ShareDatabase.prototype.resolveAccess = function(accessSetting) {
  var view = this.worker.promisify( this.couch.database("_users"), 'view' )
  var ownerHash = this.properties.createdBy

  if (accessSetting === true) {
    return this.worker.when.resolve([])
  }

  if (accessSetting === undefined || accessSetting === false) {
    return this.worker.when.resolve([ownerHash])
  }

  // when accessSetting is an array of user names, 
  // we first have to find the respective hashes
  return view('views/ownerByUsername', { keys: accessSetting})
  .then( function(results) {

    this.log("views/ownerByUsername: \n%j", results)
    this.log("accessSetting: \n%j", accessSetting)


    var list = [ownerHash];

    results.forEach( function(result) { 
      this.log("result: %j", result)
      list.push(result.value); 
    });

    this.log("list: %j", list)

    return list
  }.bind(this) )
}


// 
// 
// 
ShareDatabase.prototype.handleUpdatAccessSettingsSuccess = function(values) {
  var members = values[0],
      writers = values[1];

  return this.worker.when.resolve(members, writers)
}


// 
// 
// 
ShareDatabase.prototype.sendSecurityUpdateRequest = function(members, writers) {

  var query = this.worker.promisify( this.database, 'query' )
  var options = {
    path   : '_security',
    method : 'PUT',
    json   : {
      members: {
        roles: members
      },
      writers: {
        roles: writers
      }
    }
  };

  this.log("updating " + this.name + "/_security with: %j", options.json)
  return query(options)
}


// 
// 
// 
ShareDatabase.prototype.handleUpdatAccessSettingsError = function(error) {
  this.handleError(error, "could not update _security settings")
}


// 
// 
// 
ShareDatabase.prototype.log = function() {
  this.worker.log.apply( this.worker, arguments)
}


module.exports = ShareDatabase;