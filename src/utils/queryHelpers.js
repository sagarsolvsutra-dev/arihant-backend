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

// Throws if `id` is set but doesn't resolve to a real document of `Model`
// belonging to `companyId` — closes a cross-tenant reference leak: without
// this, a client could set e.g. supplierId to another company's real
// Supplier _id, and every place that later .populate()s the field (which
// resolves purely by _id, no companyId filter of its own) would leak that
// other company's data into this company's own records.
async function assertRefBelongsToCompany(Model, id, companyId, fieldLabel) {
  if (!id) return; // optional refs are allowed to be empty/null
  const doc = await Model.exists({ _id: id, companyId });
  if (!doc) {
    throw new Error(`Invalid ${fieldLabel} — not found in this company`);
  }
}

module.exports = {
  escapeRegex,
  searchRegex,
  clampLimit,
  clampPage,
  isValidObjectId,
  assertRefBelongsToCompany,
};
