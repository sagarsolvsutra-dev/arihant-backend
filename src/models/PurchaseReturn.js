const mongoose = require("mongoose");

// Identical shape to Purchase's line-item schema — a Purchase Return is entered the
// same way a Purchase is (ex-GST beforeGstRate), just moving stock the opposite direction.
const PurchaseReturnItemSchema = new mongoose.Schema(
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
    // Which stock bucket this line is being returned from — Fresh (resellable) or
    // Damaged. Determines which bucket applyStockDelta decrements. See
    // purchaseReturnController.assertSufficientStock/applyStockDelta.
    condition: { type: String, enum: ["Fresh", "Damaged"], default: "Fresh" },
  },
  { _id: false }
);

const PurchaseReturnSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    returnNo: { type: String, required: true, trim: true },
    returnDate: { type: Date, required: true },
    godownId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Godown",
      required: true,
    },
    // Unlike Purchase (where Supplier is a UI-only filter, never persisted), a Return
    // is fundamentally supplier-linked — stored here for real.
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      required: true,
    },
    // What the user typed/picked to look up the original invoice, plus the resolved
    // link if one was found — kept even if the original Purchase is later deleted.
    originalInvoiceNo: { type: String, default: "", trim: true },
    originalPurchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Purchase",
      default: null,
    },
    notes: { type: String, default: "" },

    items: {
      type: [PurchaseReturnItemSchema],
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

    // Payment tracking: how much of netAmount the supplier has refunded/credited back,
    // what's still owed to us, and when it's expected.
    refundAmount: { type: Number, default: 0 },
    pendingAmount: { type: Number, default: 0 },
    dueDate: { type: Date, default: null },
  },
  {
    timestamps: true,
  }
);

PurchaseReturnSchema.index({ companyId: 1, returnNo: 1 }, { unique: true });
PurchaseReturnSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("PurchaseReturn", PurchaseReturnSchema);
