const mongoose = require("mongoose");

const SupplierGroupSchema = new mongoose.Schema(
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
  },
  {
    timestamps: true,
  }
);

SupplierGroupSchema.index({ companyId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("SupplierGroup", SupplierGroupSchema);
