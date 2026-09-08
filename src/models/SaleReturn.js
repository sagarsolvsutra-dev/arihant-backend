const mongoose = require("mongoose");

// Identical shape to Sale's line-item schema — a Sale Return is entered the same way
// a Sale is (GST-inclusive afterGstRate), just moving stock the opposite direction.
const SaleReturnItemSchema = new mongoose.Schema(
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
    // Per-line, not per-invoice — a single return can bring different items back
    // into different godowns. Was header-level until an explicit request to split it.
    godownId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Godown",
      required: true,
    },
    caseQty: { type: Number, default: 0 },
    pcsQty: { type: Number, default: 0 },
    freeQty: { type: Number, default: 0 },
    totalPieces: { type: Number, default: 0 },
    afterGstRate: { type: Number, default: 0 },
    lessPercent: { type: Number, default: 0 },
    lessRs: { type: Number, default: 0 },
    cdPercent: { type: Number, default: 0 },
    cdRs: { type: Number, default: 0 },
    beforeGstRate: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    taxableValue: { type: Number, default: 0 },
    gstPercent: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 },
    netValue: { type: Number, default: 0 },
    // Fresh = resellable, added back into the sellable Fresh stock bucket.
    // Expired / Damaged = recorded in their own respective stock buckets instead —
    // visible on stock pages but not counted as sellable inventory. See
    // saleReturnController.applyStockDelta.
    condition: { type: String, enum: ["Fresh", "Expired", "Damaged"], default: "Fresh" },
  },
  { _id: false }
);

const SaleReturnSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    returnNo: { type: String, required: true, trim: true },
    returnDate: { type: Date, required: true },
    // Real, persisted field — same as Sale.customerId (a return is customer-linked,
    // and can be auto-filled directly from the original Sale once it's looked up).
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },
    originalInvoiceNo: { type: String, default: "", trim: true },
    originalSaleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sale",
      default: null,
    },
    notes: { type: String, default: "" },

    items: {
      type: [SaleReturnItemSchema],
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

    // Payment tracking: how much of netAmount has been refunded back to the customer,
    // what's still owed to them, and when it's expected.
    refundAmount: { type: Number, default: 0 },
    pendingAmount: { type: Number, default: 0 },
    dueDate: { type: Date, default: null },
  },
  {
    timestamps: true,
  }
);

SaleReturnSchema.index({ companyId: 1, returnNo: 1 }, { unique: true });
SaleReturnSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("SaleReturn", SaleReturnSchema);
