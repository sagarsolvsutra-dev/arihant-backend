const mongoose = require("mongoose");

const SaleItemSchema = new mongoose.Schema(
  {
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Item",
      required: true,
    },
    itemName: { type: String, required: true, trim: true },
    packing: { type: Number, default: 1 },
    salesQty: { type: Number, default: 1 },
    mrp: { type: Number, default: 0 },
    // Per-line, not per-invoice — a single Sale can move different items out of
    // different godowns. Was header-level until an explicit request to split it.
    godownId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Godown",
      required: true,
    },
    caseQty: { type: Number, default: 0 },
    pcsQty: { type: Number, default: 0 },
    freeQty: { type: Number, default: 0 },
    totalPieces: { type: Number, default: 0 },
    // Entered GST-inclusive rate (what the customer is billed per salesQty unit).
    afterGstRate: { type: Number, default: 0 },
    lessPercent: { type: Number, default: 0 },
    lessRs: { type: Number, default: 0 },
    cdPercent: { type: Number, default: 0 },
    cdRs: { type: Number, default: 0 },
    // Derived taxable (ex-GST) rate on the same salesQty basis, after discounts.
    beforeGstRate: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    taxableValue: { type: Number, default: 0 },
    gstPercent: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 },
    netValue: { type: Number, default: 0 },
  },
  { _id: false }
);

const SaleSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    invoiceType: {
      type: String,
      enum: ["Tax Invoice", "Performa Invoice"],
      default: "Tax Invoice",
    },
    paymentType: {
      type: String,
      enum: ["Cash", "Credit", "Bank", "UPI"],
      default: "Credit",
    },
    invoiceNo: { type: String, required: true, trim: true },
    invoiceDate: { type: Date, required: true },
    deliveryDate: { type: Date, default: null },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },
    notes: { type: String, default: "" },

    items: {
      type: [SaleItemSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "At least one item is required",
      },
    },

    totalItems: { type: Number, default: 0 },
    totalCase: { type: Number, default: 0 },
    totalQty: { type: Number, default: 0 },
    totalPcs: { type: Number, default: 0 },
    totalTaxableValue: { type: Number, default: 0 },
    totalGstAmount: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
    netAmount: { type: Number, default: 0 },

    // Payment tracking: how much of netAmount has been received, what's still owed.
    receivedAmount: { type: Number, default: 0 },
    pendingAmount: { type: Number, default: 0 },
    dueDate: { type: Date, default: null },
  },
  {
    timestamps: true,
  }
);

SaleSchema.index({ companyId: 1, invoiceNo: 1 }, { unique: true });
SaleSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("Sale", SaleSchema);
