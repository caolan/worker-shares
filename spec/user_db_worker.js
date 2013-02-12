require('./spec_helper.js');

var when = require("when");
var WorkerMock = require("./mocks/worker.js")
var UserDbWorker = require("./../lib/user_db_worker.js");

describe('UserDbWorker', function () {
  beforeEach(function () {
    this.userDbWorker = new UserDbWorker('user/hash', WorkerMock)
  });

  describe('constructor', function () {
    
  }); // constructor

  
}); // UserDbWorker