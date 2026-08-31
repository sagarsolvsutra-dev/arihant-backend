// Sends a consistent error response, turning a raw Mongo duplicate-key error (E11000 —
// which slips through a findOne-based uniqueness pre-check under concurrent requests)
// into the same friendly "already exists" message the pre-check itself would return,
// instead of a raw 500.
function sendError(res, error, fallbackMessage = "Server Error") {
  if (error && error.code === 11000) {
    const field = Object.keys(error.keyPattern || {}).find((k) => k !== "companyId") || "value";
    return res.status(400).json({ message: `This ${field} already exists` });
  }
  return res.status(500).json({ message: fallbackMessage, error: error?.message });
}

module.exports = { sendError };
