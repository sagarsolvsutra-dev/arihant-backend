const mongoose = require("mongoose");

const SchemeSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    itemGroupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ItemGroup",
      default: null,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
    },
    lessPercentage: {
      type: Number,
      default: 0,
    },
    cdPercentage: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

SchemeSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("Scheme", SchemeSchema);
