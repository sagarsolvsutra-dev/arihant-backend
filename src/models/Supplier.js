const mongoose = require("mongoose");

const SupplierSchema = new mongoose.Schema(
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
    alias: {
      type: String,
      default: "",
    },
    phone: {
      type: String,
      default: "",
    },
    phone2: {
      type: String,
      default: "",
    },
    mobile: {
      type: String,
      default: "",
    },
    contactPerson: {
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
    city: {
      type: String,
      default: "",
    },
    state: {
      type: String,
      default: "",
    },
    pincode: {
      type: String,
      default: "",
    },
    gstNo: {
      type: String,
      default: "",
      uppercase: true,
      trim: true,
    },
    panNo: {
      type: String,
      default: "",
      uppercase: true,
      trim: true,
    },
    supplierGroupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SupplierGroup",
      default: null,
    },
    balanceMethod: {
      type: String,
      default: "Bill by bill",
    },
    creditDays: {
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

SupplierSchema.index({ companyId: 1, name: 1 }, { unique: true });

SupplierSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("Supplier", SupplierSchema);
