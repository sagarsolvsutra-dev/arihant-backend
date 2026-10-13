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
async function buildCompanyDashboard(companyId, dateFrom, dateTo) {
  const companyObjectId = oid(companyId);
  
  // Default to last 1 month if not provided
  let chartStartDate = startOfToday();
  chartStartDate.setMonth(chartStartDate.getMonth() - 1);
  if (dateFrom) {
    chartStartDate = new Date(dateFrom);
    chartStartDate.setHours(0, 0, 0, 0);
  }

  let todayEnd = startOfTomorrow();
  if (dateTo) {
    todayEnd = new Date(dateTo);
    todayEnd.setHours(23, 59, 59, 999);
  }

  // Calculate difference in days to loop over chart data
  const daysDiff = Math.round((todayEnd - chartStartDate) / (1000 * 60 * 60 * 24));
  const days = daysDiff > 0 ? daysDiff : 1;

  const rangeMatch = { companyId: companyObjectId, invoiceDate: { $gte: chartStartDate, $lt: todayEnd } };

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
    dueSales,
    duePurchases,
    dueSaleReturns,
    duePurchaseReturns,
  ] = await Promise.all([
    sumField(Sale, rangeMatch, "netAmount"),
    sumField(Purchase, rangeMatch, "netAmount"),
    // Total Items / Total Customers are the company's whole active roster,
    // not "created within the chart's date range" — a company with 500 items
    // created over the years but 0 created in the chart window (defaults to
    // the last month) must still show 500, not 0. Lifetime count, same as
    // lowStockItems right below.
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
    }), // low stock usually doesn't make sense to date filter, keep lifetime
    Customer.countDocuments({ companyId, isActive: true }),
    // Receivable/Payable are "what's currently owed, lifetime" — the same
    // invariant the Customer/Supplier Ledger's own Closing Balance keeps
    // (never date-scoped). An invoice from 4 months ago with a real unpaid
    // balance must still count here even when the chart's date range (default
    // last 1 month) doesn't cover its invoiceDate.
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
    Sale.find({ companyId, dueDate: { $lte: todayEnd }, pendingAmount: { $gt: 0 } })
      .populate("customerId", "name")
      .select("invoiceNo dueDate pendingAmount customerId invoiceDate")
      .lean(),
    Purchase.find({ companyId, dueDate: { $lte: todayEnd }, pendingAmount: { $gt: 0 } })
      .select("invoiceNo dueDate pendingAmount invoiceDate")
      .lean(),
    SaleReturn.find({ companyId, dueDate: { $lte: todayEnd }, pendingAmount: { $gt: 0 } })
      .populate("customerId", "name")
      .select("returnNo dueDate pendingAmount customerId returnDate")
      .lean(),
    PurchaseReturn.find({ companyId, dueDate: { $lte: todayEnd }, pendingAmount: { $gt: 0 } })
      .populate("supplierId", "name")
      .select("returnNo dueDate pendingAmount supplierId returnDate")
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

  const dueReminders = [
    ...dueSales.map((s) => ({
      type: "Sale",
      refNo: s.invoiceNo,
      partyName: s.customerId?.name || "Unknown",
      amount: s.pendingAmount,
      dueDate: s.dueDate,
      id: String(s._id),
      direction: "receive"
    })),
    ...duePurchases.map((p) => ({
      type: "Purchase",
      refNo: p.invoiceNo,
      partyName: "Purchase Invoice",
      amount: p.pendingAmount,
      dueDate: p.dueDate,
      id: String(p._id),
      direction: "pay"
    })),
    ...dueSaleReturns.map((r) => ({
      type: "SaleReturn",
      refNo: r.returnNo,
      partyName: r.customerId?.name || "Unknown",
      amount: r.pendingAmount,
      dueDate: r.dueDate,
      id: String(r._id),
      direction: "pay"
    })),
    ...duePurchaseReturns.map((r) => ({
      type: "PurchaseReturn",
      refNo: r.returnNo,
      partyName: r.supplierId?.name || "Unknown",
      amount: r.pendingAmount,
      dueDate: r.dueDate,
      id: String(r._id),
      direction: "receive"
    })),
  ].sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  const sevenDaysAgo = startOfToday();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
  
  const [recentSalesAgg, recentPurchasesAgg] = await Promise.all([
    Sale.aggregate([
      { $match: { companyId: companyObjectId, invoiceDate: { $gte: chartStartDate, $lt: todayEnd } } },
      { $group: { _id: { $dateToString: { format: days > 60 ? "%Y-%m" : "%Y-%m-%d", date: "$invoiceDate" } }, totalSales: { $sum: "$netAmount" } } }
    ]),
    Purchase.aggregate([
      { $match: { companyId: companyObjectId, invoiceDate: { $gte: chartStartDate, $lt: todayEnd } } },
      { $group: { _id: { $dateToString: { format: days > 60 ? "%Y-%m" : "%Y-%m-%d", date: "$invoiceDate" } }, totalPurchases: { $sum: "$netAmount" } } }
    ])
  ]);

  const chartData = [];
  if (days > 60) {
    // Group by month
    const startMonth = new Date(chartStartDate.getFullYear(), chartStartDate.getMonth(), 1);
    const endMonth = new Date(todayEnd.getFullYear(), todayEnd.getMonth(), 1);
    
    let currentMonth = new Date(startMonth);
    while (currentMonth <= endMonth) {
      const yearStr = currentMonth.getFullYear();
      const monthStr = String(currentMonth.getMonth() + 1).padStart(2, '0');
      const monthKey = `${yearStr}-${monthStr}`;
      const displayDate = currentMonth.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
      
      const saleObj = recentSalesAgg.find(x => x._id === monthKey);
      const purchObj = recentPurchasesAgg.find(x => x._id === monthKey);
      
      chartData.push({
        date: displayDate,
        sales: saleObj ? saleObj.totalSales : 0,
        purchases: purchObj ? purchObj.totalPurchases : 0
      });
      
      currentMonth.setMonth(currentMonth.getMonth() + 1);
    }
  } else {
    // Group by day
    for (let i = 0; i < days; i++) {
      const d = new Date(chartStartDate);
      d.setDate(d.getDate() + i);
      const tzOffset = d.getTimezoneOffset() * 60000;
      const localISOTime = (new Date(d.getTime() - tzOffset)).toISOString().slice(0, 10);
      const displayDate = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      
      const saleObj = recentSalesAgg.find(x => x._id === localISOTime);
      const purchObj = recentPurchasesAgg.find(x => x._id === localISOTime);
      
      chartData.push({
        date: displayDate,
        sales: saleObj ? saleObj.totalSales : 0,
        purchases: purchObj ? purchObj.totalPurchases : 0
      });
    }
  }

  return {
    kpis: {
      filteredSalesAmount: todaySales.total,
      filteredSalesCount: todaySales.count,
      filteredPurchasesAmount: todayPurchases.total,
      filteredPurchasesCount: todayPurchases.count,
      totalItems,
      lowStockItems,
      totalCustomers,
      totalReceivable: receivable.total,
      totalPayable: payable.total,
    },
    recentActivity,
    dueReminders,
    chartData,
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
    const { dateFrom, dateTo } = req.query;
    if (req.user.role === "super_admin") {
      const data = await buildSuperAdminDashboard();
      return res.status(200).json({ role: "super_admin", ...data });
    }
    const data = await buildCompanyDashboard(req.effectiveCompanyId, dateFrom, dateTo);
    return res.status(200).json({ role: req.user.role, ...data });
  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = { getDashboard };
