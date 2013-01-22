var Install = function(couchdb, callbackWhenInstalled) {
  
  // 1. check if /modules/share exists in couch
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



  this.checkIfInstalled( function(error, isInstalled) {
    if (error) {
      console.log("Error when checking for /modules/share: %j", error)
      return
    }

    if (isInstalled) {
      console.log("/modules/share already installed.")
      callbackWhenInstalled()

    } else {
      console.log("/modules/share not yet installed")
      this.installMe( function(error) {
        if (error) {
          console.log("Error when installing /modules/share: %j", error)
          return
        }

        callbackWhenInstalled()
      } )
    }
  })
};

Install.prototype = {
  checkIfInstalled: function( callback ) {
    callback(null, true)
  },

  installMe: function( callback ) {

    callback()
  }
}


module.exports = Install;