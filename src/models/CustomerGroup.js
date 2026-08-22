const mongoose = require("mongoose");

const CustomerGroupSchema = new mongoose.Schema(
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
    zoneNo: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

CustomerGroupSchema.index({ companyId: 1, name: 1 }, { unique: true });

CustomerGroupSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("CustomerGroup", CustomerGroupSchema);
