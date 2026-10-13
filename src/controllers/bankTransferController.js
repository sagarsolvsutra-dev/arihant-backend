const BankTransfer = require("../models/BankTransfer");
const BankAccount = require("../models/BankAccount");
const Payment = require("../models/Payment");
const Narration = require("../models/Narration");
const { clampLimit, clampPage } = require("../utils/queryHelpers");

// Resolves client-submitted Narration ids against the company's own Narration
// master and snapshots {narrationId, type, code} — see Expense.js's
// NarrationRefSchema comment for why this is a copy, not a live reference.
// Invalid/foreign ids are silently dropped (informational tag, not worth
// blocking a save over) — identical helper to expenseController's own, kept
// duplicated per this codebase's established per-controller-helper style.
async function resolveNarrations(clientNarrations, companyId) {
  if (!Array.isArray(clientNarrations) || clientNarrations.length === 0) return [];
  const isStringArray = typeof clientNarrations[0] === 'string' || clientNarrations[0] instanceof String;
  const ids = isStringArray ? clientNarrations : clientNarrations.map(n => n.narrationId || n._id);

  const docs = await Narration.find({ _id: { $in: ids }, companyId }).lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));

  return clientNarrations
    .map((cn) => {
      const id = isStringArray ? cn : (cn.narrationId || cn._id);
      const d = byId.get(String(id));
      if (!d) return null;
      return {
        narrationId: d._id,
        type: d.type,
        code: isStringArray ? d.code : (cn.code !== undefined ? cn.code : d.code)
      };
    })
    .filter(Boolean);
}

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
    const { companyId, fromBankId, toBankId, amount, date, notes, referenceNo, narrationIds } = req.body;

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

    const narrations = await resolveNarrations(narrationIds, companyId);

    const transfer = await BankTransfer.create({
      companyId,
      transferDate: date,
      fromBankId,
      toBankId,
      amount: transferAmount,
      referenceNo: referenceNo || "",
      notes: notes || "",
      narrations,
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
      allocations: [],
      sourceTransferId: transfer._id,
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
      allocations: [],
      sourceTransferId: transfer._id,
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

    // Delete the 2 shadow Payments this transfer minted. Precise match via
    // sourceTransferId for any transfer created after that field existed;
    // legacy transfers (created before this fix) fall back to the old
    // {date, amount, bank-pair} heuristic — fragile against two coincidentally
    // identical transfers, but only ever reached for pre-existing data.
    const linkedByRef = await Payment.find({ companyId: transfer.companyId, sourceTransferId: transfer._id }).select("_id");
    if (linkedByRef.length > 0) {
      await Payment.deleteMany({ _id: { $in: linkedByRef.map((p) => p._id) } });
    } else {
      await Payment.deleteMany({
        companyId: transfer.companyId,
        paymentDate: transfer.transferDate,
        amount: transfer.amount,
        sourceTransferId: null,
        $or: [
          { bankAccountId: transfer.fromBankId, partyId: transfer.toBankId, paymentType: "Pay" },
          { bankAccountId: transfer.toBankId, partyId: transfer.fromBankId, paymentType: "Receive" }
        ]
      });
    }

    await transfer.deleteOne();
    res.status(200).json({ message: "Transfer deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const updateBankTransfer = async (req, res) => {
  try {
    const transfer = await BankTransfer.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!transfer) return res.status(404).json({ message: "Transfer not found" });

    const { companyId, date, amount, fromBankId, toBankId, referenceNo, notes, narrationIds } = req.body;
    
    const newAmount = Number(amount);
    if (!Number.isFinite(newAmount) || newAmount <= 0) {
      return res.status(400).json({ message: "Transfer amount must be greater than 0" });
    }

    if (fromBankId === toBankId) {
      return res.status(400).json({ message: "Source and destination banks cannot be the same" });
    }

    const newFromBank = await BankAccount.findOne({ _id: fromBankId, companyId: req.effectiveCompanyId });
    const newToBank = await BankAccount.findOne({ _id: toBankId, companyId: req.effectiveCompanyId });

    if (!newFromBank || !newToBank) {
      return res.status(404).json({ message: "Bank account not found" });
    }

    // 1. Reverse old effects
    await BankAccount.findByIdAndUpdate(transfer.fromBankId, { $inc: { currentBalance: transfer.amount } });
    await BankAccount.findByIdAndUpdate(transfer.toBankId, { $inc: { currentBalance: -transfer.amount } });

    // 2. Validate new balance constraint (must fetch updated balance for newFromBank)
    const freshFromBank = await BankAccount.findById(fromBankId);
    if ((freshFromBank.currentBalance || 0) < newAmount) {
      // Revert reversal
      await BankAccount.findByIdAndUpdate(transfer.fromBankId, { $inc: { currentBalance: -transfer.amount } });
      await BankAccount.findByIdAndUpdate(transfer.toBankId, { $inc: { currentBalance: transfer.amount } });
      return res.status(400).json({ message: "Insufficient balance in source bank account" });
    }

    // 3. Apply new effects
    await BankAccount.findByIdAndUpdate(fromBankId, { $inc: { currentBalance: -newAmount } });
    await BankAccount.findByIdAndUpdate(toBankId, { $inc: { currentBalance: newAmount } });

    const oldDate = transfer.transferDate;
    const oldAmount = transfer.amount;
    const oldFromBank = transfer.fromBankId;
    const oldToBank = transfer.toBankId;

    if (date) transfer.transferDate = date;
    if (newAmount) transfer.amount = newAmount;
    if (fromBankId) transfer.fromBankId = fromBankId;
    if (toBankId) transfer.toBankId = toBankId;
    if (referenceNo !== undefined) transfer.referenceNo = referenceNo;
    if (notes !== undefined) transfer.notes = notes;

    if (narrationIds !== undefined) {
      transfer.narrations = await resolveNarrations(narrationIds, transfer.companyId);
    }

    await transfer.save();

    // 4. Update the related Payment records — precise match via
    // sourceTransferId where available (see deleteBankTransfer's identical
    // comment), falling back to the old heuristic only for legacy transfers.
    const linkedByRef = await Payment.find({ companyId: transfer.companyId, sourceTransferId: transfer._id });
    if (linkedByRef.length > 0) {
      for (const p of linkedByRef) {
        const isPayLeg = p.paymentType === "Pay";
        await Payment.updateOne(
          { _id: p._id },
          {
            $set: {
              paymentDate: date,
              amount: newAmount,
              notes: notes || "",
              referenceNo: referenceNo || "",
              bankAccountId: isPayLeg ? fromBankId : toBankId,
              partyId: isPayLeg ? toBankId : fromBankId,
            },
          }
        );
      }
    } else {
      await Payment.updateMany({
        companyId: transfer.companyId,
        paymentDate: oldDate,
        amount: oldAmount,
        sourceTransferId: null,
        $or: [
          { bankAccountId: oldFromBank, partyId: oldToBank, paymentType: "Pay" },
          { bankAccountId: oldToBank, partyId: oldFromBank, paymentType: "Receive" }
        ]
      }, {
        $set: {
          paymentDate: date,
          amount: newAmount,
          notes: notes || "",
          referenceNo: referenceNo || "",
        }
      });

      // Also update bank references in the payments since fromBank/toBank might have changed
      await Payment.updateMany({
        companyId: transfer.companyId,
        paymentDate: date,
        amount: newAmount,
        sourceTransferId: null,
        bankAccountId: oldFromBank,
        partyId: oldToBank,
        paymentType: "Pay"
      }, {
        $set: { bankAccountId: fromBankId, partyId: toBankId }
      });

      await Payment.updateMany({
        companyId: transfer.companyId,
        paymentDate: date,
        amount: newAmount,
        sourceTransferId: null,
        bankAccountId: oldToBank,
        partyId: oldFromBank,
        paymentType: "Receive"
      }, {
        $set: { bankAccountId: toBankId, partyId: fromBankId }
      });
    }


    res.status(200).json(transfer);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getBankTransfers,
  getBankTransferById,
  createBankTransfer,
  updateBankTransfer,
  deleteBankTransfer
};
