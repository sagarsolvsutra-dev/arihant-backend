const BankTransfer = require("../models/BankTransfer");
const BankAccount = require("../models/BankAccount");
const Payment = require("../models/Payment");
const { clampLimit, clampPage } = require("../utils/queryHelpers");

const getBankTransfers = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, dateFrom, dateTo } = req.query;
    if (!companyId) return res.status(400).json({ message: "companyId is required" });

    const query = { companyId };
    if (dateFrom || dateTo) {
      query.transferDate = {};
      if (dateFrom) query.transferDate.$gte = new Date(dateFrom);
      if (dateTo) query.transferDate.$lte = new Date(dateTo);
    }

    const parsedPage = clampPage(page);
    const parsedLimit = clampLimit(limit);
    const skip = (parsedPage - 1) * parsedLimit;

    const [transfers, total] = await Promise.all([
      BankTransfer.find(query)
        .populate("fromBankId", "bankName accountNumber")
        .populate("toBankId", "bankName accountNumber")
        .sort({ transferDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit)
        .lean(),
      BankTransfer.countDocuments(query),
    ]);

    res.status(200).json({
      data: transfers,
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

const getBankTransferById = async (req, res) => {
  try {
    const transfer = await BankTransfer.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!transfer) return res.status(404).json({ message: "Transfer not found" });
    res.status(200).json(transfer);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const createBankTransfer = async (req, res) => {
  try {
    const { companyId, fromBankId, toBankId, amount, date, notes, referenceNo } = req.body;

    if (!fromBankId || !toBankId || !amount || !date) {
      return res.status(400).json({ message: "Missing required fields" });
    }
    if (fromBankId === toBankId) {
      return res.status(400).json({ message: "Source and destination banks cannot be the same" });
    }

    const fromBank = await BankAccount.findById(fromBankId);
    const toBank = await BankAccount.findById(toBankId);

    if (!fromBank || !toBank || String(fromBank.companyId) !== companyId || String(toBank.companyId) !== companyId) {
      return res.status(404).json({ message: "Bank account not found or unauthorized" });
    }

    const transferAmount = Number(amount);
    // Must be validated BEFORE either balance is touched. The insufficient-balance
    // guard below is the only other check, and a negative (or NaN) amount sails
    // past it — `balance < -100` is false — so the two saves below would run and
    // only then would BankTransfer.create reject it against the schema's
    // `min: 0.01`, leaving both banks permanently mis-stated with no transfer
    // record behind it. Mirrors bankAccountController.transferFunds' own check.
    if (!Number.isFinite(transferAmount) || transferAmount <= 0) {
      return res.status(400).json({ message: "Transfer amount must be greater than 0" });
    }
    if ((fromBank.currentBalance || 0) < transferAmount) {
      return res.status(400).json({ message: "Insufficient balance in source bank account" });
    }

    // Deduct from source
    fromBank.currentBalance -= transferAmount;
    await fromBank.save();

    // Add to destination
    toBank.currentBalance = (toBank.currentBalance || 0) + transferAmount;
    await toBank.save();

    const transfer = await BankTransfer.create({
      companyId,
      transferDate: date,
      fromBankId,
      toBankId,
      amount: transferAmount,
      referenceNo: referenceNo || "",
      notes: notes || "",
    });

    // Create Payment for Source (Money Out)
    await Payment.create({
      companyId,
      paymentDate: date,
      paymentType: "Pay",
      partyType: "BankAccount",
      partyId: toBankId,
      paymentMode: "Bank",
      bankAccountId: fromBankId,
      amount: transferAmount,
      referenceNo: referenceNo || "",
      notes: `Bank Transfer Out: ${notes || ""}`,
      allocations: []
    });

    // Create Payment for Destination (Money In)
    await Payment.create({
      companyId,
      paymentDate: date,
      paymentType: "Receive",
      partyType: "BankAccount",
      partyId: fromBankId,
      paymentMode: "Bank",
      bankAccountId: toBankId,
      amount: transferAmount,
      referenceNo: referenceNo || "",
      notes: `Bank Transfer In: ${notes || ""}`,
      allocations: []
    });

    res.status(201).json(transfer);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const deleteBankTransfer = async (req, res) => {
  try {
    const transfer = await BankTransfer.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!transfer) return res.status(404).json({ message: "Transfer not found" });

    // Reverse balances
    await BankAccount.findByIdAndUpdate(transfer.fromBankId, { $inc: { currentBalance: transfer.amount } });
    await BankAccount.findByIdAndUpdate(transfer.toBankId, { $inc: { currentBalance: -transfer.amount } });

    // Delete Payments matching this transfer
    // Since there are two payments created simultaneously for this transfer on the same date with the same reference/amount
    // We can delete them. However, since we don't store transfer._id on the payments directly, we can match by amount/date/banks
    await Payment.deleteMany({
      companyId: transfer.companyId,
      paymentDate: transfer.transferDate,
      amount: transfer.amount,
      $or: [
        { bankAccountId: transfer.fromBankId, partyId: transfer.toBankId, paymentType: "Pay" },
        { bankAccountId: transfer.toBankId, partyId: transfer.fromBankId, paymentType: "Receive" }
      ]
    });

    await transfer.deleteOne();
    res.status(200).json({ message: "Transfer deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getBankTransfers,
  getBankTransferById,
  createBankTransfer,
  deleteBankTransfer
};
