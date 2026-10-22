const Account = require("../models/Account");
const AccountGroup = require("../models/AccountGroup");
const { assertRefBelongsToCompany, searchRegex, clampLimit, clampPage } = require("../utils/queryHelpers");
const { sendLedgerPdf } = require("../utils/tallyPdf");

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

// Shared by getAccountStatement (JSON, for the on-screen statement page) and
// exportAccountStatement (the Tally-style PDF) so the two can never disagree
// about what's in the statement or what the opening balance is — the same
// single-builder convention reportController already uses for the
// Customer/Supplier Ledger. Returns null when the Account doesn't exist in
// this company.
async function buildAccountStatement(companyId, id, dateFrom, dateTo) {
    const account = await Account.findOne({ _id: id, companyId }).populate("accountGroupId", "name");
    if (!account) return null;

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
    // Reuses this file's own module-level toSigned (Dr positive, Cr negative)
    // rather than redeclaring a local copy of it.
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

  return { account, expenses, openingBalanceAsOf, openingBalanceTypeAsOf };
}

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

    const built = await buildAccountStatement(companyId, id, dateFrom, dateTo);
    if (!built) {
      return res.status(404).json({ message: "Account not found" });
    }

    res.status(200).json(built);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

// GET /api/accounts/:id/statement/export?dateFrom=&dateTo=
// Tally-style "Ledger Account" PDF for one chart-of-accounts Account — same
// shared renderer (utils/tallyPdf.js) the Customer/Supplier Ledgers use.
const exportAccountStatement = async (req, res) => {
  try {
    const companyId = req.effectiveCompanyId;
    const { id } = req.params;
    const { dateFrom, dateTo } = req.query;

    const built = await buildAccountStatement(companyId, id, dateFrom, dateTo);
    if (!built) {
      return res.status(404).json({ message: "Account not found" });
    }
    const { account, expenses, openingBalanceAsOf, openingBalanceTypeAsOf } = built;

    // sendLedgerPdf wants ONE signed opening balance; the Account model stores
    // a non-negative magnitude plus a separate Dr/Cr type.
    //
    // ⚠ The sign here is the OPPOSITE of this file's own toSigned() (Dr
    // positive, Cr negative) — deliberately, and verified against real data
    // rather than assumed. toSigned's convention is internal to
    // applyAccountEffect's arithmetic; sendLedgerPdf's `openingBalance` sign
    // means something different, and what it means depends on `isDebtor`.
    // Under `isDebtor: false` the renderer puts a POSITIVE opening on the
    // CREDIT side and a NEGATIVE one on the DEBIT side, so a Dr opening has
    // to be passed as negative to land in the Debit column — which is where
    // the on-screen statement (accounts/[id]/page.tsx) already puts it.
    //
    // Passing toSigned()'s value straight through instead put the Dr opening
    // on the Credit side and SUBTRACTED it: an account with a 1,000 Dr
    // opening and one 10,000 Dr expense printed a 9,000 Dr closing balance
    // when its real, live currentBalance is 11,000 Dr. Caught by comparing
    // the generated PDF against the account's own stored balance.
    const openingSigned = -toSigned(openingBalanceAsOf, openingBalanceTypeAsOf);

    // Every Expense posts Dr to the Account (see applyAccountEffect) — so each
    // row is a debit, never a credit.
    const entries = expenses.map((e) => {
      const vchNo =
        e.referenceNo ||
        (Array.isArray(e.narrations) && e.narrations.length > 0
          ? e.narrations.map((n) => n.code).filter(Boolean).join(", ")
          : "") ||
        "-";
      return {
        date: e.expenseDate,
        particulars: e.category ? `${e.title} (${e.category})` : e.title,
        type: "Expense",
        vchType: "Expense",
        vchNo,
        ref: vchNo,
        opposingDrCr: "Dr",
        debit: e.amount,
        credit: 0,
      };
    });

    const Company = require("../models/Company");
    const company = await Company.findById(companyId).lean();
    const safeName = String(account.name || "Account").replace(/[^A-Za-z0-9_-]+/g, "_");

    await sendLedgerPdf(res, {
      company,
      party: {
        name: account.name,
        address: "",
        city: account.cityVillage || "",
        state: "",
        pincode: "",
        // panNo is a PAN, NOT a GSTIN — printing it under a "GSTIN:" label
        // would be plainly wrong, so this stays blank.
        gstNo: "",
      },
      dateFrom,
      dateTo,
      ledger: { openingBalance: openingSigned, entries },
      filename: `${safeName}_Statement.pdf`,
      isDebtor: false,
    });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ message: error.message || "Server Error" });
    }
  }
};

module.exports = {
  getAccounts,
  getAccountById,
  createAccount,
  updateAccount,
  deleteAccount,
  getAccountStatement,
  exportAccountStatement,
  applyAccountEffect,
  reverseAccountEffect,
};
