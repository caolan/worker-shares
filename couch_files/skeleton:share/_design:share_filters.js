var share = function(doc, req) { 
  return doc._id.indexOf(req.query.share_id) === 6  
};

var json = {
  "_id": "_design/filters",
  "filters": {
    "share": share.toString().replace(/\s*\n\s*/g, ' ')
  }
}

module.exports = json