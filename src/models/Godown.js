const mongoose = require("mongoose");

const GodownSchema = new mongoose.Schema(
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
    godownGroupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "GodownGroup",
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Godown Name + Group together identify a unique godown — the same name can
// legitimately repeat across different Groups (e.g. "godown" under both
// "gandhidham" and "samkhiyali" as distinct physical warehouses). godownGroupId
// is nullable (Group is optional), and Mongo's compound unique index still
// correctly rejects two godowns sharing {companyId, name, godownGroupId: null}.
GodownSchema.index({ companyId: 1, name: 1, godownGroupId: 1 }, { unique: true });

GodownSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("Godown", GodownSchema);
