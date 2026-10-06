const mongoose = require("mongoose");

const ExpenseSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    expenseDate: { type: Date, required: true },
    title: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0.01 },
    paymentMode: {
      type: String,
      enum: ["Cash", "Bank", "UPI", "Cheque"],
      required: true,
    },
    bankAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BankAccount",
      default: null,
    },
    referenceNo: { type: String, default: "", trim: true },
    notes: { type: String, default: "", trim: true },
  },
  {
    timestamps: true,
  }
);

ExpenseSchema.index({ companyId: 1, expenseDate: -1 });

module.exports = mongoose.model("Expense", ExpenseSchema);
