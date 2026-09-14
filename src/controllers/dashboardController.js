const mongoose = require("mongoose");
const Item = require("../models/Item");
const Customer = require("../models/Customer");
const Purchase = require("../models/Purchase");
const Sale = require("../models/Sale");
const PurchaseReturn = require("../models/PurchaseReturn");
const SaleReturn = require("../models/SaleReturn");
const StockTransfer = require("../models/StockTransfer");
const Company = require("../models/Company");
const User = require("../models/User");

const RECENT_ACTIVITY_LIMIT = 8;

function oid(id) {
  return new mongoose.Types.ObjectId(id);
}

// "Today" is computed from the server clock, matching the same convention
// every Add page's todayValue() default already uses (local time, not UTC) —
// see CLAUDE.md's Purchase/Sale/Return Modules section for that precedent.
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function startOfTomorrow() {
  const d = startOfToday();
  d.setDate(d.getDate() + 1);
  return d;
}

async function sumField(Model, match, field) {
  const rows = await Model.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: `$${field}` }, count: { $sum: 1 } } }]);
  return { total: rows[0]?.total || 0, count: rows[0]?.count || 0 };
}

// Company-scoped dashboard for company_admin/staff — KPI cards + a merged
// recent-activity feed across all 5 transactional modules. This is the
// implementation CLAUDE.md's "What's NOT Built Yet" section flagged as
// missing ("the data to make this real now exists via the Reports
// endpoints... but nothing wires Dashboard to them yet") — reuses the same
// oid()/aggregate-$match discipline reportController.js already established
// rather than inventing a new pattern.
async function buildCompanyDashboard(companyId) {
  const companyObjectId = oid(companyId);
  const todayStart = startOfToday();
  const todayEnd = startOfTomorrow();
  const todayMatch = { companyId: companyObjectId, invoiceDate: { $gte: todayStart, $lt: todayEnd } };

  const [
    todaySales,
    todayPurchases,
    totalItems,
    lowStockItems,
    totalCustomers,
    receivable,
    payable,
    recentSales,
    recentPurchases,
    recentPurchaseReturns,
    recentSaleReturns,
    recentTransfers,
  ] = await Promise.all([
    sumField(Sale, todayMatch, "netAmount"),
    sumField(Purchase, todayMatch, "netAmount"),
    Item.countDocuments({ companyId, isActive: true }),
    // A "low stock" item is one with a real reorder level set (minStockQty >
    // 0 — 0/unset means "not configured", the same convention Customer's
    // creditLimit/creditDays use elsewhere in this app) whose current
    // company-wide Fresh stock has fallen to or below it.
    Item.countDocuments({
      companyId,
      isActive: true,
      minStockQty: { $gt: 0 },
      $expr: { $lte: ["$openingStockFreshPcs", "$minStockQty"] },
    }),
    Customer.countDocuments({ companyId, isActive: true }),
    sumField(Sale, { companyId: companyObjectId }, "pendingAmount"),
    sumField(Purchase, { companyId: companyObjectId }, "pendingAmount"),
    Sale.find({ companyId })
      .sort({ createdAt: -1 })
      .limit(RECENT_ACTIVITY_LIMIT)
      .populate("customerId", "name")
      .select("invoiceNo invoiceDate netAmount customerId createdAt")
      .lean(),
    Purchase.find({ companyId })
      .sort({ createdAt: -1 })
      .limit(RECENT_ACTIVITY_LIMIT)
      .select("invoiceNo invoiceDate netAmount createdAt")
      .lean(),
    PurchaseReturn.find({ companyId })
      .sort({ createdAt: -1 })
      .limit(RECENT_ACTIVITY_LIMIT)
      .populate("supplierId", "name")
      .select("returnNo returnDate netAmount supplierId createdAt")
      .lean(),
    SaleReturn.find({ companyId })
      .sort({ createdAt: -1 })
      .limit(RECENT_ACTIVITY_LIMIT)
      .populate("customerId", "name")
      .select("returnNo returnDate netAmount customerId createdAt")
      .lean(),
    StockTransfer.find({ companyId })
      .sort({ createdAt: -1 })
      .limit(RECENT_ACTIVITY_LIMIT)
      .select("transferNo transferDate totalQty createdAt")
      .lean(),
  ]);

  // Merged, re-sorted, re-capped — mirrors the "fetch each type's own recent
  // N, merge, re-sort" pattern, since there's no single collection to page
  // through across 5 different models.
  const recentActivity = [
    ...recentSales.map((s) => ({
      type: "Sale",
      refNo: s.invoiceNo,
      description: s.customerId?.name || null,
      amount: s.netAmount,
      date: s.createdAt,
      id: String(s._id),
    })),
    ...recentPurchases.map((p) => ({
      type: "Purchase",
      refNo: p.invoiceNo,
      description: null,
      amount: p.netAmount,
      date: p.createdAt,
      id: String(p._id),
    })),
    ...recentPurchaseReturns.map((r) => ({
      type: "PurchaseReturn",
      refNo: r.returnNo,
      description: r.supplierId?.name || null,
      amount: r.netAmount,
      date: r.createdAt,
      id: String(r._id),
    })),
    ...recentSaleReturns.map((r) => ({
      type: "SaleReturn",
      refNo: r.returnNo,
      description: r.customerId?.name || null,
      amount: r.netAmount,
      date: r.createdAt,
      id: String(r._id),
    })),
    ...recentTransfers.map((t) => ({
      type: "StockTransfer",
      refNo: t.transferNo,
      description: `${t.totalQty} pcs moved`,
      amount: null,
      date: t.createdAt,
      id: String(t._id),
    })),
  ]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, RECENT_ACTIVITY_LIMIT);

  return {
    kpis: {
      todaySalesAmount: todaySales.total,
      todaySalesCount: todaySales.count,
      todayPurchasesAmount: todayPurchases.total,
      todayPurchasesCount: todayPurchases.count,
      totalItems,
      lowStockItems,
      totalCustomers,
      totalReceivable: receivable.total,
      totalPayable: payable.total,
    },
    recentActivity,
  };
}

// System-wide dashboard for super_admin — no companyId scoping at all,
// intentionally (super_admin sees across every company, same as every other
// super_admin-only view in this app).
async function buildSuperAdminDashboard() {
  const [totalCompanies, activeCompanies, totalCompanyAdmins, totalStaff, recentCompanies] = await Promise.all([
    Company.countDocuments({}),
    Company.countDocuments({ isActive: { $ne: false } }),
    User.countDocuments({ role: "company_admin", isActive: true }),
    User.countDocuments({ role: "staff", isActive: true }),
    Company.find({}).sort({ createdAt: -1 }).limit(RECENT_ACTIVITY_LIMIT).select("name code isActive createdAt").lean(),
  ]);

  return {
    kpis: { totalCompanies, activeCompanies, totalCompanyAdmins, totalStaff },
    recentCompanies: recentCompanies.map((c) => ({ ...c, id: String(c._id) })),
  };
}

// GET /api/dashboard — mounted with just protect+scopeCompany, no
// requirePermission, since Dashboard is visible to every logged-in user
// regardless of their granted module permissions (see CLAUDE.md's Staff &
// Permissions section — "Dashboard always shows").
const getDashboard = async (req, res) => {
  try {
    if (req.user.role === "super_admin") {
      const data = await buildSuperAdminDashboard();
      return res.status(200).json({ role: "super_admin", ...data });
    }
    const data = await buildCompanyDashboard(req.effectiveCompanyId);
    return res.status(200).json({ role: req.user.role, ...data });
  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = { getDashboard };
