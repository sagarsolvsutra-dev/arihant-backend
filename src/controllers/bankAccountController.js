const BankAccount = require("../models/BankAccount");
const Payment = require("../models/Payment");

exports.createBankAccount = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { bankName, accountNumber, branch, ifscCode, openingBalance, status } = req.body;

    const existingAccount = await BankAccount.findOne({ companyId, bankName });
    if (existingAccount) {
      return res.status(400).json({ message: "Bank Account with this name already exists for this company" });
    }

    const bankAccount = new BankAccount({
      companyId,
      bankName,
      accountNumber,
      branch,
      ifscCode,
      openingBalance: Number(openingBalance) || 0,
      currentBalance: Number(openingBalance) || 0,
      status: status || "Active"
    });

    await bankAccount.save();
    res.status(201).json({ message: "Bank Account created successfully", bankAccount });
  } catch (error) {
    console.error("Error creating bank account:", error);
    res.status(500).json({ message: "Error creating bank account", error: error.message });
  }
};

exports.getBankAccounts = async (req, res) => {
  try {
    const { companyId } = req.user;
    const bankAccounts = await BankAccount.find({ companyId }).sort({ createdAt: -1 });
    res.status(200).json({ bankAccounts });
  } catch (error) {
    console.error("Error fetching bank accounts:", error);
    res.status(500).json({ message: "Error fetching bank accounts", error: error.message });
  }
};

exports.updateBankAccount = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { id } = req.params;
    const { bankName, accountNumber, branch, ifscCode, openingBalance, status } = req.body;

    const bankAccount = await BankAccount.findOne({ _id: id, companyId });
    if (!bankAccount) {
      return res.status(404).json({ message: "Bank Account not found" });
    }

    // Checking name conflict if name changed
    if (bankName !== bankAccount.bankName) {
      const existingAccount = await BankAccount.findOne({ companyId, bankName });
      if (existingAccount) {
        return res.status(400).json({ message: "Another Bank Account with this name already exists" });
      }
    }

    // Update current balance logic if opening balance changed (simplified)
    const diff = (Number(openingBalance) || 0) - bankAccount.openingBalance;
    bankAccount.currentBalance += diff;

    bankAccount.bankName = bankName;
    bankAccount.accountNumber = accountNumber;
    bankAccount.branch = branch;
    bankAccount.ifscCode = ifscCode;
    bankAccount.openingBalance = Number(openingBalance) || 0;
    bankAccount.status = status || bankAccount.status;

    await bankAccount.save();
    res.status(200).json({ message: "Bank Account updated successfully", bankAccount });
  } catch (error) {
    console.error("Error updating bank account:", error);
    res.status(500).json({ message: "Error updating bank account", error: error.message });
  }
};

exports.deleteBankAccount = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { id } = req.params;
    
    const bankAccount = await BankAccount.findOneAndDelete({ _id: id, companyId });
    if (!bankAccount) {
      return res.status(404).json({ message: "Bank Account not found" });
    }
    
    res.status(200).json({ message: "Bank Account deleted successfully" });
  } catch (error) {
    console.error("Error deleting bank account:", error);
    res.status(500).json({ message: "Error deleting bank account", error: error.message });
  }
};

exports.getBankAccountStatement = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { id } = req.params;

    const bankAccount = await BankAccount.findOne({ _id: id, companyId });
    if (!bankAccount) {
      return res.status(404).json({ message: "Bank Account not found" });
    }

    const payments = await Payment.find({ bankAccountId: id, companyId })
      .populate("partyId", "name companyName bankName accountNumber title category")
      .sort({ paymentDate: 1, createdAt: 1 });

    res.status(200).json({ bankAccount, payments });
  } catch (error) {
    console.error("Error fetching bank statement:", error);
    res.status(500).json({ message: "Error fetching bank statement", error: error.message });
  }
};

exports.transferFunds = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { fromBankId, toBankId, amount, date, notes } = req.body;

    if (!fromBankId || !toBankId || !amount || !date) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    if (fromBankId === toBankId) {
      return res.status(400).json({ message: "Cannot transfer to the same bank account" });
    }

    const transferAmount = Number(amount);
    if (transferAmount <= 0) {
      return res.status(400).json({ message: "Transfer amount must be greater than 0" });
    }

    const fromBank = await BankAccount.findOne({ _id: fromBankId, companyId });
    const toBank = await BankAccount.findOne({ _id: toBankId, companyId });

    if (!fromBank || !toBank) {
      return res.status(404).json({ message: "One or both bank accounts not found" });
    }

    if (fromBank.currentBalance < transferAmount) {
      return res.status(400).json({ message: "Insufficient balance in the source bank account" });
    }

    // Deduct from source bank
    fromBank.currentBalance -= transferAmount;
    await fromBank.save();

    // Add to destination bank
    toBank.currentBalance += transferAmount;
    await toBank.save();

    // Create Payment for Source (Money Out)
    await Payment.create({
      companyId,
      paymentDate: date,
      paymentType: "Pay",
      partyType: "BankAccount",
      partyId: toBank._id, // The party is the destination bank
      paymentMode: "Bank",
      bankAccountId: fromBank._id,
      amount: transferAmount,
      notes: notes || `Transfer to ${toBank.bankName}`,
    });

    // Create Payment for Destination (Money In)
    await Payment.create({
      companyId,
      paymentDate: date,
      paymentType: "Receive",
      partyType: "BankAccount",
      partyId: fromBank._id, // The party is the source bank
      paymentMode: "Bank",
      bankAccountId: toBank._id,
      amount: transferAmount,
      notes: notes || `Transfer from ${fromBank.bankName}`,
    });

    res.status(200).json({ message: "Funds transferred successfully" });
  } catch (error) {
    console.error("Error transferring funds:", error);
    res.status(500).json({ message: "Error transferring funds", error: error.message });
  }
};
