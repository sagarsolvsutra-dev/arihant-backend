const jwt = require("jsonwebtoken");
const User = require("../models/User");

const JWT_SECRET = process.env.JWT_SECRET || "arihant-erp-secret-key-2024";

// Verifies the Bearer token and attaches the decoded identity to req.user.
// This is the only place a request's identity is established — every
// downstream companyId-scoping decision must come from req.user, never from
// a client-supplied companyId in the query/body (that's what scopeCompany
// below enforces for the rest of the app).
const protect = (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  // A plain `window.open()`/cross-tab navigation (the mechanism every Excel/PDF
  // export in this app uses to trigger a file download) cannot attach an
  // Authorization header — there's no fetch/XHR involved, just a GET the browser
  // issues itself. Every export route 401'd silently the moment real auth
  // landed (verified: curl with no header → 401) until this fallback was added.
  // Only used when no Bearer header is present, so it never overrides normal
  // header-based auth for the rest of the app.
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : (req.query && req.query.token) || null;
  if (!token) {
    return res.status(401).json({ message: "No token provided" });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
      companyId: decoded.companyId || null,
      // Only meaningful for role:"staff" (see utils/permissions.js). Still
      // decoded from the JWT for reference, but — unlike role/companyId —
      // NOT what requirePermission actually checks against anymore (see its
      // own comment below): a real, reported bug showed this JWT snapshot
      // going stale in exactly the way that matters most for this field —
      // an admin grants a staff member a new permission while they're
      // already logged in, the staff member's UI correctly shows the newly-
      // unlocked button (the frontend's own periodic `/auth/me` re-check
      // already refreshes localStorage's copy), but the actual write request
      // 403'd anyway because the JWT baked in at login never got that grant.
      // Shape: { moduleKey: { view, create, edit, delete } }.
      permissions: (decoded.permissions && typeof decoded.permissions === "object") ? decoded.permissions : {},
    };
    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

// Restricts a route to one or more roles. Must run after protect().
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ message: "Forbidden" });
  }
  next();
};

// Determines the companyId a request is actually allowed to operate against
// and overwrites req.query.companyId / req.body.companyId with it before the
// controller ever reads it. Every existing controller already destructures
// companyId this exact way (`const { companyId } = req.query` / `req.body`),
// so this single choke point makes all of that pre-existing code trustworthy
// without having to rewrite each controller's companyId-reading line.
//
// - super_admin: honored as-is — they're allowed to pass any companyId (the
//   frontend's company-switcher relies on this), or none for an unscoped view
//   where a controller supports that.
// - company_admin / staff: always forced to their own token's companyId,
//   regardless of whatever the client sent — this is the actual security
//   boundary. A staff user of Company A can no longer read/write Company B's
//   data by simply changing a query string or POST body value.
//
// Also sets req.effectiveCompanyId (a plain string) as the single source of
// truth for controllers that need to scope a single-record findById/update/
// delete by companyId, which reading req.query/req.body alone doesn't cover.
const scopeCompany = (req, res, next) => {
  if (!req.user) return next();

  // super_admin's own frontend calls (same pages/services as everyone else)
  // never send companyId on PUT/DELETE-by-:id requests — only GET-list/POST
  // calls carry it. Falling back to `null` there would make every
  // `findOne({ _id, companyId: req.effectiveCompanyId })` call site (see the
  // 17 controllers using this exact pattern) fail to match ANY real document,
  // since a query filter value of `undefined`/`null` does not mean "no
  // filter" to the Mongo driver — verified empirically, it's sent through and
  // simply never matches a real ObjectId. `{ $ne: null }` matches any real
  // companyId, correctly giving super_admin's un-scoped single-record
  // requests the cross-tenant reach they're supposed to have.
  let effective;
  if (req.user.role === "super_admin") {
    const explicit = (req.body && req.body.companyId) || req.query.companyId || null;
    effective = explicit || { $ne: null };
  } else {
    effective = req.user.companyId;
  }

  req.effectiveCompanyId = effective;

  // req.body is a plain object (set by express.json()), so direct mutation
  // works. req.query in Express 5 is a getter with NO setter — a direct
  // `req.query.companyId = x` silently no-ops, verified empirically (a real
  // Express 5 behavior change from Express 4, not documented anywhere in this
  // codebase). Object.defineProperty replaces the getter with a plain,
  // writable value so downstream controllers reading req.query.companyId
  // (every one of them, unchanged) see the enforced value.
  if (req.body && typeof req.body === "object") req.body.companyId = effective || undefined;
  const mergedQuery = { ...req.query, companyId: effective || undefined };
  Object.defineProperty(req, "query", {
    value: mergedQuery,
    writable: true,
    configurable: true,
    enumerable: true,
  });

  next();
};

// HTTP method -> CRUD action. Used by requirePermission to decide which
// specific grant (view/create/edit/delete) a given request actually needs.
function methodToAction(method) {
  if (method === "POST") return "create";
  if (method === "PUT" || method === "PATCH") return "edit";
  if (method === "DELETE") return "delete";
  return "view"; // GET, and anything else, treated as a read
}

// Gates a route mount by per-module CRUD permission — must run after
// protect(). Only ever checked for role:"staff"; company_admin/super_admin
// always pass through untouched (see utils/permissions.js).
//
// { readOnly: true } (used for every master-data route mount — each master
// resource is its own moduleKey now, e.g. "items"/"customers"/"godowns", not
// one shared "masters" key) means: GET requests are ALWAYS allowed regardless
// of the "view" grant — a deliberate, confirmed-with-the-user design choice,
// not a gap. Master data (e.g. the customer list) is shared reference data
// other modules need to function even without that specific module's own
// permission at all (a staff member with only "sale" permission still needs
// to read the customer list to pick one when making a sale, even with zero
// "customers" grants) — the "view" grant on e.g. "customers" instead governs
// whether the FRONTEND shows/allows navigating to that dedicated management
// page, which this backend check can't distinguish from a dropdown read
// since both hit the identical GET route. POST/PUT/DELETE on a readOnly-
// mounted route are NOT exempted — those still require the matching
// create/edit/delete grant, same as any other module.
// Checked LIVE against the DB on every request, not against the JWT's own
// (point-in-time-snapshot) permissions claim — see protect()'s comment above
// for the real, reported bug this closes: a staff member granted a new
// permission mid-session would otherwise keep getting 403'd on the exact
// action they were just given, until they happened to log out and back in.
// One extra indexed findById per permission-gated write is a fine trade for
// not shipping that confusion — this app's traffic doesn't remotely
// approach a scale where it matters.
const requirePermission = (moduleKey, { readOnly = false } = {}) => async (req, res, next) => {
  if (!req.user || req.user.role !== "staff") return next();
  const action = methodToAction(req.method);
  if (readOnly && action === "view") return next();
  try {
    const freshUser = await User.findById(req.user.userId).select("permissions").lean();
    const perms = (freshUser && freshUser.permissions) || {};
    if (perms[moduleKey] && perms[moduleKey][action]) return next();
    return res.status(403).json({ message: `You don't have "${action}" permission for this module` });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = { protect, requireRole, scopeCompany, requirePermission };
