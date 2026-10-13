const BankAccount = require("../models/BankAccount");
const Payment = require("../models/Payment");

exports.createBankAccount = async (req, res) => {
  try {
    const companyId = req.effectiveCompanyId;
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
    const companyId = req.effectiveCompanyId;
    const bankAccounts = await BankAccount.find({ companyId }).sort({ createdAt: -1 });
    res.status(200).json({ bankAccounts });
  } catch (error) {
    console.error("Error fetching bank accounts:", error);
    res.status(500).json({ message: "Error fetching bank accounts", error: error.message });
  }
};

exports.updateBankAccount = async (req, res) => {
  try {
    const companyId = req.effectiveCompanyId;
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

    // Only shift the balance if the caller actually sent an openingBalance —
    // an omitted field must mean "leave it unchanged," not "treat it as 0."
    // accountController.updateAccount already guards this identically; this
    // function previously didn't, so a request that left openingBalance out
    // would silently zero it out and subtract the entire original opening
    // balance from currentBalance. Not reachable through the current Add/Edit
    // modal (which always resends it), but a real latent gap for any direct
    // API call or future form change that stops always-resending this field.
    if (openingBalance !== undefined) {
      const diff = (Number(openingBalance) || 0) - bankAccount.openingBalance;
      bankAccount.currentBalance += diff;
      bankAccount.openingBalance = Number(openingBalance) || 0;
    }

    bankAccount.bankName = bankName;
    bankAccount.accountNumber = accountNumber;
    bankAccount.branch = branch;
    bankAccount.ifscCode = ifscCode;
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
    const companyId = req.effectiveCompanyId;
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
    const companyId = req.effectiveCompanyId;
    const { id } = req.params;
    const { dateFrom, dateTo } = req.query;

    const bankAccount = await BankAccount.findOne({ _id: id, companyId });
    if (!bankAccount) {
      return res.status(404).json({ message: "Bank Account not found" });
    }

    let filter = { bankAccountId: id, companyId };
    if (dateFrom || dateTo) {
      filter.paymentDate = {};
      if (dateFrom) filter.paymentDate.$gte = new Date(dateFrom);
      if (dateTo) filter.paymentDate.$lte = new Date(dateTo);
    }

    // A genuine "balance as of dateFrom" — mirrors reportController.buildLedger's
    // own before-range accumulation for the Customer/Supplier Ledger. Without
    // this, applying a dateFrom filter used to seed the running balance from
    // the account's raw, all-time openingBalance and silently ignore every
    // payment dated before the filter — the table's own running balance would
    // then end up understated relative to the always-live "Current Balance"
    // KPI shown right next to it. With no dateFrom, this is identical to the
    // raw openingBalance (nothing to fold in).
    let openingBalanceAsOf = bankAccount.openingBalance || 0;
    if (dateFrom) {
      const priorPayments = await Payment.find({
        bankAccountId: id,
        companyId,
        paymentDate: { $lt: new Date(dateFrom) },
      }).select("paymentType amount");
      for (const p of priorPayments) {
        if (p.paymentType === "Receive") openingBalanceAsOf += p.amount;
        else if (p.paymentType === "Pay") openingBalanceAsOf -= p.amount;
      }
    }

    const payments = await Payment.find(filter)
      .populate("partyId", "name companyName bankName accountNumber title category")
      .sort({ paymentDate: 1, createdAt: 1 });

    res.status(200).json({ bankAccount, payments, openingBalanceAsOf });
  } catch (error) {
    console.error("Error fetching bank statement:", error);
    res.status(500).json({ message: "Error fetching bank statement", error: error.message });
  }
};

exports.transferFunds = async (req, res) => {
  try {
    const companyId = req.effectiveCompanyId;
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
