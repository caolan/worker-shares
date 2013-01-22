var Worker = require("./lib/Worker.js");

var config = {
  server: process.env["HOODIE_SERVER"],
  admin: {
    user: process.env["HOODIE_ADMIN_USER"],
    pass: process.env["HOODIE_ADMIN_PASS"]
  },
  persistent_since_storage: false
};
new Worker(config);
