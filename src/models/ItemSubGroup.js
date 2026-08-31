const mongoose = require("mongoose");

const ItemSubGroupSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    name: {
      type: String,
      required: true,
    },

    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
    },
    itemNameId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ItemName",
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

ItemSubGroupSchema.index({ companyId: 1, name: 1 }, { unique: true });

ItemSubGroupSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("ItemSubGroup", ItemSubGroupSchema);
