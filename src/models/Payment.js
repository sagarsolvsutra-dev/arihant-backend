const mongoose = require("mongoose");

// Snapshotted (type+code copied, not a live reference) — see Expense.js's
// identical NarrationRefSchema comment for why.
const NarrationRefSchema = new mongoose.Schema(
  {
    narrationId: { type: mongoose.Schema.Types.ObjectId, ref: "Narration", default: null },
    type: { type: String, required: true },
    code: { type: String, required: true },
  },
  { _id: false }
);

const PaymentAllocationSchema = new mongoose.Schema(
  {
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId, // Could be Sale, Purchase, SaleReturn, PurchaseReturn
      required: true,
    },
    invoiceType: {
      type: String,
      enum: ["Sale", "Purchase", "SaleReturn", "PurchaseReturn", "OpeningBill"],
      required: true,
    },
    allocatedAmount: { type: Number, required: true },
  },
  { _id: false }
);

const PaymentSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    paymentDate: { type: Date, required: true },
    paymentType: {
      type: String,
      enum: ["Receive", "Pay"], // Receive from Customer, Pay to Supplier
      required: true,
    },
    partyType: {
      type: String,
      enum: ["Customer", "Supplier", "BankAccount", "Expense"],
      required: true,
    },
    partyId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      refPath: "partyType",
    },
    paymentMode: {
      type: String,
      enum: ["Cash", "Bank", "UPI", "Cheque"],
      required: true,
    },
    bankAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BankAccount",
      default: null,
    },
    amount: { type: Number, required: true },
    // Both read from req.body and round-tripped by paymentController's
    // create/update from the start, but neither was ever declared here —
    // Mongoose's default strict mode silently dropped them on every save, so
    // no Payment ever actually persisted a Reference No or Notes despite the
    // controller (and the Payments list page's own referenceNo search filter)
    // behaving as if it did. Found while wiring Payment rows into the
    // Customer/Supplier Ledger, which needs a real Ref No to show.
    referenceNo: { type: String, default: "" },
    notes: { type: String, default: "" },
    allocations: {
      type: [PaymentAllocationSchema],
      default: [],
    },
    narrations: { type: [NarrationRefSchema], default: [] },
  },
  { timestamps: true }
);

PaymentSchema.index({ companyId: 1, paymentDate: -1 });

module.exports = mongoose.model("Payment", PaymentSchema);
