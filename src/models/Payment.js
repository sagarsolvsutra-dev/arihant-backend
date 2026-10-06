const mongoose = require("mongoose");

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
    referenceNo: { type: String, default: "" }, // Cheque no, UTR, etc.
    notes: { type: String, default: "" },
    allocations: {
      type: [PaymentAllocationSchema],
      default: [],
    },
  },
  { timestamps: true }
);

PaymentSchema.index({ companyId: 1, paymentDate: -1 });

module.exports = mongoose.model("Payment", PaymentSchema);
