var share = function(doc, req) { 
  return doc._id.indexOf(req.query.shareId) === 6  
};

var json = {
  "_id": "_design/filters",
  "views": {},
  "filters": {
    "share": share.toString().replace(/\s*\n\s*/g, ' ')
  }
}

module.exports = json