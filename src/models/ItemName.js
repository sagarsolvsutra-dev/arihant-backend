const mongoose = require("mongoose");

const ItemNameSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

ItemNameSchema.index({ companyId: 1, supplierId: 1, name: 1 }, { unique: true });

ItemNameSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("ItemName", ItemNameSchema);
