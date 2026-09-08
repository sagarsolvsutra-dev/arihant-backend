const mongoose = require("mongoose");

const PurchaseItemSchema = new mongoose.Schema(
  {
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Item",
      required: true,
    },
    itemName: { type: String, required: true, trim: true },
    packing: { type: Number, default: 1 },
    purchaseQty: { type: Number, default: 1 },
    mrp: { type: Number, default: 0 },
    // Per-line, not per-invoice — a single Purchase can send different items to
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
    beforeGstRate: { type: Number, default: 0 },
    lessPercent: { type: Number, default: 0 },
    lessRs: { type: Number, default: 0 },
    cdPercent: { type: Number, default: 0 },
    cdRs: { type: Number, default: 0 },
    afterGstRate: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    taxableValue: { type: Number, default: 0 },
    gstPercent: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 },
    netValue: { type: Number, default: 0 },
  },
  { _id: false }
);

const PurchaseSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    invoiceNo: { type: String, required: true, trim: true },
    invoiceDate: { type: Date, required: true },
    receivingDate: { type: Date, default: null },
    ewayBillNo: { type: String, default: "", trim: true },
    notes: { type: String, default: "" },

    items: {
      type: [PurchaseItemSchema],
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

    // Payment tracking: how much of netAmount has been paid, what's still owed, and when it's due.
    paidAmount: { type: Number, default: 0 },
    pendingAmount: { type: Number, default: 0 },
    dueDate: { type: Date, default: null },
  },
  {
    timestamps: true,
  }
);

PurchaseSchema.index({ companyId: 1, invoiceNo: 1 }, { unique: true });
PurchaseSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("Purchase", PurchaseSchema);
