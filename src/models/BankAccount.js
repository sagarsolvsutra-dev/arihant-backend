const mongoose = require("mongoose");

const BankAccountSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    bankName: { type: String, required: true, trim: true },
    accountNumber: { type: String, default: "", trim: true },
    branch: { type: String, default: "", trim: true },
    ifscCode: { type: String, default: "", trim: true },
    openingBalance: { type: Number, default: 0 },
    currentBalance: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["Active", "Inactive"],
      default: "Active",
    },
  },
  { timestamps: true }
);

BankAccountSchema.index({ companyId: 1, bankName: 1 }, { unique: true });

module.exports = mongoose.model("BankAccount", BankAccountSchema);
