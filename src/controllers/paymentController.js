const Payment = require("../models/Payment");
const Sale = require("../models/Sale");
const Purchase = require("../models/Purchase");
const Item = require("../models/Item");
const Customer = require("../models/Customer");
const Supplier = require("../models/Supplier");
const BankAccount = require("../models/BankAccount");
const Narration = require("../models/Narration");
const { isValidObjectId } = require("../utils/queryHelpers");
const { usesBankAccount } = require("../utils/paymentModes");
const { sendLedgerPdf } = require("../utils/tallyPdf");

// partyId is only ever a real Customer/Supplier when it came from the /payments
// page itself (see DERIVED_PARTY_TYPES below for the two other partyTypes that
// bypass this entirely) — without this check a caller could point partyId at
// another company's real Customer/Supplier _id and have it populate straight
// into this company's own Payments list (getPayments' .populate("partyId", ...)),
// a cross-tenant information leak even though no balance actually moves.
async function assertPartyBelongsToCompany(partyType, partyId, companyId) {
  if (partyType === "Customer") {
    const exists = await Customer.exists({ _id: partyId, companyId });
    if (!exists) return "Invalid Customer — not found in this company";
  } else if (partyType === "Supplier") {
    const exists = await Supplier.exists({ _id: partyId, companyId });
    if (!exists) return "Invalid Supplier — not found in this company";
  }
  return null;
}

// Resolves client-submitted Narration ids against the company's own Narration
// master and snapshots {narrationId, type, code} — see Expense.js's
// NarrationRefSchema comment for why this is a copy, not a live reference.
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

// Money here is plain JS floats that have already been through at least one
// round of arithmetic (an invoice's pendingAmount is netAmount - paid), so an
// exact `>` comparison would refuse a legitimate "settle the rest of it"
// allocation that overshoots by 1e-13. There is no shared rounding helper in
// this codebase, so amounts are rounded to paise and compared with a one-paise
// tolerance — the same granularity every other money figure is displayed at.
const MONEY_EPSILON = 0.01;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Validates a payment's allocations against the payment's own amount and
// against each target invoice's real outstanding balance. Returns an error
// message, or null when the allocations are sound.
//
// MUST be called before any bank balance or invoice is touched:
// applyPaymentEffects has no rollback of its own, and an allocation whose
// invoiceId matches nothing is a silent no-op there — the bank balance still
// moves and the invoice is never credited, so the money simply disappears.
//
// `existingPayment` is the payment being edited, if any. Its allocations have
// already been taken off the invoices' pendingAmount, so they are added back to
// form the basis the new allocation is judged against — without that, re-saving
// a payment would be refused against its own prior allocation.
async function validateAllocations({ companyId, partyType, amount, allocations, existingPayment }) {
  if (!Array.isArray(allocations) || allocations.length === 0) return null;

  const InvoiceModel = partyType === "Customer" ? Sale : partyType === "Supplier" ? Purchase : null;
  if (!InvoiceModel) {
    // applyPaymentEffects only knows how to credit a Sale or a Purchase; an
    // allocation under any other partyType would be silently dropped.
    return "Allocations are only supported for Customer or Supplier payments";
  }

  // Summed per invoice first: two allocation rows pointing at the same invoice
  // are each affordable on their own but together can overpay it.
  const perInvoice = new Map();
  let totalAllocated = 0;
  for (const alloc of allocations) {
    const allocated = round2(parseFloat(alloc && alloc.allocatedAmount));
    if (!Number.isFinite(allocated) || allocated <= 0) {
      return "Each allocated amount must be greater than 0";
    }
    const invoiceId = alloc.invoiceId ? String(alloc.invoiceId) : "";
    if (!isValidObjectId(invoiceId)) {
      return "Allocation refers to an invalid invoice";
    }
    perInvoice.set(invoiceId, round2((perInvoice.get(invoiceId) || 0) + allocated));
    totalAllocated = round2(totalAllocated + allocated);
  }

  const paymentAmount = round2(amount);
  if (totalAllocated > paymentAmount + MONEY_EPSILON) {
    return `Allocated total (${totalAllocated.toFixed(2)}) exceeds the payment amount (${paymentAmount.toFixed(2)})`;
  }

  const invoices = await InvoiceModel.find(
    { _id: { $in: [...perInvoice.keys()] }, companyId },
    "_id invoiceNo pendingAmount"
  ).lean();
  const invoiceById = new Map(invoices.map((inv) => [String(inv._id), inv]));

  const priorByInvoice = new Map();
  for (const alloc of (existingPayment && existingPayment.allocations) || []) {
    const invoiceId = String(alloc.invoiceId);
    priorByInvoice.set(invoiceId, round2((priorByInvoice.get(invoiceId) || 0) + (Number(alloc.allocatedAmount) || 0)));
  }

  for (const [invoiceId, allocated] of perInvoice) {
    const invoice = invoiceById.get(invoiceId);
    if (!invoice) {
      return `Allocation refers to a ${partyType === "Customer" ? "Sale" : "Purchase"} invoice that does not exist in this company`;
    }
    const available = round2((Number(invoice.pendingAmount) || 0) + (priorByInvoice.get(invoiceId) || 0));
    if (allocated > available + MONEY_EPSILON) {
      return `Allocated amount (${allocated.toFixed(2)}) exceeds the pending amount (${available.toFixed(2)}) on invoice ${invoice.invoiceNo || invoiceId}`;
    }
  }

  return null;
}

// Applies one payment's bank-balance + invoice-allocation effects. Shared by
// createPayment (forward) and updatePayment/deletePayment's reversal path
// (called with a negated `amount`/allocatedAmount so the exact same code
// path both applies and reverses).
async function applyPaymentEffects({ companyId, partyType, paymentType, paymentMode, bankAccountId, amount, allocations }) {
  if (usesBankAccount(paymentMode) && bankAccountId) {
    if (paymentType === "Pay") {
      await BankAccount.findByIdAndUpdate(bankAccountId, { $inc: { currentBalance: -amount } });
    } else if (paymentType === "Receive") {
      await BankAccount.findByIdAndUpdate(bankAccountId, { $inc: { currentBalance: amount } });
    }
  }

  if (Array.isArray(allocations) && allocations.length > 0) {
    for (const alloc of allocations) {
      if (partyType === "Customer") {
        await Sale.findOneAndUpdate(
          { _id: alloc.invoiceId, companyId },
          { $inc: { receivedAmount: alloc.allocatedAmount, pendingAmount: -alloc.allocatedAmount } }
        );
      } else if (partyType === "Supplier") {
        await Purchase.findOneAndUpdate(
          { _id: alloc.invoiceId, companyId },
          { $inc: { paidAmount: alloc.allocatedAmount, pendingAmount: -alloc.allocatedAmount } }
        );
      }
    }
  }
}

// Payments carrying these partyTypes are not entered from the /payments page at
// all — expenseController and bankTransferController mint them as a shadow
// ledger row alongside their own record, and each of those modules reverses the
// bank effect itself on delete. Editing or deleting such a row from here would
// apply a SECOND, independent reversal: delete an Expense's shadow payment
// (bank += amount) and then the Expense itself (bank += amount again) and the
// account is credited twice for one expense. They have to be managed from the
// module that owns them.
const DERIVED_PARTY_TYPES = {
  Expense: "Expense",
  BankAccount: "Bank Transfer",
};

// Reverses exactly what applyPaymentEffects applied for a given payment
// document, by negating amount/allocatedAmount and calling the same function.
async function reversePaymentEffects(payment) {
  await applyPaymentEffects({
    companyId: payment.companyId,
    partyType: payment.partyType,
    paymentType: payment.paymentType,
    paymentMode: payment.paymentMode,
    bankAccountId: payment.bankAccountId,
    amount: -payment.amount,
    allocations: (payment.allocations || []).map((a) => ({
      invoiceId: a.invoiceId,
      invoiceType: a.invoiceType,
      allocatedAmount: -a.allocatedAmount,
    })),
  });
}

exports.createPayment = async (req, res) => {
  try {
    const companyId = req.effectiveCompanyId;
    const {
      paymentDate,
      paymentType,
      partyType,
      partyId,
      paymentMode,
      bankAccountId,
      amount,
      referenceNo,
      notes,
      allocations,
      narrationIds
    } = req.body;

    const parsedAmount = parseFloat(amount);
    if (!(parsedAmount > 0)) {
      return res.status(400).json({ message: "Amount must be greater than 0" });
    }

    if (usesBankAccount(paymentMode)) {
      if (!bankAccountId) {
        return res.status(400).json({ message: "Bank Account is required for this payment mode" });
      }
      const bank = await BankAccount.findOne({ _id: bankAccountId, companyId });
      if (!bank) return res.status(404).json({ message: "Bank account not found" });
      if (paymentType === "Pay" && (bank.currentBalance || 0) < parsedAmount) {
        return res.status(400).json({ message: "Insufficient funds in Bank Account" });
      }
    }

    const partyError = await assertPartyBelongsToCompany(partyType, partyId, companyId);
    if (partyError) {
      return res.status(400).json({ message: partyError });
    }

    // Before the Payment document exists and before any balance moves — a
    // refused request must leave nothing behind, same ordering the bank
    // ownership check above already establishes.
    const allocationError = await validateAllocations({ companyId, partyType, amount: parsedAmount, allocations });
    if (allocationError) {
      return res.status(400).json({ message: allocationError });
    }

    const narrations = await resolveNarrations(narrationIds, companyId);

    const payment = await Payment.create({
      companyId,
      paymentDate,
      paymentType,
      partyType,
      partyId,
      paymentMode,
      bankAccountId: usesBankAccount(paymentMode) ? bankAccountId : null,
      amount: parsedAmount,
      referenceNo,
      notes,
      allocations,
      narrations,
    });

    try {
      await applyPaymentEffects({ companyId, partyType, paymentType, paymentMode, bankAccountId, amount: parsedAmount, allocations });
    } catch (effectErr) {
      // The Payment document already committed but applying its bank/allocation
      // effects failed partway through — delete it rather than leave a Payment on
      // the books with no matching (or a half-applied) real-world effect.
      await reversePaymentEffects(payment).catch(() => {});
      await Payment.deleteOne({ _id: payment._id });
      throw effectErr;
    }

    res.status(201).json({ message: "Payment created successfully", payment });
  } catch (error) {
    console.error("Error creating payment:", error);
    res.status(500).json({ message: "Error creating payment", error: error.message });
  }
};

exports.getPayments = async (req, res) => {
  try {
    const companyId = req.effectiveCompanyId;
    const { type } = req.query; // 'Receive' or 'Pay'

    const filter = { companyId };
    if (type) {
      filter.paymentType = type;
    }

    const payments = await Payment.find(filter)
      .populate("partyId", "name companyName")
      .populate("bankAccountId", "bankName")
      .sort({ paymentDate: -1, createdAt: -1 });
    
    res.status(200).json({ payments });
  } catch (error) {
    console.error("Error fetching payments:", error);
    res.status(500).json({ message: "Error fetching payments", error: error.message });
  }
};

// GET /api/payments/export?type=Receive|Pay&dateFrom=&dateTo=
// Tally-style "Ledger Account" PDF of the whole payment register — honours
// getPayments' own `type` filter, plus an optional date range (the renderer
// prints a date range in its header, and a register without one is unbounded).
// Unpaginated by design: a statement needs the full filtered set.
exports.exportPaymentStatement = async (req, res) => {
  try {
    const companyId = req.effectiveCompanyId;
    const { type, dateFrom, dateTo } = req.query;

    const filter = { companyId };
    if (type) filter.paymentType = type;
    if (dateFrom || dateTo) {
      filter.paymentDate = {};
      if (dateFrom) filter.paymentDate.$gte = new Date(dateFrom);
      if (dateTo) filter.paymentDate.$lte = new Date(dateTo);
    }

    // Ascending, unlike getPayments' newest-first list ordering — a ledger
    // statement reads oldest-to-newest.
    const payments = await Payment.find(filter)
      .populate("partyId", "name companyName bankName accountNumber title category")
      .sort({ paymentDate: 1, createdAt: 1 });

    // Dr/Cr DIRECTION — a "Receive" is money IN and goes in DEBIT; a "Pay" is
    // money OUT and goes in CREDIT. This is the register's own cash-movement
    // view (what came in vs. what went out), not a party-side view, so it is
    // deliberately the opposite assignment from the Bank Account statement
    // above, which mirrors that page's existing Money In = Credit column.
    const entries = payments.map((p) => {
      const isIn = p.paymentType === "Receive";
      const party = p.partyId || {};
      let particulars;
      if (p.partyType === "BankAccount") particulars = `${party.bankName || "Bank"} (Bank Transfer)`;
      else if (p.partyType === "Expense") particulars = `${party.title || "Expense"} (Expense)`;
      else particulars = party.name || party.companyName || p.paymentMode || "-";

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
        opposingDrCr: isIn ? "Dr" : "Cr",
        debit: isIn ? p.amount : 0,
        credit: isIn ? 0 : p.amount,
      };
    });

    const Company = require("../models/Company");
    const company = await Company.findById(companyId).lean();

    await sendLedgerPdf(res, {
      company,
      // No single counter-party exists across a whole payment register.
      party: { name: "Payment Register" },
      dateFrom,
      dateTo,
      ledger: { openingBalance: 0, entries },
      filename: "Payments_Statement.pdf",
      isDebtor: false,
    });
  } catch (error) {
    console.error("Error exporting payment statement:", error);
    if (!res.headersSent) {
      res.status(500).json({ message: "Error exporting payment statement", error: error.message });
    }
  }
};

exports.getPaymentById = async (req, res) => {
  try {
    const companyId = req.effectiveCompanyId;
    const payment = await Payment.findOne({ _id: req.params.id, companyId });
    if (!payment) return res.status(404).json({ message: "Payment not found" });
    res.status(200).json({ payment });
  } catch (error) {
    res.status(500).json({ message: "Error fetching payment", error: error.message });
  }
};

exports.updatePayment = async (req, res) => {
  try {
    const companyId = req.effectiveCompanyId;
    const existing = await Payment.findOne({ _id: req.params.id, companyId });
    if (!existing) return res.status(404).json({ message: "Payment not found" });
    if (DERIVED_PARTY_TYPES[existing.partyType]) {
      return res.status(400).json({
        message: `This entry was created by the ${DERIVED_PARTY_TYPES[existing.partyType]} module — edit it there instead.`,
      });
    }

    const {
      paymentDate,
      paymentType,
      partyType,
      partyId,
      paymentMode,
      bankAccountId,
      amount,
      referenceNo,
      notes,
      allocations,
      narrationIds
    } = req.body;

    const parsedAmount = parseFloat(amount);
    if (!(parsedAmount > 0)) {
      return res.status(400).json({ message: "Amount must be greater than 0" });
    }

    // The bankAccountId comes straight off the request body and is handed to
    // applyPaymentEffects, whose BankAccount.findByIdAndUpdate is scoped by _id
    // ALONE — so without this check a caller who owns this payment could point
    // it at ANOTHER company's bank account and move that company's balance.
    // createPayment already does exactly this check; update was missing it.
    if (usesBankAccount(paymentMode)) {
      if (!bankAccountId) {
        return res.status(400).json({ message: "Bank Account is required for this payment mode" });
      }
      const bank = await BankAccount.findOne({ _id: bankAccountId, companyId });
      if (!bank) return res.status(404).json({ message: "Bank account not found" });
    }

    const partyError = await assertPartyBelongsToCompany(partyType, partyId, companyId);
    if (partyError) {
      return res.status(400).json({ message: partyError });
    }

    // Judged against each invoice's pending balance WITH this payment's own old
    // allocation added back (see validateAllocations) — and, like the bank check
    // above, before the reversal below has touched anything, so a refused edit
    // leaves the original payment and its effects exactly as they were.
    const allocationError = await validateAllocations({
      companyId,
      partyType,
      amount: parsedAmount,
      allocations,
      existingPayment: existing,
    });
    if (allocationError) {
      return res.status(400).json({ message: allocationError });
    }

    // Reverse the OLD payment's bank-balance + invoice-allocation effects first —
    // without this, editing a payment's amount (or which invoice it's allocated
    // to) left the Sale/Purchase's receivedAmount/paidAmount and the bank balance
    // permanently out of sync with what the payment record actually says.
    await reversePaymentEffects(existing);

    // createPayment refuses a "Pay" that the bank can't cover BEFORE anything
    // is created; this update path had no equivalent — increasing a "Pay"
    // payment's amount (or switching Cash/UPI/Cheque to Bank) could silently
    // drive currentBalance negative with no check at all. Judged post-reversal
    // (the bank the OLD amount was just credited back to, which may be the
    // same account the NEW amount is about to debit), mirroring
    // expenseController.updateExpense's identical fix for the same bug class.
    if (usesBankAccount(paymentMode) && paymentType === "Pay") {
      const freshBank = await BankAccount.findById(bankAccountId);
      if ((freshBank?.currentBalance || 0) < parsedAmount) {
        // Undo the reversal above — re-apply the OLD payment's effects so a
        // refused edit leaves everything exactly as it was before this request.
        await applyPaymentEffects({
          companyId: existing.companyId,
          partyType: existing.partyType,
          paymentType: existing.paymentType,
          paymentMode: existing.paymentMode,
          bankAccountId: existing.bankAccountId,
          amount: existing.amount,
          allocations: existing.allocations,
        }).catch(() => {});
        return res.status(400).json({ message: "Insufficient funds in Bank Account" });
      }
    }

    try {
      await applyPaymentEffects({ companyId, partyType, paymentType, paymentMode, bankAccountId, amount: parsedAmount, allocations });
    } catch (effectErr) {
      // Roll the reversal back before propagating, same reverse-then-reapply-with-
      // rollback-on-failure discipline used across the transactional controllers.
      await applyPaymentEffects({
        companyId: existing.companyId,
        partyType: existing.partyType,
        paymentType: existing.paymentType,
        paymentMode: existing.paymentMode,
        bankAccountId: existing.bankAccountId,
        amount: existing.amount,
        allocations: existing.allocations,
      }).catch(() => {});
      throw effectErr;
    }

    const narrations = narrationIds !== undefined ? await resolveNarrations(narrationIds, companyId) : existing.narrations;

    const payment = await Payment.findByIdAndUpdate(
      existing._id,
      {
        paymentDate,
        paymentType,
        partyType,
        partyId,
        paymentMode,
        bankAccountId: usesBankAccount(paymentMode) ? bankAccountId : null,
        amount: parsedAmount,
        referenceNo,
        notes,
        allocations,
        narrations,
      },
      { new: true }
    );

    res.status(200).json({ message: "Payment updated successfully", payment });
  } catch (error) {
    res.status(500).json({ message: "Error updating payment", error: error.message });
  }
};

exports.deletePayment = async (req, res) => {
  try {
    const companyId = req.effectiveCompanyId;
    const payment = await Payment.findOne({ _id: req.params.id, companyId });
    if (!payment) return res.status(404).json({ message: "Payment not found" });
    if (DERIVED_PARTY_TYPES[payment.partyType]) {
      return res.status(400).json({
        message: `This entry was created by the ${DERIVED_PARTY_TYPES[payment.partyType]} module — delete it there instead.`,
      });
    }

    // Reverse the bank-balance + invoice-allocation effects before the payment
    // itself stops existing — otherwise the money/allocated-amount effect is
    // permanently stranded with no record left to explain it.
    await reversePaymentEffects(payment);
    await Payment.deleteOne({ _id: payment._id });

    res.status(200).json({ message: "Payment deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting payment", error: error.message });
  }
};

exports.getPendingInvoices = async (req, res) => {
  try {
    const companyId = req.effectiveCompanyId;
    const { partyType, partyId } = req.params;

    let invoices = [];
    if (partyType === "Customer") {
      const sales = await Sale.find({ customerId: partyId, pendingAmount: { $gt: 0 }, companyId })
        .sort({ invoiceDate: 1 })
        .lean();
      
      invoices = sales.map(s => ({
        _id: s._id,
        invoiceNo: s.invoiceNo,
        date: s.invoiceDate,
        totalAmount: s.netAmount,
        paidAmount: s.receivedAmount,
        pendingAmount: s.pendingAmount,
        type: "Sale"
      }));
    } else if (partyType === "Supplier") {
      const items = await Item.find({ supplierId: partyId, companyId }, '_id').lean();
      const itemIds = items.map(i => i._id);
      
      const purchases = await Purchase.find({ 'items.itemId': { $in: itemIds }, pendingAmount: { $gt: 0 }, companyId })
        .sort({ invoiceDate: 1 })
        .lean();
        
      invoices = purchases.map(p => ({
        _id: p._id,
        invoiceNo: p.invoiceNo,
        date: p.invoiceDate,
        totalAmount: p.netAmount,
        paidAmount: p.paidAmount,
        pendingAmount: p.pendingAmount,
        type: "Purchase"
      }));
    } else {
      return res.status(400).json({ message: "Invalid partyType" });
    }

    res.status(200).json({ invoices });
  } catch (error) {
    console.error("Error fetching pending invoices:", error);
    res.status(500).json({ message: "Error fetching pending invoices", error: error.message });
  }
};
