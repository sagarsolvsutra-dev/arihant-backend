// Sends a consistent error response, turning a raw Mongo duplicate-key error (E11000 —
// which slips through a findOne-based uniqueness pre-check under concurrent requests)
// into the same friendly "already exists" message the pre-check itself would return,
// instead of a raw 500.
function sendError(res, error, fallbackMessage = "Server Error") {
  if (error && error.code === 11000) {
    const field = Object.keys(error.keyPattern || {}).find((k) => k !== "companyId") || "value";
    return res.status(400).json({ message: `This ${field} already exists` });
  }
  // Every frontend service's request() wrapper reads only `.message` for its toast
  // (see the project-wide fix that changed ~70 other 500 handlers to do the same) —
  // returning the generic fallback here instead of the real reason buries it in a
  // `.error` field nothing ever reads, silently undoing that fix for every one of
  // this helper's 9 callers.
  return res.status(500).json({ message: error?.message || fallbackMessage });
}

module.exports = { sendError };
