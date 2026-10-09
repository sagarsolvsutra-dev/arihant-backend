const AccountGroup = require("../models/AccountGroup");
const Account = require("../models/Account");
const { SUPER_GROUPS } = require("../models/AccountGroup");
const { searchRegex, clampLimit, clampPage } = require("../utils/queryHelpers");

// The same default groups shown in the reference (Tally-style) screenshot —
// lazily seeded the first time a company's list is fetched and found empty,
// so a brand-new company's Account master isn't stuck with an empty Group
// dropdown and nothing has to run at company-creation time. Classified by
// each group's standard Tally nature, since the reference software's own
// screenshot didn't show the Super Group for every row.
const DEFAULT_GROUPS = [
  { name: "BANK ACCOUNTS", superGroup: "Assets" },
  { name: "CAPITAL ACCOUNTS", superGroup: "Liability" },
  { name: "CASH ACCOUNTS", superGroup: "Assets" },
  { name: "CLOSING STOCK (TRADING)", superGroup: "Assets" },
  { name: "CURRENT ASSETS", superGroup: "Assets" },
  { name: "CURRENT LIABILITIES", superGroup: "Liability" },
  { name: "CUSTOMERS", superGroup: "Assets" },
  { name: "DEPOSIT (ASSETS)", superGroup: "Assets" },
  { name: "DEPOSIT (LIABILITY)", superGroup: "Liability" },
  { name: "EXPENSE ACCOUNTS (P&L)", superGroup: "Expense" },
  { name: "EXPENSE ACCOUNTS (TRADING)", superGroup: "Expense" },
  { name: "FIXED ASSETS", superGroup: "Assets" },
  { name: "INCOME ACCOUNTS (P&L)", superGroup: "Income" },
  { name: "INCOME ACCOUNTS (TRADING)", superGroup: "Income" },
  { name: "INDIRECT EXP A/C", superGroup: "Expense" },
  { name: "INVESTMENTS", superGroup: "Assets" },
  { name: "LOAN (ASSETS)", superGroup: "Assets" },
  { name: "LOAN (LIABILITY)", superGroup: "Liability" },
  { name: "OPENING STOCK (TRADING)", superGroup: "Assets" },
  { name: "PROFIT & LOSS ACCOUNT", superGroup: "Liability" },
  { name: "PURCHASES (TRADING)", superGroup: "Expense" },
  { name: "SALES (TRADING)", superGroup: "Income" },
  { name: "SALES MANS GROUP", superGroup: "Liability" },
  { name: "SUNDRY CREDITORS", superGroup: "Liability" },
  { name: "SUNDRY DEBTORS", superGroup: "Assets" },
  { name: "SUPPLIERS", superGroup: "Liability" },
  { name: "TRADING ACCOUNT", superGroup: "Liability" },
];

const getAccountGroups = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, search = "" } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const existingCount = await AccountGroup.countDocuments({ companyId });
    if (existingCount === 0 && !search) {
      await AccountGroup.insertMany(
        DEFAULT_GROUPS.map((g) => ({ ...g, companyId })),
        { ordered: false }
      ).catch(() => {});
      // Ignore a duplicate-key race (two near-simultaneous first-loads) — the
      // insertMany itself is best-effort seeding, not a user-facing operation.
    }

    const query = { companyId };
    if (search) query.name = searchRegex(search);

    const parsedPage = clampPage(page);
    const parsedLimit = clampLimit(limit);
    const skip = (parsedPage - 1) * parsedLimit;

    const [groups, total] = await Promise.all([
      AccountGroup.find(query).sort({ name: 1 }).skip(skip).limit(parsedLimit).lean(),
      AccountGroup.countDocuments(query),
    ]);

    res.status(200).json({
      data: groups,
      pagination: { total, page: parsedPage, limit: parsedLimit, totalPages: Math.ceil(total / parsedLimit) },
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const createAccountGroup = async (req, res) => {
  try {
    const { companyId, name, superGroup } = req.body;
    if (!companyId || !name || !superGroup) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }
    if (!SUPER_GROUPS.includes(superGroup)) {
      return res.status(400).json({ message: `Super Group must be one of: ${SUPER_GROUPS.join(", ")}` });
    }

    const exists = await AccountGroup.findOne({ companyId, name: name.trim() });
    if (exists) {
      return res.status(400).json({ message: "An Account Group with this name already exists" });
    }

    const group = await AccountGroup.create({ companyId, name: name.trim(), superGroup });
    res.status(201).json(group);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const updateAccountGroup = async (req, res) => {
  try {
    const group = await AccountGroup.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!group) {
      return res.status(404).json({ message: "Account Group not found" });
    }

    const { name, superGroup } = req.body;

    if (name) {
      const exists = await AccountGroup.findOne({ companyId: group.companyId, name: name.trim(), _id: { $ne: req.params.id } });
      if (exists) {
        return res.status(400).json({ message: "Another Account Group already exists with this name" });
      }
      group.name = name.trim();
    }

    if (superGroup !== undefined) {
      if (!SUPER_GROUPS.includes(superGroup)) {
        return res.status(400).json({ message: `Super Group must be one of: ${SUPER_GROUPS.join(", ")}` });
      }
      group.superGroup = superGroup;
    }

    await group.save();
    res.status(200).json(group);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const deleteAccountGroup = async (req, res) => {
  try {
    const group = await AccountGroup.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!group) {
      return res.status(404).json({ message: "Account Group not found" });
    }

    const hasAccount = await Account.exists({ companyId: group.companyId, accountGroupId: group._id });
    if (hasAccount) {
      return res.status(400).json({ message: "Cannot delete this group — one or more Accounts still belong to it." });
    }

    await group.deleteOne();
    res.status(200).json({ message: "Account Group deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getAccountGroups,
  createAccountGroup,
  updateAccountGroup,
  deleteAccountGroup,
};
