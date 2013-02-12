var stop = function(doc, req) { 
  log('stopping replication ' + doc._id); 
  doc._deleted = true; 
  return [doc, 'OK'];
};

var start = function(doc, req) { 
  var dbs, share_id; 
  if (! doc) doc = {}; 
  doc._id = req.id; 
  dbs = req.id.split(' => '); 
  doc.source = dbs[0]; 
  doc.target = dbs[1]; 
  doc.continuous = true; 
  doc.user_ctx = {name: req.userCtx.name, roles: req.userCtx.roles}; 
  doc.$createdAt = JSON.stringify(new Date());
  doc.$updatedAt = doc.$createdAt; 
  for (var key in req.query) { 
    doc[key] = req.query[key]; 
  }
  share_id = req.id.match('share/([0-9a-z]+)').pop(); 
  doc.query_params = {}; 
  doc.query_params.share_id = share_id; 
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