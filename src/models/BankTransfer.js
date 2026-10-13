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
    // Read/written by bankTransferController from the start, but never
    // declared here — Mongoose's default strict mode silently dropped both on
    // every save, so a typed Reference No. (and the list page's own
    // "Reference No." column, which always showed "-") were dead the whole
    // time. Same bug class as Payment.js's identical gap, fixed earlier this
    // session — see CLAUDE.md quirk #56.
    referenceNo: { type: String, default: "" },
    notes: { type: String, default: "" },
    narrations: { type: [NarrationRefSchema], default: [] },
  },
  {
    timestamps: true,
  }
);

BankTransferSchema.index({ companyId: 1, transferDate: -1 });

module.exports = mongoose.model("BankTransfer", BankTransferSchema);
