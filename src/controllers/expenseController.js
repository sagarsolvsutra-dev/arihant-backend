const Expense = require("../models/Expense");
const BankAccount = require("../models/BankAccount");
const Payment = require("../models/Payment");
const { searchRegex, clampLimit, clampPage } = require("../utils/queryHelpers");
const { usesBankAccount } = require("../utils/paymentModes");

const getExpenses = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, search = "", dateFrom, dateTo } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const query = { companyId };
    if (search) query.title = searchRegex(search);
    if (dateFrom || dateTo) {
      query.expenseDate = {};
      if (dateFrom) query.expenseDate.$gte = new Date(dateFrom);
      if (dateTo) query.expenseDate.$lte = new Date(dateTo);
    }

    const parsedPage = clampPage(page);
    const parsedLimit = clampLimit(limit);
    const skip = (parsedPage - 1) * parsedLimit;

    const [expenses, total] = await Promise.all([
      Expense.find(query)
        .populate("bankAccountId", "bankName accountNumber")
        .sort({ expenseDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit)
        .lean(),
      Expense.countDocuments(query),
    ]);

    res.status(200).json({
      data: expenses,
      pagination: {
        total,
        page: parsedPage,
        limit: parsedLimit,
        totalPages: Math.ceil(total / parsedLimit),
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const getExpenseById = async (req, res) => {
  try {
    const expense = await Expense.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!expense) {
      return res.status(404).json({ message: "Expense not found" });
    }
    res.status(200).json(expense);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const createExpense = async (req, res) => {
  try {
    const { companyId, expenseDate, title, category, amount, paymentMode, bankAccountId, referenceNo, notes } = req.body;

    if (!companyId || !expenseDate || !title || !category || !amount || !paymentMode) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const expenseAmount = Number(amount);
    if (expenseAmount <= 0) {
      return res.status(400).json({ message: "Amount must be greater than 0" });
    }

    if (usesBankAccount(paymentMode)) {
      if (!bankAccountId) {
         return res.status(400).json({ message: "Bank Account is required for this payment mode" });
      }
      const bank = await BankAccount.findById(bankAccountId);
      if (!bank || String(bank.companyId) !== companyId) {
        return res.status(404).json({ message: "Bank account not found" });
      }
      if ((bank.currentBalance || 0) < expenseAmount) {
        return res.status(400).json({ message: "Insufficient balance in selected Bank Account" });
      }
      
      // Deduct from bank
      bank.currentBalance -= expenseAmount;
      await bank.save();
    }

    const expense = await Expense.create({
      companyId,
      expenseDate,
      title,
      category,
      amount: expenseAmount,
      paymentMode,
      bankAccountId: usesBankAccount(paymentMode) ? bankAccountId : null,
      referenceNo: referenceNo || "",
      notes: notes || "",
    });

    // Create a Payment record for the expense to show up in ledgers
    await Payment.create({
      companyId,
      paymentDate: expenseDate,
      paymentType: "Pay",
      partyType: "Expense",
      partyId: expense._id, // Using expense ID as party ID for now
      paymentMode: paymentMode,
      bankAccountId: usesBankAccount(paymentMode) ? bankAccountId : null,
      amount: expenseAmount,
      referenceNo: referenceNo || "",
      notes: `Expense: ${title} (${category})`,
      allocations: []
    });

    res.status(201).json(expense);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const deleteExpense = async (req, res) => {
  try {
    const expense = await Expense.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!expense) {
      return res.status(404).json({ message: "Expense not found" });
    }

    // The `bankAccountId` guard is what keeps the historical UPI expenses safe:
    // those were recorded before UPI debited anything, so they carry a null
    // bankAccountId and must NOT be credited back on delete — crediting them
    // would invent money that was never deducted.
    if (usesBankAccount(expense.paymentMode) && expense.bankAccountId) {
      await BankAccount.findByIdAndUpdate(expense.bankAccountId, {
        $inc: { currentBalance: expense.amount }
      });
    }

    // Delete the linked payment
    await Payment.findOneAndDelete({
      companyId: expense.companyId,
      partyType: "Expense",
      partyId: expense._id
    });

    await expense.deleteOne();

    res.status(200).json({ message: "Expense deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getExpenses,
  getExpenseById,
  createExpense,
  deleteExpense
};
