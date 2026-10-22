const Expense = require("../models/Expense");
const BankAccount = require("../models/BankAccount");
const Payment = require("../models/Payment");
const Narration = require("../models/Narration");
const { searchRegex, clampLimit, clampPage, assertRefBelongsToCompany } = require("../utils/queryHelpers");
const { usesBankAccount } = require("../utils/paymentModes");
const { applyAccountEffect, reverseAccountEffect } = require("./accountController");
const { sendLedgerPdf } = require("../utils/tallyPdf");

// `narrationIds` (array of Narration _id strings from the client) is resolved
// against the company's own Narration master and snapshotted into
// {narrationId, type, code} — see Expense.js's NarrationRefSchema comment for
// why this is a copy, not a live reference. Invalid/foreign ids are silently
// dropped rather than rejecting the whole save — narrations are an
// informational tag, not load-bearing data worth blocking an expense over.
async function resolveNarrations(clientNarrations, companyId) {
  if (!Array.isArray(clientNarrations) || clientNarrations.length === 0) return [];
  const isStringArray = typeof clientNarrations[0] === 'string' || clientNarrations[0] instanceof String;
  const ids = isStringArray ? clientNarrations : clientNarrations.map(n => n.narrationId || n._id);

  const docs = await Narration.find({ _id: { $in: ids }, companyId }).lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));

  return clientNarrations
    .map((cn) => {
      const id = isStringArray ? cn : (cn.narrationId || cn._id);
      const d = byId.get(String(id));
      if (!d) return null;
      return {
        narrationId: d._id,
        type: d.type,
        code: isStringArray ? d.code : (cn.code !== undefined ? cn.code : d.code)
      };
    })
    .filter(Boolean);
}

const getExpenses = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, search = "", dateFrom, dateTo } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const query = { companyId };
    if (search) query.title = searchRegex(search);
    if (dateFrom || dateTo) {
      query.expenseDate = {};
      if (dateFrom) query.expenseDate.$gte = new Date(dateFrom);
      if (dateTo) query.expenseDate.$lte = new Date(dateTo);
    }

    const parsedPage = clampPage(page);
    const parsedLimit = clampLimit(limit);
    const skip = (parsedPage - 1) * parsedLimit;

    const [expenses, total] = await Promise.all([
      Expense.find(query)
        .populate("bankAccountId", "bankName accountNumber")
        .populate("accountId", "name")
        .sort({ expenseDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit)
        .lean(),
      Expense.countDocuments(query),
    ]);

    res.status(200).json({
      data: expenses,
      pagination: {
        total,
        page: parsedPage,
        limit: parsedLimit,
        totalPages: Math.ceil(total / parsedLimit),
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

// GET /api/expenses/export?companyId=&search=&dateFrom=&dateTo=
// Tally-style "Ledger Account" PDF of the Expenses register — honours the
// exact same search/dateFrom/dateTo filters getExpenses above accepts, so the
// PDF always matches whatever the list page is currently showing. Unpaginated
// by design: a statement needs the whole filtered set, not one page of it
// (same choice the Ledgers and the Full Stock report already make).
const exportExpenseStatement = async (req, res) => {
  try {
    const companyId = req.effectiveCompanyId;
    const { search = "", dateFrom, dateTo } = req.query;

    const query = { companyId };
    if (search) query.title = searchRegex(search);
    if (dateFrom || dateTo) {
      query.expenseDate = {};
      if (dateFrom) query.expenseDate.$gte = new Date(dateFrom);
      if (dateTo) query.expenseDate.$lte = new Date(dateTo);
    }

    // Ascending, unlike getExpenses' newest-first list ordering — a ledger
    // statement reads oldest-to-newest (see CLAUDE.md's ledger-ordering fix).
    const expenses = await Expense.find(query)
      .sort({ expenseDate: 1, createdAt: 1 })
      .lean();

    // Every expense is money out, i.e. a debit. There's no counter-party to
    // credit here (this is a register of expenses, not a two-sided account),
    // so credit is always 0 and the renderer's balancing Closing Balance row
    // carries the total.
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

    await sendLedgerPdf(res, {
      company,
      // No single counter-party exists for a whole expense register.
      party: { name: "Expenses" },
      dateFrom,
      dateTo,
      ledger: { openingBalance: 0, entries },
      filename: "Expenses_Statement.pdf",
      isDebtor: false,
    });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ message: error.message || "Server Error" });
    }
  }
};

const getExpenseById = async (req, res) => {
  try {
    const expense = await Expense.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!expense) {
      return res.status(404).json({ message: "Expense not found" });
    }
    res.status(200).json(expense);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const createExpense = async (req, res) => {
  let expense;
  try {
    const { companyId, expenseDate, title, category, amount, paymentMode, bankAccountId, accountId, narrationIds, referenceNo, notes } = req.body;

    if (!companyId || !expenseDate || !title || !category || !amount || !paymentMode) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const expenseAmount = Number(amount);
    if (!(expenseAmount > 0)) {
      return res.status(400).json({ message: "Amount must be greater than 0" });
    }

    if (usesBankAccount(paymentMode)) {
      if (!bankAccountId) {
         return res.status(400).json({ message: "Bank Account is required for this payment mode" });
      }
      const bank = await BankAccount.findById(bankAccountId);
      if (!bank || String(bank.companyId) !== companyId) {
        return res.status(404).json({ message: "Bank account not found" });
      }
      if ((bank.currentBalance || 0) < expenseAmount) {
        return res.status(400).json({ message: "Insufficient balance in selected Bank Account" });
      }
    }

    if (accountId) {
      const Account = require("../models/Account");
      await assertRefBelongsToCompany(Account, accountId, companyId, "Account");
    }

    const narrations = await resolveNarrations(narrationIds, companyId);

    expense = await Expense.create({
      companyId,
      expenseDate,
      title,
      category,
      amount: expenseAmount,
      paymentMode,
      bankAccountId: usesBankAccount(paymentMode) ? bankAccountId : null,
      accountId: accountId || null,
      narrations,
      referenceNo: referenceNo || "",
      notes: notes || "",
    });

    // Bank debit, Account Dr effect, and the Payment record are all wrapped in
    // the SAME try/catch — a failure in any one of them must delete the
    // just-created Expense and reverse whatever already applied, matching the
    // discipline the transactional controllers' payment reconciliation
    // already established (see CLAUDE.md quirk #53/#54 — an earlier version
    // of that fix only wrapped one of several steps and left orphaned
    // documents behind when a later step failed).
    try {
      if (usesBankAccount(paymentMode)) {
        await BankAccount.findByIdAndUpdate(bankAccountId, { $inc: { currentBalance: -expenseAmount } });
      }
      if (accountId) {
        await applyAccountEffect(accountId, expenseAmount, "Dr", companyId);
      }
      // Create a Payment record for the expense to show up in ledgers
      await Payment.create({
        companyId,
        paymentDate: expenseDate,
        paymentType: "Pay",
        partyType: "Expense",
        partyId: expense._id, // Using expense ID as party ID for now
        paymentMode: paymentMode,
        bankAccountId: usesBankAccount(paymentMode) ? bankAccountId : null,
        amount: expenseAmount,
        referenceNo: referenceNo || "",
        notes: `Expense: ${title} (${category})`,
        narrations: expense.narrations || [],
        allocations: []
      });
    } catch (err) {
      await Expense.deleteOne({ _id: expense._id });
      if (usesBankAccount(paymentMode)) {
        await BankAccount.findByIdAndUpdate(bankAccountId, { $inc: { currentBalance: expenseAmount } }).catch(() => {});
      }
      if (accountId) {
        await reverseAccountEffect(accountId, expenseAmount, "Dr", companyId).catch(() => {});
      }
      throw err;
    }

    res.status(201).json(expense);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const deleteExpense = async (req, res) => {
  try {
    const expense = await Expense.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!expense) {
      return res.status(404).json({ message: "Expense not found" });
    }

    // The `bankAccountId` guard is what keeps the historical UPI expenses safe:
    // those were recorded before UPI debited anything, so they carry a null
    // bankAccountId and must NOT be credited back on delete — crediting them
    // would invent money that was never deducted.
    if (usesBankAccount(expense.paymentMode) && expense.bankAccountId) {
      await BankAccount.findByIdAndUpdate(expense.bankAccountId, {
        $inc: { currentBalance: expense.amount }
      });
    }

    if (expense.accountId) {
      await reverseAccountEffect(expense.accountId, expense.amount, "Dr", expense.companyId);
    }

    // Delete the linked payment
    await Payment.findOneAndDelete({
      companyId: expense.companyId,
      partyType: "Expense",
      partyId: expense._id
    });

    await expense.deleteOne();

    res.status(200).json({ message: "Expense deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const updateExpense = async (req, res) => {
  try {
    const expense = await Expense.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!expense) return res.status(404).json({ message: "Expense not found" });

    const { companyId, title, category, expenseDate, amount, paymentMode, bankAccountId, accountId, narrationIds, referenceNo, notes } = req.body;
    
    const newAmount = Number(amount);
    if (!(newAmount > 0)) {
      return res.status(400).json({ message: "Amount must be greater than 0" });
    }

    if (usesBankAccount(paymentMode)) {
      if (!bankAccountId) return res.status(400).json({ message: "Bank Account is required for this payment mode" });
      const bank = await BankAccount.findOne({ _id: bankAccountId, companyId });
      if (!bank) return res.status(404).json({ message: "Bank account not found" });
    }

    if (accountId) {
      const Account = require("../models/Account");
      await assertRefBelongsToCompany(Account, accountId, companyId, "Account");
    }

    // 1. Reverse old effects
    if (usesBankAccount(expense.paymentMode) && expense.bankAccountId) {
      await BankAccount.findByIdAndUpdate(expense.bankAccountId, { $inc: { currentBalance: expense.amount } });
    }
    if (expense.accountId) {
      await reverseAccountEffect(expense.accountId, expense.amount, "Dr", expense.companyId);
    }

    // Unlike createExpense (which checks the bank can absorb the debit BEFORE
    // creating anything), this update path previously had no equivalent check
    // at all — only confirming the bank account exists, never that it can
    // actually cover the new (possibly larger, possibly newly-bank-mode)
    // amount. An edit that increases the amount or switches Cash→Bank could
    // silently drive currentBalance negative. Checked post-reversal (the bank
    // the OLD amount was just credited back to, which may be the same account
    // the NEW amount is about to debit), mirroring bankTransferController's
    // own reverse-then-validate-then-apply order.
    if (usesBankAccount(paymentMode)) {
      const freshBank = await BankAccount.findById(bankAccountId);
      if ((freshBank?.currentBalance || 0) < newAmount) {
        // Undo the reversal above before refusing — this request must leave
        // the original expense's effects exactly as they were.
        if (usesBankAccount(expense.paymentMode) && expense.bankAccountId) {
          await BankAccount.findByIdAndUpdate(expense.bankAccountId, { $inc: { currentBalance: -expense.amount } });
        }
        if (expense.accountId) {
          await applyAccountEffect(expense.accountId, expense.amount, "Dr", expense.companyId);
        }
        return res.status(400).json({ message: "Insufficient balance in selected Bank Account" });
      }
    }

    // 2. Apply new effects
    try {
      if (usesBankAccount(paymentMode)) {
        await BankAccount.findByIdAndUpdate(bankAccountId, { $inc: { currentBalance: -newAmount } });
      }
      if (accountId) {
        await applyAccountEffect(accountId, newAmount, "Dr", companyId);
      }
    } catch (err) {
      // Revert the reversal
      if (usesBankAccount(expense.paymentMode) && expense.bankAccountId) {
        await BankAccount.findByIdAndUpdate(expense.bankAccountId, { $inc: { currentBalance: -expense.amount } }).catch(() => {});
      }
      if (expense.accountId) {
        await applyAccountEffect(expense.accountId, expense.amount, "Dr", expense.companyId).catch(() => {});
      }
      throw err;
    }

    if (title) expense.title = title;
    if (category) expense.category = category;
    if (expenseDate) expense.expenseDate = expenseDate;
    if (newAmount) expense.amount = newAmount;
    if (paymentMode) expense.paymentMode = paymentMode;
    expense.bankAccountId = usesBankAccount(paymentMode) ? bankAccountId : null;
    expense.accountId = accountId || null;
    if (referenceNo !== undefined) expense.referenceNo = referenceNo;
    if (notes !== undefined) expense.notes = notes;
    
    if (narrationIds !== undefined) {
      expense.narrations = await resolveNarrations(narrationIds, expense.companyId);
    }

    await expense.save();

    // Also update the linked payment's notes/date if needed
    const linkedPayment = await Payment.findOne({ companyId: expense.companyId, partyType: "Expense", partyId: expense._id });
    if (linkedPayment) {
      linkedPayment.notes = `Expense: ${expense.title} (${expense.category})`;
      linkedPayment.paymentDate = expense.expenseDate;
      linkedPayment.amount = expense.amount;
      linkedPayment.paymentMode = expense.paymentMode;
      linkedPayment.bankAccountId = expense.bankAccountId;
      linkedPayment.referenceNo = expense.referenceNo;
      linkedPayment.narrations = expense.narrations || [];
      await linkedPayment.save();
    }

    res.status(200).json(expense);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getExpenses,
  exportExpenseStatement,
  getExpenseById,
  createExpense,
  updateExpense,
  deleteExpense
};
