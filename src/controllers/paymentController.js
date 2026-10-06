const Payment = require("../models/Payment");
const Sale = require("../models/Sale");
const Purchase = require("../models/Purchase");
const Item = require("../models/Item");
const BankAccount = require("../models/BankAccount");
const { isValidObjectId } = require("../utils/queryHelpers");
const { usesBankAccount } = require("../utils/paymentModes");

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
    const { companyId } = req.user;
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
      allocations
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

    // Before the Payment document exists and before any balance moves — a
    // refused request must leave nothing behind, same ordering the bank
    // ownership check above already establishes.
    const allocationError = await validateAllocations({ companyId, partyType, amount: parsedAmount, allocations });
    if (allocationError) {
      return res.status(400).json({ message: allocationError });
    }

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
      allocations
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
    const { companyId } = req.user;
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

exports.getPaymentById = async (req, res) => {
  try {
    const { companyId } = req.user;
    const payment = await Payment.findOne({ _id: req.params.id, companyId });
    if (!payment) return res.status(404).json({ message: "Payment not found" });
    res.status(200).json({ payment });
  } catch (error) {
    res.status(500).json({ message: "Error fetching payment", error: error.message });
  }
};

exports.updatePayment = async (req, res) => {
  try {
    const { companyId } = req.user;
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
      allocations
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
        allocations
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
    const { companyId } = req.user;
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
    const { companyId } = req.user;
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
