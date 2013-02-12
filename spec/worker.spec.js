require('./spec_helper.js');

var when = require("when");

var setupMock = require('./mocks/setup')
var CouchMock = require('./mocks/couch')
var UserDbWorkerMock = require('./mocks/user_db_worker')
var UserDbWorkerSpy = spyOnModule('./../lib/user_db_worker.js').andReturn(UserDbWorkerMock)

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

  describe('#launch()', function () {
    beforeEach(function() {
      spyOn(this.worker, "listenUp");
      this.worker.launch.andCallThrough()
      this.worker.userDbWorkers = null
      this.worker.launch()
    });
    it('should prepare userDbWorkers hash', function (done) {
      expect(this.worker.listenUp).wasCalled()
      expect(this.worker.userDbWorkers).toEqual({});
    });
    it('should #listenUp()', function (done) {
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
    it('should listen to changes in _users database', function (done) {
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
    it("should listen to account:created event", function() {
      var args = this.worker.on.calls[1].args
      expect(args[0]).toBe('account:created')
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
      expect(this.worker.handleError).wasCalledWith('ooops', 'error in _changes feed');
    });
  }); // #handleChangeError(error)

  describe('#handleChange(error)', function () {
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
        it("should not emit account:changed event", function() {
          expect(this.worker.emit).wasCalledWith('account:changed', 'user/hash');
        });
      })
    })
  }); // #handleChange(error)

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
    it('it should initialize a new UserDbWorker?', function () {
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
    it('remove userDbWorker from userDbWorkers hash', function (done) {
      this.worker.handleRemovedUserAccount( 'user/hash' )
      expect(this.worker.userDbWorkers['user/hash']).toBeUndefined();
    });
  });
});