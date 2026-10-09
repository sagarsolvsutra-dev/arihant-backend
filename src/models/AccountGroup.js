const mongoose = require("mongoose");

// Mirrors Tally's Account Group concept: every Account Group rolls up into
// exactly one of these 4 fixed natures, which is what ultimately decides
// whether a balance is naturally Dr or Cr. Kept as a fixed enum (not its own
// master) since this top-level classification is standard accounting, not
// something a company would ever need to redefine.
const SUPER_GROUPS = ["Assets", "Liability", "Income", "Expense"];

const AccountGroupSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    superGroup: {
      type: String,
      enum: SUPER_GROUPS,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

AccountGroupSchema.index({ companyId: 1, name: 1 }, { unique: true });
AccountGroupSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("AccountGroup", AccountGroupSchema);
module.exports.SUPER_GROUPS = SUPER_GROUPS;
