const mongoose = require("mongoose");

const OpeningBillSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    type: {
      type: String,
      enum: ["sale", "purchase"],
      required: true,
      default: "sale"
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
    },
    taxInvoice: {
      type: String,
      trim: true,
      default: "",
    },
    billNo: {
      type: String,
      required: true,
      trim: true,
    },
    billDate: {
      type: Date,
      required: true,
    },
    dueDate: {
      type: Date,
    },
    totalAmount: {
      type: Number,
      required: true,
      default: 0,
    },
    pendingAmount: {
      type: Number,
      required: true,
      default: 0,
    },
    salesmanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Salesman",
    },
    notes: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

OpeningBillSchema.index({ companyId: 1, type: 1, billNo: 1 }, { unique: true });

OpeningBillSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("OpeningBill", OpeningBillSchema);
