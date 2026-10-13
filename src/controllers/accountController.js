const Account = require("../models/Account");
const AccountGroup = require("../models/AccountGroup");
const { assertRefBelongsToCompany, searchRegex, clampLimit, clampPage } = require("../utils/queryHelpers");

// Dr/Cr is stored as a magnitude + a separate type field (matching the
// reference screenshot's Op.Balance/Cl.Balance + Dr-Cr pair exactly), but the
// actual arithmetic needs a single signed number — Dr positive, Cr negative,
// the standard accounting convention — so a sequence of postings can just be
// summed instead of needing a case split on every single one.
function toSigned(amount, type) {
  return type === "Cr" ? -amount : amount;
}
function fromSigned(signed) {
  return { amount: Math.abs(signed), type: signed < 0 ? "Cr" : "Dr" };
}

// Applies one posting to an Account's running balance — `direction` is the
// Dr/Cr side of THIS posting (not the account's own current side). An Expense
// linked to an Account always posts Dr (see expenseController.js) since
// booking an expense against a ledger account is, in plain bookkeeping terms,
// a debit to that account — this is the one and only caller of this today,
// but it's written generically since a future second poster (e.g. a Payment
// referencing an Account directly) would need the identical math.
async function applyAccountEffect(accountId, amount, direction, companyId) {
  if (!accountId || !(amount > 0)) return;
  const account = await Account.findOne({ _id: accountId, companyId });
  if (!account) throw new Error("Account not found");
  const net = toSigned(account.currentBalance, account.currentBalanceType) + toSigned(amount, direction);
  const { amount: newBalance, type: newType } = fromSigned(net);
  account.currentBalance = newBalance;
  account.currentBalanceType = newType;
  await account.save();
}

// Reverses a previously-applied posting — same math, opposite direction.
async function reverseAccountEffect(accountId, amount, direction, companyId) {
  if (!accountId || !(amount > 0)) return;
  await applyAccountEffect(accountId, amount, direction === "Dr" ? "Cr" : "Dr", companyId);
}

const getAccounts = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, search = "" } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const query = { companyId };
    if (search) query.name = searchRegex(search);

    const parsedPage = clampPage(page);
    const parsedLimit = clampLimit(limit);
    const skip = (parsedPage - 1) * parsedLimit;

    const [accounts, total] = await Promise.all([
      Account.find(query)
        .populate("accountGroupId", "name superGroup")
        .sort({ name: 1 })
        .skip(skip)
        .limit(parsedLimit)
        .lean(),
      Account.countDocuments(query),
    ]);

    res.status(200).json({
      data: accounts,
      pagination: { total, page: parsedPage, limit: parsedLimit, totalPages: Math.ceil(total / parsedLimit) },
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const getAccountById = async (req, res) => {
  try {
    const account = await Account.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!account) {
      return res.status(404).json({ message: "Account not found" });
    }
    res.status(200).json(account);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const createAccount = async (req, res) => {
  try {
    const { companyId, name, cityVillage, panNo, accountGroupId, openingBalance, openingBalanceType, isActive } = req.body;
    if (!companyId || !name || !accountGroupId) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    await assertRefBelongsToCompany(AccountGroup, accountGroupId, companyId, "Account Group");

    const exists = await Account.findOne({ companyId, name: name.trim() });
    if (exists) {
      return res.status(400).json({ message: "An Account with this name already exists" });
    }

    const opening = Math.abs(parseFloat(openingBalance)) || 0;
    const openingType = openingBalanceType === "Cr" ? "Cr" : "Dr";

    const account = await Account.create({
      companyId,
      name: name.trim(),
      cityVillage: cityVillage || "",
      panNo: panNo || "",
      accountGroupId,
      openingBalance: opening,
      openingBalanceType: openingType,
      currentBalance: opening,
      currentBalanceType: openingType,
      isActive: isActive !== undefined ? isActive : true,
    });

    res.status(201).json(account);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const updateAccount = async (req, res) => {
  try {
    const account = await Account.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!account) {
      return res.status(404).json({ message: "Account not found" });
    }

    const { name, cityVillage, panNo, accountGroupId, openingBalance, openingBalanceType, isActive } = req.body;

    if (name) {
      const exists = await Account.findOne({ companyId: account.companyId, name: name.trim(), _id: { $ne: req.params.id } });
      if (exists) {
        return res.status(400).json({ message: "Another Account already exists with this name" });
      }
      account.name = name.trim();
    }

    if (cityVillage !== undefined) account.cityVillage = cityVillage;
    if (panNo !== undefined) account.panNo = panNo;
    if (accountGroupId !== undefined) {
      await assertRefBelongsToCompany(AccountGroup, accountGroupId, account.companyId, "Account Group");
      account.accountGroupId = accountGroupId;
    }
    if (isActive !== undefined) account.isActive = isActive;

    // Changing the opening balance shifts the current balance by the same
    // delta, the identical pattern bankAccountController.updateBankAccount
    // already uses — it preserves whatever net postings have happened since,
    // rather than clobbering them back to the raw new opening value.
    if (openingBalance !== undefined || openingBalanceType !== undefined) {
      const oldSigned = toSigned(account.openingBalance, account.openingBalanceType);
      const newOpening = openingBalance !== undefined ? Math.abs(parseFloat(openingBalance)) || 0 : account.openingBalance;
      const newOpeningType = openingBalanceType !== undefined ? (openingBalanceType === "Cr" ? "Cr" : "Dr") : account.openingBalanceType;
      const newSigned = toSigned(newOpening, newOpeningType);
      const currentSigned = toSigned(account.currentBalance, account.currentBalanceType);
      const adjustedCurrentSigned = currentSigned - oldSigned + newSigned;

      account.openingBalance = newOpening;
      account.openingBalanceType = newOpeningType;
      const { amount, type } = fromSigned(adjustedCurrentSigned);
      account.currentBalance = amount;
      account.currentBalanceType = type;
    }

    await account.save();
    res.status(200).json(account);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const deleteAccount = async (req, res) => {
  try {
    const account = await Account.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!account) {
      return res.status(404).json({ message: "Account not found" });
    }

    const Expense = require("../models/Expense");
    const hasExpense = await Expense.exists({ companyId: account.companyId, accountId: account._id });
    if (hasExpense) {
      return res.status(400).json({ message: "Cannot delete this Account — one or more Expenses still reference it." });
    }

    await account.deleteOne();
    res.status(200).json({ message: "Account deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const getAccountStatement = async (req, res) => {
  try {
    // req.user.companyId is always null for super_admin — every sibling
    // single-record handler in this file (getAccountById/updateAccount/
    // deleteAccount) correctly uses req.effectiveCompanyId instead, which
    // scopeCompany resolves to an explicit company or `{ $ne: null }` for
    // that role. This one was the odd one out and always 404'd for super_admin.
    const companyId = req.effectiveCompanyId;
    const { id } = req.params;
    const { dateFrom, dateTo } = req.query;

    const account = await Account.findOne({ _id: id, companyId }).populate("accountGroupId", "name");
    if (!account) {
      return res.status(404).json({ message: "Account not found" });
    }

    const Expense = require("../models/Expense");

    // A genuine "balance as of dateFrom" — mirrors reportController.buildLedger's
    // own before-range accumulation for the Customer/Supplier Ledger, and the
    // identical fix just applied to bankAccountController.getBankAccountStatement.
    // Without this, applying a dateFrom filter silently ignored every Expense
    // dated before it, leaving the table's running balance out of sync with
    // the always-live "Current Balance" KPI shown next to it.
    let openingBalanceAsOf = account.openingBalance || 0;
    let openingBalanceTypeAsOf = account.openingBalanceType || "Dr";
    if (dateFrom) {
      const toSigned = (amount, type) => (type === "Cr" ? -amount : amount);
      let signed = toSigned(openingBalanceAsOf, openingBalanceTypeAsOf);
      const priorExpenses = await Expense.find({
        accountId: id,
        companyId,
        expenseDate: { $lt: new Date(dateFrom) },
      }).select("amount");
      // Expenses always post Dr to the account (see applyAccountEffect) —
      // mirrors that same convention here rather than re-deriving it.
      for (const e of priorExpenses) signed += e.amount;
      openingBalanceAsOf = Math.abs(signed);
      openingBalanceTypeAsOf = signed < 0 ? "Cr" : "Dr";
    }

    // Find all Expenses linked to this account
    let filter = { accountId: id, companyId };
    if (dateFrom || dateTo) {
      filter.expenseDate = {};
      if (dateFrom) filter.expenseDate.$gte = new Date(dateFrom);
      if (dateTo) filter.expenseDate.$lte = new Date(dateTo);
    }

    const expenses = await Expense.find(filter)
      .populate("bankAccountId", "bankName accountNumber")
      .sort({ expenseDate: 1, createdAt: 1 })
      .lean();

    res.status(200).json({ account, expenses, openingBalanceAsOf, openingBalanceTypeAsOf });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getAccounts,
  getAccountById,
  createAccount,
  updateAccount,
  deleteAccount,
  getAccountStatement,
  applyAccountEffect,
  reverseAccountEffect,
};
