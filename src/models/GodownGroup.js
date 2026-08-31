const mongoose = require("mongoose");

const GodownGroupSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

GodownGroupSchema.index({ companyId: 1, name: 1 }, { unique: true });

GodownGroupSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("GodownGroup", GodownGroupSchema);
