# Hoodie Shares Worker

This worker handles sharing of objects between users or publicly.

To start, this needs the following environment variables set:

    $ export HOODIE_SERVER=http://example.org
    $ export HOODIE_ADMIN_USER=couch_admin_username
    $ export HOODIE_ADMIN_PASS=couch_admin_pass

To start, run:

    $ node index.js


## Requirements

As of now, there is no "worker installation routine yet". But as soon as we have them,
the routine for the Shares Worker has to add two things to the Couch

1. Create a "skeleton/share" database, having a `_design/share_filters`  doc and a 
   `_design/write_access` doc (see stuff/_design:filters.json and stuff/_design:write_access.json)
2. Adding a "_design/shares" doc to _replicators database (see stuff/_design:cancel_replications)
3. _users database needs a view to map usernames by $owner hashs (see stuff/_design:user_views)


## What happens behind the curtain

An additional `$shares` database gets created for every user, in the form of `user/hash567/$shares`.
Objects do not get replicated directly from the user datbase (`user/hash567`) as the user has the
option to share only certain attributes of an object.

The worker follows all user databases and the `$shares` counterparts. If the latter do not exist yet,
they get created.

Here's an example (simplified) `$share` object created by a user:

```json
{
  "_id"  : "$share/uuid567",
  "_ref" : "1-bl2xa#1346886508617",
  "type" : "$share"
}
```

The worker picks it up, creates a database "share/uuid567" and a continuous replication from user's `$shares` database.
It also sets the `$state` attribute to "active", so that the frontend client can inform the user that the sharing has been started.

Whenever the user adds an object to the sharing, the share id will be added to the $shares attribute (which gets created if not present yet.)

```json
{
  "_id"     : "todo/abc4567",
  "type"    : "todo",
  "name"    : "Remeber the mild",
  "owner"   : "joe@example.com",
  "$shares" : {
    "uuid567": true
  }
}
```

The worker will remove the $shares attribute and copy it over to the user's $shares database.
Besides `true`, the value can also be an array of attributes:

```json
{
  "_id"     : "todo/abc4567",
  "type"    : "todo",
  "name"    : "Remeber the mild",
  "owner"   : "joe@example.com",
  "$shares" : {
    "uuid567": ["name"]
  }
}
```

In the example above, only the `name` attribute will be copied over, the `owner` attribute
will not be shared. 

Whenever the user removes an object from a sharing, the value will be set to false, so that
the worker can react on it and remove the object from the $shares database. Once the object
has been removed, the share id will me remove from the `$shares` hash of the object.


## To be done

The current implementation ignores share settings and is not bidirectional yet.

* the `access` setting  
  the access setting defines who can read and/or write to the sharing. Default
  value is false, meaning only the creator has access. `true` means the sharing
  is public. More granular settings are possible as well:  

  `{read: true}` public sharing, but read only  
  `{read: ["user1", "user2"]}` private sharing, only user1 & user2 have read access  
  `{write: ["user1", "user2"]}` private sharing, user1 & user2 have read & write access  
  `{read: true, write: ["user1"]}` private sharing, but only user1 has write access  

  depending on the access setting, a _design doc has to be created that prevents
  unauthorized users to make changes to the shared objects. And if the share allows
  changes, they need to be replicated to users $shares database and the changes need
  to be incorporated into the "real objects".
* the `password` setting  
  When the sharing is public and a password is set, the objects can be only accessed
  with the password. Users that are liste