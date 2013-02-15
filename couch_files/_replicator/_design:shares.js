var stop = function(doc, req) { 
  log('stopping replication ' + doc._id); 
  doc._deleted = true; 
  return [doc, 'OK'];
};

var start = function(doc, req) { 
  var dbs, shareId, userHash; 
  if (! doc) doc = {}; 

  doc._id        = req.id; 
  doc.continuous = true; 

  // source & target
  dbs            = req.id.replace(/^[^\/]\//,'').split(' => '); 
  doc.source     = dbs[0]; 
  doc.target     = dbs[1]; 

  // user context
  userHash = req.id.match(/\buser\/(\w+)/).pop()
  doc.user_ctx = {
    roles : userHash
  };

  // filter
  if (/^share\//.test(target)) {
    doc.filter = 'filter/share'
  }

  // timestamps
  doc.createdAt = JSON.stringify(new Date());
  doc.updatedAt = doc.createdAt; 

  // query params
  shareId = req.id.match('share/([0-9a-z]+)').pop(); 
  doc.query_params = {}; 
  doc.query_params.shareId = shareId; 
  return [doc, 'OK'];
};

var json = {
  "_id": "_design/shares",
  "updates": {
    "stop": stop.toString().replace(/\s*\n\s*/g, ' '),
    "start": start.toString().replace(/\s*\n\s*/g, ' ')
  }
};

module.exports = json;