const mongoose = require("mongoose");

const StockTransferItemSchema = new mongoose.Schema(
  {
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Item",
      required: true,
    },
    itemName: { type: String, required: true, trim: true },
    packing: { type: Number, default: 1 },
    mrp: { type: Number, default: 0 },
    caseQty: { type: Number, default: 0 },
    pcsQty: { type: Number, default: 0 },
    totalPieces: { type: Number, default: 0 },
  },
  { _id: false }
);

const StockTransferSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    transferNo: { type: String, required: true, trim: true },
    transferDate: { type: Date, required: true },
    fromGodownId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Godown",
      required: true,
    },
    toGodownId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Godown",
      required: true,
    },
    notes: { type: String, default: "" },

    items: {
      type: [StockTransferItemSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "At least one item is required",
      },
    },

    totalItems: { type: Number, default: 0 },
    totalCase: { type: Number, default: 0 },
    totalPcs: { type: Number, default: 0 },
    totalQty: { type: Number, default: 0 },
  },
  {
    timestamps: true,
  }
);

StockTransferSchema.index({ companyId: 1, transferNo: 1 }, { unique: true });
StockTransferSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("StockTransfer", StockTransferSchema);
