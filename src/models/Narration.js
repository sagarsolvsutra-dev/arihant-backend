const mongoose = require("mongoose");

// A small reusable reference-tag master — e.g. {type: "UTR", code: "ABC123"}
// or {type: "Cheque No.", code: "000456"}. Deliberately NOT a fixed-enum
// `type` (unlike AccountGroup.superGroup) — the whole point is letting a
// company add whatever reference kinds it actually uses (UTR, Cheque No.,
// Account, DD No., ...) without a code change. Picked on Expense/Payments/
// Bank Transfer (see each one's `narrations[]` snapshot field) to attach one
// or more of these tags to a single entry.
const NarrationSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    type: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
  }
);

NarrationSchema.index({ companyId: 1, type: 1, code: 1 }, { unique: true });
NarrationSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("Narration", NarrationSchema);
