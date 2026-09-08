const mongoose = require("mongoose");

// Express param middleware: rejects a malformed `:id` route param with a clean 400
// before it ever reaches a controller's `findById`/`findByIdAndUpdate`/etc. — without
// this, an invalid id string throws a Mongoose CastError deep inside the controller's
// generic catch block, surfacing as a 500 with raw Mongoose phrasing (path/model
// name) instead of the clean 400 a bad client input actually warrants. Attach with
// `router.param("id", validateObjectIdParam)` in each route file that declares a
// `/:id` route.
function validateObjectIdParam(req, res, next, id) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid id" });
  }
  next();
}

module.exports = { validateObjectIdParam };
