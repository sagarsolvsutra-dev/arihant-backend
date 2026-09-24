const mongoose = require("mongoose");

const CustomerSchema = new mongoose.Schema(
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
    mobile: {
      type: String,
      default: "",
    },
    email: {
      type: String,
      default: "",
      lowercase: true,
      trim: true,
    },
    contactPerson: {
      type: String,
      default: "",
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
    fssaiLicenseNumber: {
      type: String,
      default: "",
    },
    fssaiIssueDate: {
      type: Date,
      default: null,
    },
    fssaiExpiryDate: {
      type: Date,
      default: null,
    },
    customerGroupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CustomerGroup",
      default: null,
    },
    zoneNo: {
      type: String,
      default: "",
    },
    routeNo: {
      type: String,
      default: "",
    },
    uniqueIdNo: {
      type: String,
      default: "",
    },
    drugLicNo: {
      type: String,
      default: "",
    },
    customerType: {
      type: String,
      default: "Retailer", // Defaulting based on screenshot
    },
    balanceMethod: {
      type: String,
      default: "Bill by bill", // Defaulting based on screenshot
    },
    salesmanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Salesman",
      default: null,
    },
    creditLimit: {
      type: Number,
      default: 0,
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

CustomerSchema.index({ companyId: 1, name: 1 }, { unique: true });

CustomerSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("Customer", CustomerSchema);
