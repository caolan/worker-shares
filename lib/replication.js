var util          = require('util');
var HoodieWorker  = require('hoodie-worker');


/**
 *  Replication
 *  creates, updates and removes objects in _replicator database
 */
Replication = function( replicationObject, sharesDatabase ) {

  this.id         = replicationObject._id.substr(14);
  this.name       = "subscription/" + this.id;
  this.properties = replicationObject;


  this.sharesDatabase = sharesDatabase;
  this.couch          = sharesDatabase.couch;
  this.database       = sharesDatabase.couch.database('_replicator');

  this.listenUp();
  this.start();
};
util.inherits(Replication, HoodieWorker);


// 
// 
// 
Replication.prototype.listenUp = function() {
  this.sharesDatabase.on('subscription:object:update', this.handleUpdate.bind(this));
  this.sharesDatabase.on('subscription:object:remove', this.handleRemove.bind(this));
};


// 
// 
// 
Replication.prototype.start = function() {
  this.database.update("shares/start", this.name);
};


// 
// 
// 
Replication.prototype.stop = function() {
  this.database.update("shares/stop", this.name);
};


// 
// 
// 
Replication.prototype.handleUpdate = function( subscriptionObject ) {
  this.properties = subscriptionObject;
};


// 
// 
// 
Replication.prototype.handleRemove = function() {
  this.stop();
};

module.exports = Replication;