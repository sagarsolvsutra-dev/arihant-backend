const mongoose = require("mongoose");

// Snapshotted (type+code copied at the moment it's attached), not a live
// reference — the whole point of a Narration tag is a stable record of what
// was keyed in at the time ("UTR: ABC123"), which must survive the source
// Narration master row later being edited or deleted. See Narration.js and
// narrationController.deleteNarration for the other half of this choice.
const NarrationRefSchema = new mongoose.Schema(
  {
    narrationId: { type: mongoose.Schema.Types.ObjectId, ref: "Narration", default: null },
    type: { type: String, required: true },
    code: { type: String, required: true },
  },
  { _id: false }
);

const ExpenseSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    expenseDate: { type: Date, required: true },
    title: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0.01 },
    paymentMode: {
      type: String,
      enum: ["Cash", "Bank", "UPI", "Cheque"],
      required: true,
    },
    bankAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BankAccount",
      default: null,
    },
    // Optional ledger-account classification for this expense (e.g. tag it
    // against a specific party/head in the new Account master) — deliberately
    // additional to `category`, not a replacement (confirmed with the user).
    // Booking an expense against an Account always posts Dr — see
    // accountController.applyAccountEffect/reverseAccountEffect, used by
    // expenseController's create/delete.
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      default: null,
    },
    narrations: { type: [NarrationRefSchema], default: [] },
  },
  {
    timestamps: true,
  }
);

ExpenseSchema.index({ companyId: 1, expenseDate: -1 });

module.exports = mongoose.model("Expense", ExpenseSchema);
