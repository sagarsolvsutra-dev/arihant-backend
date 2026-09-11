const Godown = require("../models/Godown");
const Item = require("../models/Item");
const Purchase = require("../models/Purchase");
const Sale = require("../models/Sale");
const PurchaseReturn = require("../models/PurchaseReturn");
const SaleReturn = require("../models/SaleReturn");
const StockTransfer = require("../models/StockTransfer");
const { sendError } = require("../utils/errorHandler");
const { searchRegex, clampLimit, clampPage } = require("../utils/queryHelpers");

const getGodowns = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, search = "" } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const query = { companyId };
    if (search) {
      query.name = searchRegex(search);
    }

    const parsedPage = clampPage(page);
    const parsedLimit = clampLimit(limit);
    const skip = (parsedPage - 1) * parsedLimit;

    const [godowns, total] = await Promise.all([
      Godown.find(query)
        .populate("godownGroupId", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit)
        .lean(),
      Godown.countDocuments(query)
    ]);

    res.status(200).json({
      data: godowns,
      pagination: {
        total,
        page: parsedPage,
        limit: parsedLimit,
        totalPages: Math.ceil(total / parsedLimit)
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const createGodown = async (req, res) => {
  try {
    const { companyId, name, godownGroupId, isActive } = req.body;
    if (!companyId || !name) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const exists = await Godown.findOne({ companyId, name, godownGroupId: godownGroupId || null });
    if (exists) {
      return res.status(400).json({ message: "A godown with this name already exists in this Group" });
    }

    const godown = await Godown.create({
      companyId,
      name: name.trim(),
      godownGroupId: godownGroupId || null,
      isActive: isActive !== undefined ? isActive : true,
    });

    res.status(201).json(godown);
  } catch (error) {
    sendError(res, error);
  }
};

const updateGodown = async (req, res) => {
  try {
    const { name, godownGroupId, isActive } = req.body;
    const godown = await Godown.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });

    if (!godown) {
      return res.status(404).json({ message: "Godown not found" });
    }

    // Name + Group together identify a unique godown (same rule as createGodown/the
    // compound index) — runs whenever either field is present, using the EFFECTIVE
    // post-update value for whichever one isn't being changed right now.
    if (name !== undefined || godownGroupId !== undefined) {
      const effectiveName = name !== undefined ? name.trim() : godown.name;
      const effectiveGroupId = godownGroupId !== undefined ? (godownGroupId || null) : (godown.godownGroupId || null);
      const exists = await Godown.findOne({
        companyId: godown.companyId,
        name: effectiveName,
        godownGroupId: effectiveGroupId,
        _id: { $ne: req.params.id },
      });
      if (exists) {
        return res.status(400).json({ message: "A godown with this name already exists in this Group" });
      }
    }
    if (name !== undefined) godown.name = name.trim();
    if (godownGroupId !== undefined) godown.godownGroupId = godownGroupId || null;
    if (isActive !== undefined) godown.isActive = isActive;

    await godown.save();
    res.status(200).json(godown);
  } catch (error) {
    sendError(res, error);
  }
};

const deleteGodown = async (req, res) => {
  try {
    const godown = await Godown.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!godown) {
      return res.status(404).json({ message: "Godown not found" });
    }

    // Every Purchase/Sale/PurchaseReturn/SaleReturn line's godownId (required) and
    // every StockTransfer's fromGodownId/toGodownId reference Godown; so does every
    // Item.mrpEntries[].godownStock[].godownId. Hard-deleting a Godown with live
    // stock/transaction history strands that stock permanently and orphans every
    // historical row's Godown reference.
    const [hasPurchase, hasSale, hasPurchaseReturn, hasSaleReturn, hasTransfer, hasItemStock] = await Promise.all([
      Purchase.exists({ companyId: godown.companyId, "items.godownId": godown._id }),
      Sale.exists({ companyId: godown.companyId, "items.godownId": godown._id }),
      PurchaseReturn.exists({ companyId: godown.companyId, "items.godownId": godown._id }),
      SaleReturn.exists({ companyId: godown.companyId, "items.godownId": godown._id }),
      StockTransfer.exists({
        companyId: godown.companyId,
        $or: [{ fromGodownId: godown._id }, { toGodownId: godown._id }],
      }),
      Item.exists({ companyId: godown.companyId, "mrpEntries.godownStock.godownId": godown._id }),
    ]);
    if (hasPurchase || hasSale || hasPurchaseReturn || hasSaleReturn || hasTransfer || hasItemStock) {
      return res.status(400).json({
        message: "Cannot delete this godown — it has Purchase, Sale, Return, Stock Transfer, or stock history. Deactivate it instead.",
      });
    }

    await godown.deleteOne();
    res.status(200).json({ message: "Godown deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getGodowns,
  createGodown,
  updateGodown,
  deleteGodown,
};
