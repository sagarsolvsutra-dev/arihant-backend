const mongoose = require("mongoose");

const SalesmanSchema = new mongoose.Schema(
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
    phone: {
      type: String,
      default: "",
    },
    email: {
      type: String,
      default: "",
      lowercase: true,
      trim: true,
    },
    address: {
      type: String,
      default: "",
    },
    commissionRate: {
      type: Number,
      default: 0,
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

SalesmanSchema.index({ companyId: 1, name: 1 }, { unique: true });

SalesmanSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("Salesman", SalesmanSchema);
