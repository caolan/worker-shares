require('./spec_helper.js');

var when = require("when");

var setupMock = require('./mocks/setup')
var CouchMock = require('./mocks/couch')

var UserDbWorkerMock   = require('./mocks/user_database')
var SharesDbWorkerMock = require('./mocks/shares_database')
var UserDbWorkerSpy    = spyOnModule('./../lib/user_database.js').andReturn(UserDbWorkerMock)
var SharesDbWorkerSpy  = spyOnModule('./../lib/shares_database.js').andReturn(SharesDbWorkerMock)

// mock design docs
var usersDesignDoc        = require('./../couch_files/_users/_design:users_views')
var replicatorDesignDoc   = require('./../couch_files/_replicator/_design:shares')
var shareFiltersDesignDoc = require('./../couch_files/skeleton:share/_design:share_filters')
var shareAccessDesignDoc  = require('./../couch_files/skeleton:share/_design:write_access')
var sharesDatabaseSecurityOptions = require('./../couch_files/shares/_security')


var Worker    = require("./../lib/worker.js");

describe("Worker", function() {

  beforeEach(function(){
    this.setupDefer = when.defer()
    spyOn(Worker.prototype, "setup").andReturn(this.setupDefer.promise);
    spyOn(Worker.prototype, "launch");
    spyOn(Worker.prototype, "log");
    spyOn(Worker.prototype, "emit");
    spyOn(Worker.prototype, "on");

    this.config = {
      just: 'because'
    }
    this.worker = new Worker( this.config );
    this.worker.couch = new CouchMock
  })
  

  describe('constructor', function () {
    it("should setup with passed config", function() {
      expect(this.worker.setup).wasCalledWith(this.config);
    });

    _when('setup succeeds', function () {
      beforeEach(function() {
        this.setupDefer.resolve()
      });
      it('should #launch()', function () {
        expect(this.worker.launch).wasCalled();
      });
    });

    _when('setup fails', function () {
      beforeEach(function() {
        this.setupDefer.reject()
      });
      it('should not #launch()', function () {
        expect(this.worker.launch).wasNotCalled();
      });
    });
  }); // constructor


  describe('#install()', function () {
    beforeEach(function() {
      this.createShareSkeletonDatabaseDefer  = when.defer()
      this.createSharesDatabaseDefer         = when.defer()
      this.createDesignDocsInUsersDefer      = when.defer()
      this.createDesignDocsInReplicatorDefer = when.defer()

      spyOn(this.worker, "createShareSkeletonDatabase").andReturn( this.createShareSkeletonDatabaseDefer.promise )
      spyOn(this.worker, "createSharesDatabase").andReturn( this.createSharesDatabaseDefer.promise )
      spyOn(this.worker, "createDesignDocsInUsers").andReturn( this.createDesignDocsInUsersDefer.promise )
      spyOn(this.worker, "createDesignDocsInReplicator").andReturn( this.createDesignDocsInReplicatorDefer.promise )

      this.promise = this.worker.install()
    });
    it('should #createShareSkeletonDatabase()', function () {
      expect(this.worker.createShareSkeletonDatabase).wasCalled();
    });
    it('should #createSharesDatabase()', function () {
      expect(this.worker.createShareSkeletonDatabase).wasCalled();
    });
    it('should #createDesignDocsInUsers()', function () {
      expect(this.worker.createShareSkeletonDatabase).wasCalled();
    });
    it('should #createDesignDocsInReplicator()', function () {
      expect(this.worker.createShareSkeletonDatabase).wasCalled();
    });

    _when('all installations succeed', function () {
      beforeEach(function() {
        this.createShareSkeletonDatabaseDefer.resolve()
        this.createSharesDatabaseDefer.resolve()
        this.createDesignDocsInUsersDefer.resolve()
        this.createDesignDocsInReplicatorDefer.resolve()
      });
      it('it should return a resolved promise', function () {
        expect(this.promise).toBeResolved();
      });
    });

    _when('#createShareSkeletonDatabase() fails', function () {
      beforeEach(function() {
        this.createShareSkeletonDatabaseDefer.reject()
        this.createSharesDatabaseDefer.resolve()
        this.createDesignDocsInUsersDefer.resolve()
        this.createDesignDocsInReplicatorDefer.resolve()
      });
      it('it should return a rejected promise', function () {
        expect(this.promise).toBeRejected();
      });
    });

    _when('#createSharesDatabaseDefer() fails', function () {
      beforeEach(function() {
        this.createShareSkeletonDatabaseDefer.resolve()
        this.createSharesDatabaseDefer.reject()
        this.createDesignDocsInUsersDefer.resolve()
        this.createDesignDocsInReplicatorDefer.resolve()
      });
      it('it should return a rejected promise', function () {
        expect(this.promise).toBeRejected();
      });
    });

    _when('#createDesignDocsInUsersDefer() fails', function () {
      beforeEach(function() {
        this.createShareSkeletonDatabaseDefer.resolve()
        this.createSharesDatabaseDefer.resolve()
        this.createDesignDocsInUsersDefer.reject()
        this.createDesignDocsInReplicatorDefer.resolve()
      });
      it('it should return a rejected promise', function () {
        expect(this.promise).toBeRejected();
      });
    });

    _when('#createDesignDocsInReplicatorDefer() fails', function () {
      beforeEach(function() {
        this.createShareSkeletonDatabaseDefer.resolve()
        this.createSharesDatabaseDefer.resolve()
        this.createDesignDocsInUsersDefer.resolve()
        this.createDesignDocsInReplicatorDefer.reject()
      });
      it('it should return a rejected promise', function () {
        expect(this.promise).toBeRejected();
      });
    });
  }); // #install()


  describe('#launch()', function () {
    beforeEach(function() {
      spyOn(this.worker, "listenUp");
      this.worker.launch.andCallThrough()
      this.worker.userDbWorkers = null
      this.worker.launch()
    });
    it('should prepare userDbWorkers hash', function () {
      expect(this.worker.userDbWorkers).toEqual({});
    });
    it('should init shares db worker', function () {
      expect(SharesDbWorkerSpy).wasCalledWith( this.worker )
    });

    it('should #listenUp()', function () {
      expect(this.worker.listenUp).wasCalled()
    });
  }); // #launch()


  describe('#listenUp()', function () {
    beforeEach(function() {
      spyOn(this.worker, "handleChange");
      spyOn(this.worker, "handleChangeError");
      spyOn(this.worker, "handleRemovedUserAccount");
      spyOn(this.worker, "handleCreatedUserAccount");
      this.worker.listenUp()
    });
    it('should listen to changes in _users database', function () {
      expect(this.worker.couch.database).wasCalledWith('_users');
      expect(this.worker.couch.database().changes).wasCalledWith({since: 0, include_docs: true});
    });
    it("should listen to changes in _users changes feed", function() {
      var changesApi = this.worker.couch.database().changes()
      var args = changesApi.on.calls[0].args
      expect(args[0]).toBe('change')
      args[1]('change')
      expect(this.worker.handleChange).wasCalledWith('change');
    });
    it("should listen to errors in _users changes feed", function() {
      var changesApi = this.worker.couch.database().changes()
      var args = changesApi.on.calls[1].args
      expect(args[0]).toBe('error')
      args[1]('error')
      expect(this.worker.handleChangeError).wasCalledWith('error');
    });

    it("should listen to account:removed event", function() {
      var args = this.worker.on.calls[0].args
      expect(args[0]).toBe('account:removed')
      args[1]('dbName')
      expect(this.worker.handleRemovedUserAccount).wasCalledWith('dbName');
    });
    it("should listen to account:added event", function() {
      var args = this.worker.on.calls[1].args
      expect(args[0]).toBe('account:added')
      args[1]('dbName')
      expect(this.worker.handleCreatedUserAccount).wasCalledWith('dbName');
    });
  }); // #listenUp()


  describe('#handleChangeError(error)', function () {
    beforeEach(function() {
      spyOn(this.worker, "handleError");
      this.worker.handleChangeError('ooops')
    });
    it('call #handleError with a message', function () {
      expect(this.worker.handleError).wasCalledWith('ooops', 'error in _users/_changes feed');
    });
  }); // #handleChangeError(error)


  describe('#handleChange( change )', function () {
    beforeEach(function() {
    });

    _when('change.doc has no database property', function () {
      beforeEach(function() {
        this.change = {
          doc : {
            $state: 'confirmed'
          }
        }
        this.worker.handleChange( this.change )
      });
      it("should not emit anything", function() {
        expect(this.worker.emit).wasNotCalled();
      });
    })

    _when('change.doc is not confirmed', function () {
      beforeEach(function() {
        this.change = {
          doc : {
            database: 'user/hash'
          }
        }
        this.worker.handleChange( this.change )
      });
      it("should not emit anything", function() {
        expect(this.worker.emit).wasNotCalled();
      });
    })

    _when('change.deleted is true but user database has not yet been intialized', function () {
      beforeEach(function() {
        this.change = {
          deleted : true,
          doc : {
            database: 'user/hash'
          }
        }
        spyOn(this.worker, "userDbInitialized").andReturn( false );
        this.worker.handleChange( this.change )
      });
      it("should not emit anything", function() {
        expect(this.worker.emit).wasNotCalled();
      });
    })

    _when('change.doc is confirmed and has a database property', function () {
      beforeEach(function() {
        this.change = {
          doc : {
            database: 'user/hash',
            $state: 'confirmed'
          }
        }
      });

      _and('change.deleted is true and user db has been initialized', function () {
        beforeEach(function() {
          this.change.deleted = true
          spyOn(this.worker, "userDbInitialized").andReturn( true );
          this.worker.handleChange( this.change )
        });
        it("should not emit account:removed event", function() {
          expect(this.worker.emit).wasCalledWith('account:removed', 'user/hash');
        });
      })

      _and('user database has not yet been intialized has not been intialized yet', function () {
        beforeEach(function() {
          spyOn(this.worker, "userDbInitialized").andReturn( false );
          this.worker.handleChange( this.change )
        });
        it("should not emit account:added event", function() {
          expect(this.worker.emit).wasCalledWith('account:added', 'user/hash');
        });
      })

      _and('user database has not yet been intialized has been intialized before', function () {
        beforeEach(function() {
          spyOn(this.worker, "userDbInitialized").andReturn( true );
          this.worker.handleChange( this.change )
        });
        it("should not emit account:updated event", function() {
          expect(this.worker.emit).wasCalledWith('account:updated', 'user/hash');
        });
      })
    })
  }); // #handleChange( change )


  describe('#userDbInitialized( dbName )', function () {
    beforeEach(function() {
      this.worker.userDbWorkers = {
        'user/hash' : true
      }
    });
    _when('userDbWorker has been initialized', function () {
      it('it should return true', function () {
        expect(this.worker.userDbInitialized('user/hash')).toBe( true );
      });
    });
    _when('userDbWorker has not been initialized', function () {
      it('it should return false', function () {
        expect(this.worker.userDbInitialized('user/unknown')).toBe( false );
      });
    });
  }); // #userDbInitialized( dbName )


  describe('#handleCreatedUserAccount( dbName )', function () {
    beforeEach(function() {
      this.worker.userDbWorkers = {}
    });
    it('should initialize a new UserDbWorker', function () {
      this.worker.handleCreatedUserAccount( 'user/hash' )
      expect(UserDbWorkerSpy).wasCalledWith( 'user/hash', this.worker );
      expect(this.worker.userDbWorkers['user/hash']).toEqual( UserDbWorkerMock );
    });
  }); // #handleCreatedUserAccount( dbName )


  describe('#handleRemovedUserAccount( dbName )', function () {
    beforeEach(function() {
      this.worker.userDbWorkers = {
        'user/hash' : 'userDbWorker'
      }
    });
    it('remove userDbWorker from userDbWorkers hash', function () {
      this.worker.handleRemovedUserAccount( 'user/hash' )
      expect(this.worker.userDbWorkers['user/hash']).toBeUndefined();
    });
  }); // #handleRemovedUserAccount( dbName )


  describe('#createShareSkeletonDatabase()', function () {
    beforeEach(function() {
      this.handleCreateDatabaseErrorDefer = when.defer()
      spyOn(this.worker, "handleCreateDatabaseError").andReturn( this.handleCreateDatabaseErrorDefer.promise );
      this.handleCreateShareSkeletonSuccessDefer = when.defer()
      spyOn(this.worker, "handleCreateShareSkeletonSuccess").andReturn( this.handleCreateShareSkeletonSuccessDefer.promise );
      this.promise = this.worker.createShareSkeletonDatabase()
      this.callback = this.worker.couch.database().create.mostRecentCall.args[0]
    });
    it('should create `skeleton/share` database', function () {
      expect(this.worker.couch.database).wasCalledWith('skeleton/share');
      expect(this.worker.couch.database().create).wasCalled();
    });

    _when('create succeeds', function () {
      beforeEach(function() {
        this.callback(null, 'woot')
      });
      it('should #handleCreateShareSkeletonSuccess()', function () {
        expect(this.worker.handleCreateShareSkeletonSuccess).wasCalled();
      });

      _and('when #handleCreateShareSkeletonSuccess() succeeds', function () {
        beforeEach(function() {
          this.handleCreateShareSkeletonSuccessDefer.resolve()
        });
        it('should resolve', function () {
          expect(this.promise).toBeResolved();
        });
      });

      _but('when #handleCreateShareSkeletonSuccess() fails', function () {
        beforeEach(function() {
          this.handleCreateShareSkeletonSuccessDefer.reject()
        });
        it('should reject', function () {
          expect(this.promise).toBeRejected();
        });
      });
    });

    _when('create fails', function () {
      beforeEach(function() {
        this.callback('ooops')
      });

      _but('#handleCreateDatabaseError() resolves', function () {
        beforeEach(function() {
          this.handleCreateDatabaseErrorDefer.resolve()
        });
        it('should call #handleCreateShareSkeletonSuccess()', function () {
          expect(this.worker.handleCreateShareSkeletonSuccess).wasCalled();
        });
      });
      _and('#handleCreateDatabaseError() rejecets', function () {
        beforeEach(function() {
          this.handleCreateDatabaseErrorDefer.reject('ooops')
        });
        it('should reject', function () {
          expect(this.promise).toBeRejectedWith('ooops');
        });
      });
    });
  }); // #createShareSkeletonDatabase


  describe('#handleCreateDatabaseError( error )', function () {
    _when('error is "file_exists"', function () {
      beforeEach(function() {
        this.promise = this.worker.handleCreateDatabaseError({
          error: 'file_exists'
        })
      });
      it('should resolve', function () {
        expect(this.promise).toBeResolved();
      });
    });

    _when('error is "ooops"', function () {
      beforeEach(function() {
        this.promise = this.worker.handleCreateDatabaseError({
          error: 'ooops'
        })
      });
      it('should reject', function () {
        expect(this.promise).toBeRejectedWith({ error: 'ooops' });
      });
    });
  }); // ('#handleCreateDatabaseError( error )


  describe('#handleCreateShareSkeletonSuccess()', function () {
    beforeEach(function() {
      this.createDesignDocsInShareSkeletonDefer = when.defer()
      spyOn(this.worker, "createDesignDocsInShareSkeleton").andReturn( this.createDesignDocsInShareSkeletonDefer.promise );
      this.promise = this.worker.handleCreateShareSkeletonSuccess()
    });
    it('should #createDesignDocsInShareSkeleton()?', function () {
      expect(this.worker.createDesignDocsInShareSkeleton).wasCalled();
    });

    _when('#createDesignDocsInShareSkeleton() succeeds', function () {
      beforeEach(function() {
        this.createDesignDocsInShareSkeletonDefer.resolve()
      });
      it('should resolve', function () {
        expect(this.promise).toBeResolved();
      });
    });

    _when('#createDesignDocsInShareSkeleton() fails', function () {
      beforeEach(function() {
        this.createDesignDocsInShareSkeletonDefer.reject()
      });
      it('should reject', function () {
        expect(this.promise).toBeRejected();
      });
    });
  }); // #handleCreateShareSkeletonSuccess()





  describe('#createSharesDatabase()', function () {
    beforeEach(function() {
      this.handleCreateDatabaseErrorDefer = when.defer()
      spyOn(this.worker, "handleCreateDatabaseError").andReturn( this.handleCreateDatabaseErrorDefer.promise );
      this.handleCreateSharesDatabaseSuccessDefer = when.defer()
      spyOn(this.worker, "handleCreateSharesDatabaseSuccess").andReturn( this.handleCreateSharesDatabaseSuccessDefer.promise );
      this.promise = this.worker.createSharesDatabase()
      this.callback = this.worker.couch.database().create.mostRecentCall.args[0]
    });
    it('should create `shares` database', function () {
      expect(this.worker.couch.database).wasCalledWith('shares');
      expect(this.worker.couch.database().create).wasCalled();
    });

    _when('create succeeds', function () {
      beforeEach(function() {
        this.callback(null, 'woot')
      });
      it('should #handleCreateSharesDatabaseSuccess()', function () {
        expect(this.worker.handleCreateSharesDatabaseSuccess).wasCalled();
      });

      _and('#handleCreateSharesDatabaseSuccess() succeeds', function () {
        beforeEach(function() {
          this.handleCreateSharesDatabaseSuccessDefer.resolve()
        });
        it('should resolve', function () {
          expect(this.promise).toBeResolved();
        });
      });

      _but('#handleCreateSharesDatabaseSuccess() fails', function () {
        beforeEach(function() {
          this.handleCreateSharesDatabaseSuccessDefer.reject()
        });
        it('should reject', function () {
          expect(this.promise).toBeRejected();
        });
      });
    });

    _when('create fails', function () {
      beforeEach(function() {
        this.callback('ooops')
      });

      _but('#handleCreateDatabaseError() resolves', function () {
        beforeEach(function() {
          this.handleCreateDatabaseErrorDefer.resolve()
        });
        it('should call #handleCreateSharesDatabaseSuccess()', function () {
          expect(this.worker.handleCreateSharesDatabaseSuccess).wasCalled();
        });
      });
      _and('#handleCreateDatabaseError() rejecets', function () {
        beforeEach(function() {
          this.handleCreateDatabaseErrorDefer.reject('ooops')
        });
        it('should reject', function () {
          expect(this.promise).toBeRejectedWith('ooops');
        });
      });
    });
  }); // #createSharesDatabase


  describe('#handleCreateSharesDatabaseSuccess()', function () {
    beforeEach(function() {
      spyOn(this.worker, "createSharesDatabaseSecurity").andReturn('promise');
      this.promise = this.worker.handleCreateSharesDatabaseSuccess()
    });
    it('should call #createSharesDatabaseSecurity()', function () {
      expect(this.worker.createSharesDatabaseSecurity).wasCalled();
    });
    it('should return promise of #createSharesDatabaseSecurity()', function () {
      expect(this.promise).toBe('promise')
    });
  }); // #handleCreateSharesDatabaseSuccess()


  describe('#createSharesDatabaseSecurity()', function () {
    beforeEach(function() {
      this.queryDefer = when.defer()
      this.querySpy = jasmine.createSpy('query').andReturn( this.queryDefer.promise )
      spyOn(this.worker, "promisify").andReturn( this.querySpy );
      spyOn(this.worker, "handleCreateSharesDatabaseSecurityError");
      this.promise = this.worker.createSharesDatabaseSecurity()
    });

    it('should query shares database with options for _security', function () {
      expect(this.worker.couch.database).wasCalledWith('shares');  
      expect(this.querySpy).wasCalledWith( sharesDatabaseSecurityOptions );
    });

    _when('query succeeds', function () {
      beforeEach(function() {
        this.queryDefer.resolve()
      });
      it('should resolve', function () {
        expect(this.promise).toBeResolved();
      });
    });

    _when('query fails', function () {
      beforeEach(function() {
        this.queryDefer.reject('ooops')
      });
      it('should #handleCreateSharesDatabaseSecurityError()', function () {
        expect(this.worker.handleCreateSharesDatabaseSecurityError).wasCalledWith('ooops');
      });
    });
  }); // #createSharesDatabaseSecurity() 


  describe('#handleCreateSharesDatabaseSecurityError(error)', function () {
    it('rejecet with passed error', function () {
      var promise = this.worker.handleCreateSharesDatabaseSecurityError( 'ooops' )
      expect(promise).toBeRejectedWith( 'ooops' );
    });
  });


  describe('#createDesignDocsInShareSkeleton()', function () {
    beforeEach(function() {
      this.saveDefer = when.defer()
      this.saveSpy = jasmine.createSpy('save').andReturn( this.saveDefer.promise )
      spyOn(this.worker, "promisify").andReturn( this.saveSpy );
      this.promise = this.worker.createDesignDocsInShareSkeleton()
    });
    it("should save two docs in `skeleton/share`", function() {
      expect(this.worker.couch.database).wasCalledWith('skeleton/share');
      expect(this.worker.promisify).wasCalledWith(this.worker.couch.database('skeleton/share'), 'save');
      expect(this.saveSpy.callCount).toEqual(2);
    });
    it('should save `_design/write_access`', function () {
      expect(this.saveSpy).wasCalledWith('_design/write_access', shareAccessDesignDoc );
    });
    it('should save `_design/filters`', function () {
      expect(this.saveSpy).wasCalledWith('_design/filters', shareFiltersDesignDoc );
    });

    _when('saves succeed', function () {
      beforeEach(function() {
        this.saveDefer.resolve()
      });
      it('should resolve', function () {
        expect(this.promise).toBeResolved();
      });
    });

    _when('saves sail', function () {
      beforeEach(function() {
        this.saveDefer.reject()
      });
      it('should resolve', function () {
        expect(this.promise).toBeRejected();
      });
    });
  }); // #createDesignDocsInShareSkeleton()


  describe('#createDesignDocsInUsers()', function () {
    beforeEach(function() {
      this.saveDefer = when.defer()
      this.saveSpy = jasmine.createSpy('save').andReturn( this.saveDefer.promise )
      spyOn(this.worker, "promisify").andReturn( this.saveSpy );
      this.promise = this.worker.createDesignDocsInUsers()
    });
    it('save design doc in _users?', function () {
      expect(this.worker.couch.database).wasCalledWith('_users');
      expect(this.worker.promisify).wasCalledWith(this.worker.couch.database('_users'), 'save');
      expect(this.saveSpy).wasCalledWith('_design/views', usersDesignDoc);
    });

    _when('saves succeed', function () {
      beforeEach(function() {
        this.saveDefer.resolve()
      });
      it('should resolve', function () {
        expect(this.promise).toBeResolved();
      });
    });

    _when('saves sail', function () {
      beforeEach(function() {
        this.saveDefer.reject()
      });
      it('should resolve', function () {
        expect(this.promise).toBeRejected();
      });
    });
  }); // #createDesignDocsInUsers()


  describe('#createDesignDocsInReplicator()', function () {
    beforeEach(function() {
      this.saveDefer = when.defer()
      this.saveSpy = jasmine.createSpy('save').andReturn( this.saveDefer.promise )
      spyOn(this.worker, "promisify").andReturn( this.saveSpy );
      this.promise = this.worker.createDesignDocsInReplicator()
    });
    it('save design doc in _replicator?', function () {
      expect(this.worker.couch.database).wasCalledWith('_replicator');
      expect(this.worker.promisify).wasCalledWith(this.worker.couch.database('_replicator'), 'save');
      expect(this.saveSpy).wasCalledWith('_design/shares', replicatorDesignDoc);
    });

    _when('saves succeed', function () {
      beforeEach(function() {
        this.saveDefer.resolve()
      });
      it('should resolve', function () {
        expect(this.promise).toBeResolved();
      });
    });

    _when('saves sail', function () {
      beforeEach(function() {
        this.saveDefer.reject()
      });
      it('should resolve', function () {
        expect(this.promise).toBeRejected();
      });
    });
  }); // #createDesignDocsInReplicator()
});