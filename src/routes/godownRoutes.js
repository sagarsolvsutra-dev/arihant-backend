const express = require("express");
const router = express.Router();
const {
  getGodowns,
  createGodown,
  updateGodown,
  deleteGodown,
} = require("../controllers/godownController");
const { exportGodownTransactions } = require("../controllers/exportController");
const User = require("../models/User");

// This route is mounted under /api/godowns, which server.js gates with
// requirePermission("godowns", { readOnly: true }) — so for a staff user its
// GET passes unconditionally, the way every master-data read does. But what it
// actually returns is not master data: it's every Purchase/Sale/Purchase
// Return/Sale Return LINE (rates and net values included) for the company.
// Without this check a staff member with no transactional grant at all could
// read the whole purchase and sale history by exporting it — the exact bypass
// exportListRoutes.js's own requireExportPermission exists to close for the
// other export endpoint. Same shape as that one, including the live DB read
// rather than the JWT's (stale-able) permissions claim.
const TYPE_PERMISSION_MAP = {
  purchase: "purchase",
  sale: "sale",
  purchaseReturn: "purchaseReturn",
  saleReturn: "saleReturn",
};

async function requireGodownExportPermission(req, res, next) {
  if (!req.user || req.user.role !== "staff") return next();
  // type=all emits all four sections in one file, so it needs all four grants.
  const needed =
    req.query.type === "all"
      ? Object.values(TYPE_PERMISSION_MAP)
      : [TYPE_PERMISSION_MAP[req.query.type]].filter(Boolean);
  // An unrecognised type is rejected by the controller itself with a 400.
  if (!needed.length) return next();
  try {
    const freshUser = await User.findById(req.user.userId).select("permissions").lean();
    const perms = (freshUser && freshUser.permissions) || {};
    if (needed.every((key) => perms[key] && perms[key].view)) return next();
    return res.status(403).json({ message: "You don't have permission to export this data" });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Server Error" });
  }
}

router.route("/").get(getGodowns).post(createGodown);
router.get("/:id/export", requireGodownExportPermission, exportGodownTransactions);
router.route("/:id").put(updateGodown).delete(deleteGodown);

module.exports = router;
