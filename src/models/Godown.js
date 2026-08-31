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

GodownSchema.index({ companyId: 1, name: 1 }, { unique: true });

GodownSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("Godown", GodownSchema);
