const mongoose = require("mongoose");

// Escapes regex metacharacters in a client-supplied search string before it's used
// in a MongoDB $regex query — without this, a crafted pattern (e.g. nested
// quantifiers) is compiled and run as a live regex against every document's string
// fields, letting an unauthenticated caller trigger catastrophic backtracking (ReDoS).
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Builds a case-insensitive "contains" regex query value from raw user input, safe
// to drop straight into a Mongoose query field.
function searchRegex(str) {
  return { $regex: escapeRegex(str), $options: "i" };
}

// Clamps a client-supplied `limit` query param to a sane range. Mongoose/MongoDB
// treats `.limit(0)` as "no limit," so an unclamped `limit=0` (or a negative value)
// silently dumps the entire collection in one response, ignoring `page` — this also
// caps the upper end to prevent a single request from pulling an unbounded result set.
function clampLimit(limit, { max = 500, fallback = 10 } = {}) {
  const n = parseInt(limit, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function clampPage(page) {
  const n = parseInt(page, 10);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n;
}

function isValidObjectId(id) {
  return typeof id === "string" && mongoose.Types.ObjectId.isValid(id);
}

module.exports = { escapeRegex, searchRegex, clampLimit, clampPage, isValidObjectId };
