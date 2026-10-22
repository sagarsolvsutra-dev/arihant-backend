const BankAccount = require("../models/BankAccount");
const Payment = require("../models/Payment");
const Expense = require("../models/Expense");
const BankTransfer = require("../models/BankTransfer");
const Sale = require("../models/Sale");
const Purchase = require("../models/Purchase");
const SaleReturn = require("../models/SaleReturn");
const PurchaseReturn = require("../models/PurchaseReturn");
const Company = require("../models/Company");
const { sendLedgerPdf } = require("../utils/tallyPdf");

const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

exports.createBankAccount = async (req, res) => {
  try {
    const companyId = req.effectiveCompanyId;
    const { bankName, accountNumber, branch, ifscCode, openingBalance, status } = req.body;

    const existingAccount = await BankAccount.findOne({ companyId, bankName });
    if (existingAccount) {
      return res.status(400).json({ message: "Bank Account with this name already exists for this company" });
    }

    const bankAccount = new BankAccount({
      companyId,
      bankName,
      accountNumber,
      branch,
      ifscCode,
      openingBalance: Number(openingBalance) || 0,
      currentBalance: Number(openingBalance) || 0,
      status: status || "Active"
    });

    await bankAccount.save();
    res.status(201).json({ message: "Bank Account created successfully", bankAccount });
  } catch (error) {
    console.error("Error creating bank account:", error);
    res.status(500).json({ message: "Error creating bank account", error: error.message });
  }
};

exports.getBankAccounts = async (req, res) => {
  try {
    const companyId = req.effectiveCompanyId;
    const bankAccounts = await BankAccount.find({ companyId }).sort({ createdAt: -1 });
    res.status(200).json({ bankAccounts });
  } catch (error) {
    console.error("Error fetching bank accounts:", error);
    res.status(500).json({ message: "Error fetching bank accounts", error: error.message });
  }
};

exports.updateBankAccount = async (req, res) => {
  try {
    const companyId = req.effectiveCompanyId;
    const { id } = req.params;
    const { bankName, accountNumber, branch, ifscCode, openingBalance, status } = req.body;

    const bankAccount = await BankAccount.findOne({ _id: id, companyId });
    if (!bankAccount) {
      return res.status(404).json({ message: "Bank Account not found" });
    }

    // Checking name conflict if name changed
    if (bankName !== bankAccount.bankName) {
      const existingAccount = await BankAccount.findOne({ companyId, bankName });
      if (existingAccount) {
        return res.status(400).json({ message: "Another Bank Account with this name already exists" });
      }
    }

    // Only shift the balance if the caller actually sent an openingBalance —
    // an omitted field must mean "leave it unchanged," not "treat it as 0."
    // accountController.updateAccount already guards this identically; this
    // function previously didn't, so a request that left openingBalance out
    // would silently zero it out and subtract the entire original opening
    // balance from currentBalance. Not reachable through the current Add/Edit
    // modal (which always resends it), but a real latent gap for any direct
    // API call or future form change that stops always-resending this field.
    if (openingBalance !== undefined) {
      const diff = (Number(openingBalance) || 0) - bankAccount.openingBalance;
      bankAccount.currentBalance += diff;
      bankAccount.openingBalance = Number(openingBalance) || 0;
    }

    bankAccount.bankName = bankName;
    bankAccount.accountNumber = accountNumber;
    bankAccount.branch = branch;
    bankAccount.ifscCode = ifscCode;
    bankAccount.status = status || bankAccount.status;

    await bankAccount.save();
    res.status(200).json({ message: "Bank Account updated successfully", bankAccount });
  } catch (error) {
    console.error("Error updating bank account:", error);
    res.status(500).json({ message: "Error updating bank account", error: error.message });
  }
};

exports.deleteBankAccount = async (req, res) => {
  try {
    const companyId = req.effectiveCompanyId;
    const { id } = req.params;
    
    const bankAccount = await BankAccount.findOne({ _id: id, companyId });
    if (!bankAccount) {
      return res.status(404).json({ message: "Bank Account not found" });
    }

    const [
      hasPayment,
      hasExpense,
      hasTransfer,
      hasSale,
      hasPurchase,
      hasSaleReturn,
      hasPurchaseReturn,
      hasCompanyDefault,
    ] = await Promise.all([
      Payment.exists({ companyId, bankAccountId: id }),
      Expense.exists({ companyId, bankAccountId: id }),
      BankTransfer.exists({ companyId, $or: [{ fromBankId: id }, { toBankId: id }] }),
      Sale.exists({ companyId, bankAccountId: id }),
      Purchase.exists({ companyId, bankAccountId: id }),
      SaleReturn.exists({ companyId, bankAccountId: id }),
      PurchaseReturn.exists({ companyId, bankAccountId: id }),
      Company.exists({ _id: companyId, defaultBankAccountId: id }),
    ]);

    if (
      hasPayment ||
      hasExpense ||
      hasTransfer ||
      hasSale ||
      hasPurchase ||
      hasSaleReturn ||
      hasPurchaseReturn ||
      hasCompanyDefault
    ) {
      return res.status(400).json({
        message:
          "Cannot delete this Bank Account — it is referenced in transactions (payments, expenses, transfers, invoices, or company default bank). Deactivate it or reassign references first.",
      });
    }

    await bankAccount.deleteOne();
    res.status(200).json({ message: "Bank Account deleted successfully" });
  } catch (error) {
    console.error("Error deleting bank account:", error);
    res.status(500).json({ message: "Error deleting bank account", error: error.message });
  }
};

// Shared by getBankAccountStatement (JSON, for the on-screen statement page)
// and exportBankAccountStatement (the Tally-style PDF) so the two can never
// disagree about what's in the statement or what the opening balance is —
// same single-builder convention reportController already uses for the
// Customer/Supplier Ledger (loadCustomerLedgerEntries/buildLedger).
// Returns null when the bank account doesn't exist in this company.
async function buildBankStatement(companyId, id, dateFrom, dateTo) {
  const bankAccount = await BankAccount.findOne({ _id: id, companyId });
  if (!bankAccount) return null;

  let filter = { bankAccountId: id, companyId };
  if (dateFrom || dateTo) {
    filter.paymentDate = {};
    if (dateFrom) filter.paymentDate.$gte = new Date(dateFrom);
    if (dateTo) filter.paymentDate.$lte = new Date(dateTo);
  }

  // A genuine "balance as of dateFrom" — mirrors reportController.buildLedger's
  // own before-range accumulation for the Customer/Supplier Ledger. Without
  // this, applying a dateFrom filter used to seed the running balance from
  // the account's raw, all-time openingBalance and silently ignore every
  // payment dated before the filter — the table's own running balance would
  // then end up understated relative to the always-live "Current Balance"
  // KPI shown right next to it. With no dateFrom, this is identical to the
  // raw openingBalance (nothing to fold in).
  let openingBalanceAsOf = bankAccount.openingBalance || 0;
  if (dateFrom) {
    const priorPayments = await Payment.find({
      bankAccountId: id,
      companyId,
      paymentDate: { $lt: new Date(dateFrom) },
    }).select("paymentType amount");
    for (const p of priorPayments) {
      if (p.paymentType === "Receive") openingBalanceAsOf += p.amount;
      else if (p.paymentType === "Pay") openingBalanceAsOf -= p.amount;
    }
  }
  openingBalanceAsOf = round2(openingBalanceAsOf);

  const payments = await Payment.find(filter)
    .populate("partyId", "name companyName bankName accountNumber title category")
    .sort({ paymentDate: 1, createdAt: 1 });

  return { bankAccount, payments, openingBalanceAsOf };
}

exports.getBankAccountStatement = async (req, res) => {
  try {
    const companyId = req.effectiveCompanyId;
    const { id } = req.params;
    const { dateFrom, dateTo } = req.query;

    const built = await buildBankStatement(companyId, id, dateFrom, dateTo);
    if (!built) {
      return res.status(404).json({ message: "Bank Account not found" });
    }
    const { bankAccount, payments, openingBalanceAsOf } = built;

    res.status(200).json({ bankAccount, payments, openingBalanceAsOf });
  } catch (error) {
    console.error("Error fetching bank statement:", error);
    res.status(500).json({ message: "Error fetching bank statement", error: error.message });
  }
};

// GET /api/bank-accounts/:id/statement/export?dateFrom=&dateTo=
// Tally-style "Ledger Account" PDF of one bank account's statement — the exact
// same renderer the Customer/Supplier Ledgers print through (utils/tallyPdf.js).
exports.exportBankAccountStatement = async (req, res) => {
  try {
    const companyId = req.effectiveCompanyId;
    const { id } = req.params;
    const { dateFrom, dateTo } = req.query;

    const built = await buildBankStatement(companyId, id, dateFrom, dateTo);
    if (!built) {
      return res.status(404).json({ message: "Bank Account not found" });
    }
    const { bankAccount, payments, openingBalanceAsOf } = built;

    // Dr/Cr DIRECTION — money IN is a CREDIT, money OUT is a DEBIT, and
    // `isDebtor: false` (credit increases the balance).
    //
    // Chosen to match what the existing on-screen statement
    // (bank-accounts/[id]/page.tsx) already shows, so the PDF and the page can
    // never disagree: that page puts a "Receive" payment in its `credit` field
    // under the "Money In" column and ADDS it to the running balance, and puts
    // a "Pay" in `debit` under "Money Out" and SUBTRACTS it. Credit increasing
    // the balance is exactly what `isDebtor: false` means in tallyPdf's own
    // opening-balance split, so a positive bank balance correctly lands on the
    // Credit side there too — the same creditor-style convention the Supplier
    // Ledger already uses.
    const entries = payments.map((p) => {
      const isIn = p.paymentType === "Receive";
      const party = p.partyId || {};
      let particulars;
      if (p.partyType === "BankAccount") particulars = `${party.bankName || "Bank"} (Bank Transfer)`;
      else if (p.partyType === "Expense") particulars = `${party.title || "Expense"} (Expense)`;
      else particulars = party.name || party.companyName || p.paymentMode || "-";

      // Same referenceNo → narration-codes → "-" fallback chain the on-screen
      // statement and the Customer/Supplier Ledger's own paymentRef both use.
      const vchNo =
        p.referenceNo ||
        (Array.isArray(p.narrations) && p.narrations.length > 0
          ? p.narrations.map((n) => n.code).filter(Boolean).join(", ")
          : "") ||
        "-";

      return {
        date: p.paymentDate,
        particulars,
        type: isIn ? "Receipt" : "Payment",
        vchType: isIn ? "Receipt" : "Payment",
        vchNo,
        ref: vchNo,
        opposingDrCr: isIn ? "Cr" : "Dr",
        debit: isIn ? 0 : p.amount,
        credit: isIn ? p.amount : 0,
      };
    });

    // The bank account stands in for the "party" block on the letterhead.
    // Branch is folded into the address line (there is no separate field for
    // it); city/state/pincode have no equivalent on a BankAccount at all.
    const partyAddressParts = [];
    if (bankAccount.branch) partyAddressParts.push(`BRANCH: ${bankAccount.branch}`);
    if (bankAccount.ifscCode) partyAddressParts.push(`IFSC: ${bankAccount.ifscCode}`);

    const company = await Company.findById(companyId).lean();
    const safeName = String(bankAccount.bankName || "Bank").replace(/[^A-Za-z0-9_-]+/g, "_");

    await sendLedgerPdf(res, {
      company,
      party: {
        name: `${bankAccount.bankName || "Bank"} - ${bankAccount.accountNumber || "-"}`,
        address: partyAddressParts.join("  |  "),
        city: "",
        state: "",
        pincode: "",
        gstNo: "",
      },
      dateFrom,
      dateTo,
      ledger: { openingBalance: openingBalanceAsOf, entries },
      filename: `${safeName}_Statement.pdf`,
      isDebtor: false,
    });
  } catch (error) {
    console.error("Error exporting bank statement:", error);
    if (!res.headersSent) {
      res.status(500).json({ message: "Error exporting bank statement", error: error.message });
    }
  }
};

exports.transferFunds = async (req, res) => {
  try {
    const companyId = req.effectiveCompanyId;
    const { fromBankId, toBankId, amount, date, notes } = req.body;

    if (!fromBankId || !toBankId || !amount || !date) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    if (fromBankId === toBankId) {
      return res.status(400).json({ message: "Cannot transfer to the same bank account" });
    }

    const transferAmount = Number(amount);
    if (transferAmount <= 0) {
      return res.status(400).json({ message: "Transfer amount must be greater than 0" });
    }

    const fromBank = await BankAccount.findOne({ _id: fromBankId, companyId });
    const toBank = await BankAccount.findOne({ _id: toBankId, companyId });

    if (!fromBank || !toBank) {
      return res.status(404).json({ message: "One or both bank accounts not found" });
    }

    if (fromBank.currentBalance < transferAmount) {
      return res.status(400).json({ message: "Insufficient balance in the source bank account" });
    }

    // Deduct from source bank
    fromBank.currentBalance = round2((fromBank.currentBalance || 0) - transferAmount);
    await fromBank.save();

    // Add to destination bank
    toBank.currentBalance = round2((toBank.currentBalance || 0) + transferAmount);
    await toBank.save();

    // Create Payment for Source (Money Out)
    await Payment.create({
      companyId,
      paymentDate: date,
      paymentType: "Pay",
      partyType: "BankAccount",
      partyId: toBank._id, // The party is the destination bank
      paymentMode: "Bank",
      bankAccountId: fromBank._id,
      amount: transferAmount,
      notes: notes || `Transfer to ${toBank.bankName}`,
    });

    // Create Payment for Destination (Money In)
    await Payment.create({
      companyId,
      paymentDate: date,
      paymentType: "Receive",
      partyType: "BankAccount",
      partyId: fromBank._id, // The party is the source bank
      paymentMode: "Bank",
      bankAccountId: toBank._id,
      amount: transferAmount,
      notes: notes || `Transfer from ${fromBank.bankName}`,
    });

    res.status(200).json({ message: "Funds transferred successfully" });
  } catch (error) {
    console.error("Error transferring funds:", error);
    res.status(500).json({ message: "Error transferring funds", error: error.message });
  }
};
