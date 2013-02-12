require('./spec_helper.js');

var when = require("when");

var setupMock = require('./mocks/setup')
var couchMock = require('./mocks/couch')
var Worker    = require("./../lib/worker.js");

describe("Worker", function() {

  beforeEach(function(){
    this.setupDefer = when.defer()
    spyOn(Worker.prototype, "setup").andReturn(this.setupDefer.promise);
    spyOn(Worker.prototype, "launch");
    this.worker = new Worker();
  })
  
  describe('constructor', function () {
    it("should have some specs", function() {
      expect(1).toEqual(1);
    });
  }); // constructor
});