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


  this.couch = couch

  this.checkIfInstalled( function(error, isInstalled) {
    if (error) {
      this._log("Error when checking for /modules/shares: %j", error)
      return
    }

    if (isInstalled) {
      this._log("/modules/shares already installed.")
      callbackWhenInstalled()

    } else {
      this._log("/modules/shares not yet installed")
      this.installMe( function(error) {
        if (error) {
          this._log("Error when installing /modules/shares: %j", error)
          return
        }

        callbackWhenInstalled()
      } )
    }
  })
};

Install.prototype = {
  checkIfInstalled: function( callback ) {

    couch.database('modules').get('shares', function(error, object) {
      if (error) {
        this._log("Error in GET /modules/shares: %j", error)
        return
      }

      callback(null, true)
    })
  },

  installMe: function( callback ) {

    callback()
  },

  _log: function() {
    arguments[0] = "[WorkerShares install] " + arguments[0];
    console.log.apply(null, arguments)
  }
}


module.exports = Install;