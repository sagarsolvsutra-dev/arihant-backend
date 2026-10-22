const mongoose = require("mongoose");
const Item = require("../models/Item");
const Customer = require("../models/Customer");
const Sale = require("../models/Sale");
const BankAccount = require("../models/BankAccount");
// Reused deliberately rather than reimplemented: "is this customer overdue"
// already has exactly one definition in this codebase (dueDate if the invoice
// has one, else invoiceDate + the customer's creditDays; creditDays 0/unset
// means no due-date policy at all, so never overdue) and it drives the
// Customers list's own Overdue pill. A second copy here would be free to
// drift from it silently.
const { computeOverdueFlags } = require("./customerController");

// Each group shows at most this many items — the bell is a glance, not a
// report. Each group still carries its own real `total` so the UI can say
// "showing 5 of 12" instead of implying 5 is all there is.
const PER_GROUP_LIMIT = 5;

function emptyPayload() {
  return { count: 0, groups: [] };
}

// Company-scoped, computed the same way dashboardController's
// buildCompanyDashboard does — every query keyed off the companyId that
// scopeCompany resolved from the JWT, never a client-supplied value.
async function buildNotifications(companyId) {
  const [lowStockItems, lowStockTotal, creditCustomers, lowBankAccounts, lowBankTotal] = await Promise.all([
    // Same low-stock definition as the Dashboard's own KPI: a real reorder
    // level must actually be set (minStockQty > 0 — 0/unset means "not
    // configured") and the item's current company-wide Fresh stock has fallen
    // to or below it. $expr is what allows the field-to-field comparison.
    Item.find({
      companyId,
      isActive: true,
      minStockQty: { $gt: 0 },
      $expr: { $lte: ["$openingStockFreshPcs", "$minStockQty"] },
    })
      .sort({ openingStockFreshPcs: 1 })
      .limit(PER_GROUP_LIMIT)
      .select("itemName openingStockFreshPcs minStockQty")
      .lean(),
    Item.countDocuments({
      companyId,
      isActive: true,
      minStockQty: { $gt: 0 },
      $expr: { $lte: ["$openingStockFreshPcs", "$minStockQty"] },
    }),
    // Only customers with a configured credit policy can be overdue at all,
    // so this is the complete candidate set computeOverdueFlags needs.
    Customer.find({ companyId, isActive: true, creditDays: { $gt: 0 } })
      .select("name creditDays")
      .lean(),
    BankAccount.find({ companyId, currentBalance: { $lte: 0 } })
      .sort({ currentBalance: 1 })
      .limit(PER_GROUP_LIMIT)
      .select("bankName accountNumber currentBalance")
      .lean(),
    BankAccount.countDocuments({ companyId, currentBalance: { $lte: 0 } }),
  ]);

  const overdueMap = await computeOverdueFlags(companyId, creditCustomers);
  const overdueCustomers = creditCustomers.filter((c) => overdueMap.get(String(c._id)));

  // The outstanding figure shown alongside each overdue customer: the sum of
  // their own unpaid invoice balances. computeOverdueFlags above is what
  // decides WHO is overdue (the due-date rule lives there and only there);
  // this aggregate only supplies the amount to display for them.
  let outstandingById = new Map();
  if (overdueCustomers.length) {
    const rows = await Sale.aggregate([
      {
        $match: {
          companyId: new mongoose.Types.ObjectId(String(companyId)),
          customerId: { $in: overdueCustomers.map((c) => c._id) },
          pendingAmount: { $gt: 0 },
        },
      },
      { $group: { _id: "$customerId", total: { $sum: "$pendingAmount" } } },
    ]);
    outstandingById = new Map(rows.map((r) => [String(r._id), r.total || 0]));
  }

  const groups = [];

  if (lowStockItems.length) {
    groups.push({
      type: "lowStock",
      label: "Low stock",
      severity: "warning",
      total: lowStockTotal,
      items: lowStockItems.map((i) => ({
        id: String(i._id),
        title: i.itemName,
        subtitle: `${i.openingStockFreshPcs || 0} pcs left · reorder at ${i.minStockQty} pcs`,
        href: `/items/stock/${String(i._id)}`,
      })),
    });
  }

  if (overdueCustomers.length) {
    const shown = overdueCustomers.slice(0, PER_GROUP_LIMIT);
    groups.push({
      type: "overdueCustomers",
      label: "Overdue customers",
      severity: "danger",
      total: overdueCustomers.length,
      items: shown.map((c) => ({
        id: String(c._id),
        title: c.name,
        subtitle: `₹${(outstandingById.get(String(c._id)) || 0).toFixed(2)} overdue · ${c.creditDays} day credit`,
        href: `/customers/ledger/${String(c._id)}`,
      })),
    });
  }

  if (lowBankAccounts.length) {
    groups.push({
      type: "bankBalances",
      label: "Bank balances",
      // A genuinely negative balance is an error state; an exactly-zero one is
      // only worth a nudge.
      severity: lowBankAccounts.some((b) => (b.currentBalance || 0) < 0) ? "danger" : "warning",
      total: lowBankTotal,
      items: lowBankAccounts.map((b) => ({
        id: String(b._id),
        title: b.bankName,
        subtitle: `Balance ₹${(b.currentBalance || 0).toFixed(2)}${b.accountNumber ? ` · A/c ${b.accountNumber}` : ""}`,
        href: `/bank-accounts/${String(b._id)}`,
      })),
    });
  }

  return {
    count: groups.reduce((sum, g) => sum + g.items.length, 0),
    groups,
  };
}

// GET /api/notifications — mounted with just protect+scopeCompany, no
// requirePermission, for the same reason /api/dashboard is: the notification
// bell lives in AdminLayout's header on EVERY page, so every logged-in user
// (staff included, whatever they've been granted) hits this route. Gating it
// behind any single module's permission would break the header for anyone
// without that specific grant.
//
// super_admin has no company of their own to scope against (their token's
// companyId is null, and scopeCompany hands them the `{ $ne: null }`
// any-company sentinel) — these alerts are inherently per-company, so unless
// they've explicitly selected one via the company switcher we return a valid
// empty payload rather than blending every tenant's items into one list.
const getNotifications = async (req, res) => {
  try {
    const companyId = req.effectiveCompanyId;
    if (!mongoose.isValidObjectId(companyId)) {
      return res.status(200).json(emptyPayload());
    }
    const data = await buildNotifications(companyId);
    return res.status(200).json(data);
  } catch (error) {
    console.error("Notifications error:", error);
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = { getNotifications };
