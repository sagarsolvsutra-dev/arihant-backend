const Narration = require("../models/Narration");
const { searchRegex, clampLimit, clampPage } = require("../utils/queryHelpers");

const getNarrations = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, search = "" } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const query = { companyId };
    if (search) {
      const r = searchRegex(search);
      query.$or = [{ type: r }, { code: r }];
    }

    const parsedPage = clampPage(page);
    const parsedLimit = clampLimit(limit);
    const skip = (parsedPage - 1) * parsedLimit;

    // Seed default narrations if fetching without search
    if (!search) {
      const defaults = [
        { type: 'Accounting', code: 'AC' },
        { type: 'Cheque', code: 'CHQ' },
        { type: 'RTGS', code: 'RTGS' },
        { type: 'NEFT', code: 'NEFT' },
        { type: 'IMPS', code: 'IMPS' },
        { type: 'Cash Receipt', code: 'CR' },
        { type: 'Cash Payment', code: 'CP' },
        { type: 'Invoice Ref', code: 'INV' },
        { type: 'Bill Ref', code: 'BILL' },
        { type: 'Adjustment', code: 'ADJ' }
      ];
      for (const d of defaults) {
        await Narration.updateOne(
          { companyId, code: d.code },
          { $setOnInsert: { companyId, type: d.type, code: d.code } },
          { upsert: true }
        );
      }
    }

    const [narrations, total] = await Promise.all([
      Narration.find(query).sort({ type: 1, code: 1 }).skip(skip).limit(parsedLimit).lean(),
      Narration.countDocuments(query),
    ]);

    res.status(200).json({
      data: narrations,
      pagination: { total, page: parsedPage, limit: parsedLimit, totalPages: Math.ceil(total / parsedLimit) },
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const createNarration = async (req, res) => {
  try {
    const { companyId, type, code } = req.body;
    if (!companyId || !type || !code) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const exists = await Narration.findOne({ companyId, type: type.trim(), code: code.trim() });
    if (exists) {
      return res.status(400).json({ message: "A Narration with this Type and Code already exists" });
    }

    const narration = await Narration.create({ companyId, type: type.trim(), code: code.trim() });
    res.status(201).json(narration);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const updateNarration = async (req, res) => {
  try {
    const narration = await Narration.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!narration) {
      return res.status(404).json({ message: "Narration not found" });
    }

    const { type, code, isActive } = req.body;
    const newType = type !== undefined ? type.trim() : narration.type;
    const newCode = code !== undefined ? code.trim() : narration.code;

    if (type !== undefined || code !== undefined) {
      const exists = await Narration.findOne({
        companyId: narration.companyId,
        type: newType,
        code: newCode,
        _id: { $ne: req.params.id },
      });
      if (exists) {
        return res.status(400).json({ message: "Another Narration already exists with this Type and Code" });
      }
      narration.type = newType;
      narration.code = newCode;
    }

    if (isActive !== undefined) narration.isActive = isActive;

    await narration.save();
    res.status(200).json(narration);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const deleteNarration = async (req, res) => {
  try {
    const narration = await Narration.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!narration) {
      return res.status(404).json({ message: "Narration not found" });
    }
    // Narrations are snapshotted (type+code copied) onto Expense/Payment/
    // BankTransfer at the moment they're attached, not referenced live — so,
    // deliberately unlike every other master's deleteX, there is no
    // reference check here: deleting a Narration can never orphan or corrupt
    // a past transaction's own copy of it. See each model's `narrations[]`
    // field comment for the snapshot rationale.
    await narration.deleteOne();
    res.status(200).json({ message: "Narration deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getNarrations,
  createNarration,
  updateNarration,
  deleteNarration,
};
