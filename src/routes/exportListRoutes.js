const express = require("express");
const router = express.Router();
const { exportList } = require("../controllers/exportListController");
const User = require("../models/User");

// This single generic endpoint serves 18 different resources (see
// exportListController's LIST_EXPORT_CONFIG) — a handful are transactional
// modules that need the same permission gate their own dedicated routes get
// (see server.js's requirePermission mounts), everything else is master data,
// which export treats as read-only and always allows (same "masters,
// readOnly" reasoning as every other master-data GET route).
const RESOURCE_PERMISSION_MAP = {
  purchases: "purchase",
  sales: "sale",
  "purchase-returns": "purchaseReturn",
  "sale-returns": "saleReturn",
  "stock-transfers": "stockTransfer",
};

// Exporting is fundamentally a read operation, so it's gated by the "view"
// grant on the relevant module — same as the module's own GET routes.
// Checked LIVE against the DB, not the JWT's own permissions claim — mirrors
// middlewares/auth.js's requirePermission fix (see its comment for the real,
// reported bug this avoids: a stale JWT still rejecting a permission that
// was actually granted mid-session).
async function requireExportPermission(req, res, next) {
  if (!req.user || req.user.role !== "staff") return next();
  const key = RESOURCE_PERMISSION_MAP[req.params.resource];
  if (!key) return next(); // master-data export — read-only, always allowed
  try {
    const freshUser = await User.findById(req.user.userId).select("permissions").lean();
    const perms = (freshUser && freshUser.permissions) || {};
    if (perms[key] && perms[key].view) return next();
    return res.status(403).json({ message: "You don't have permission to export this data" });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Server Error" });
  }
}

// GET /api/export-list/:resource?companyId=&dateFrom=&dateTo=&search=
// Always emits .xlsx — there is no `format` param here (unlike the per-godown
// PDF/Excel export at GET /api/godowns/:id/export, which genuinely supports both).
router.get("/:resource", requireExportPermission, exportList);

module.exports = router;
