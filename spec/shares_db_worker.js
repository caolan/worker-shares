require('./spec_helper.js');

var when = require("when");
var WorkerMock = require("./mocks/worker.js")
var SharesDbWorker = require("./../lib/shares_db_worker.js");

describe('SharesDbWorker', function () {
  beforeEach(function () {
    this.sharesDbWorker = new SharesDbWorker('user/hash/shares', WorkerMock)
  });
  
  describe('constructor', function () {
    
  }); // constructor
}); // SharesDbWorker