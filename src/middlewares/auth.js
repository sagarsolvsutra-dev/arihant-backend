const jwt = require("jsonwebtoken");

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

module.exports = { protect, requireRole, scopeCompany };
