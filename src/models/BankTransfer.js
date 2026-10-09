const mongoose = require("mongoose");

// Snapshotted (type+code copied, not a live reference) — see Expense.js's
// identical NarrationRefSchema comment for why.
const NarrationRefSchema = new mongoose.Schema(
  {
    narrationId: { type: mongoose.Schema.Types.ObjectId, ref: "Narration", default: null },
    type: { type: String, required: true },
    code: { type: String, required: true },
  },
  { _id: false }
);

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
    narrations: { type: [NarrationRefSchema], default: [] },
  },
  {
    timestamps: true,
  }
);

BankTransferSchema.index({ companyId: 1, transferDate: -1 });

module.exports = mongoose.model("BankTransfer", BankTransferSchema);
