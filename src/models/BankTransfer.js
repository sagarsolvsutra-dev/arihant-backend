const mongoose = require("mongoose");

const BankTransferSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    transferDate: { type: Date, required: true },
    fromBankId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BankAccount",
      required: true,
    },
    toBankId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BankAccount",
      required: true,
    },
    amount: { type: Number, required: true, min: 0.01 },
    referenceNo: { type: String, default: "", trim: true },
    notes: { type: String, default: "", trim: true },
  },
  {
    timestamps: true,
  }
);

BankTransferSchema.index({ companyId: 1, transferDate: -1 });

module.exports = mongoose.model("BankTransfer", BankTransferSchema);
