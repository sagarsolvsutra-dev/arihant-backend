const mongoose = require("mongoose");

// A general ledger account (Tally-style "Account Master") — deliberately
// independent of Customer/Supplier (confirmed with the user rather than
// assumed): a company may still want a ledger account for a person/party that
// has nothing to do with the Customer/Supplier masters, and auto-syncing the
// two would be a much bigger, riskier change than what was actually asked for.
//
// `openingBalance`/`currentBalance` are always a non-negative magnitude, with
// the Dr/Cr nature held in the separate `*BalanceType` field — mirrors the
// exact Op.Balance/Cl.Balance + Dr-Cr pair shown in the reference screenshot.
// `currentBalance` is the live, continuously-updated balance (same "flat
// field incremented in place" pattern as BankAccount.currentBalance) — see
// accountController.js's `applyAccountEffect`/`reverseAccountEffect` for the
// signed-net math that keeps `currentBalanceType` correct as Dr/Cr entries
// are posted against it (currently only from Expense; see Expense.accountId).
const AccountSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    name: { type: String, required: true, trim: true },
    cityVillage: { type: String, default: "", trim: true },
    panNo: { type: String, default: "", trim: true },
    accountGroupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountGroup",
      required: true,
    },
    openingBalance: { type: Number, default: 0, min: 0 },
    openingBalanceType: { type: String, enum: ["Dr", "Cr"], default: "Dr" },
    currentBalance: { type: Number, default: 0, min: 0 },
    currentBalanceType: { type: String, enum: ["Dr", "Cr"], default: "Dr" },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
  }
);

AccountSchema.index({ companyId: 1, name: 1 }, { unique: true });
AccountSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("Account", AccountSchema);
