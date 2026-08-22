const mongoose = require("mongoose");

const ItemGroupSchema = new mongoose.Schema(
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
    shortName: {
      type: String,
    },
    commissionRate: {
      type: Number,
      default: 0.00,
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

ItemGroupSchema.index({ companyId: 1, name: 1 }, { unique: true });

ItemGroupSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("ItemGroup", ItemGroupSchema);
