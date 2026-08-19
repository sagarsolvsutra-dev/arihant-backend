const mongoose = require("mongoose");

const HsnSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    hsnCode: {
      type: String,
      required: true,
      index: true,
    },
    description: {
      type: String,
      required: true,
    },
    uqcUnit: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index to ensure uniqueness of HSN code within a company
HsnSchema.index({ companyId: 1, hsnCode: 1 }, { unique: true });

module.exports = mongoose.model("Hsn", HsnSchema);
