const ItemSubGroup = require("../models/ItemSubGroup");
const { searchRegex, clampLimit, clampPage } = require("../utils/queryHelpers");

const getItemSubGroups = async (req, res) => {
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

    const [subGroups, total] = await Promise.all([
      ItemSubGroup.find(query).populate("itemNameId", "name").sort({ createdAt: -1 }).skip(skip).limit(parsedLimit).lean(),
      ItemSubGroup.countDocuments(query)
    ]);

    res.status(200).json({
      data: subGroups,
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

const createItemSubGroup = async (req, res) => {
  try {
    const { companyId, name, supplierId, itemNameId, isActive } = req.body;
    if (!companyId || !name) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const exists = await ItemSubGroup.findOne({ companyId, name: name.trim() });
    if (exists) {
      return res.status(400).json({ message: "Item Sub Group already exists in this company" });
    }

    const subGroup = await ItemSubGroup.create({
      companyId,
      name: name.trim(),
      supplierId,
      itemNameId,
      isActive,
    });
    res.status(201).json(subGroup);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const updateItemSubGroup = async (req, res) => {
  try {
    const subGroup = await ItemSubGroup.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!subGroup) {
      return res.status(404).json({ message: "Item Sub Group not found" });
    }

    // Unique index is {companyId, name} — a rename that collides with an existing
    // Sub Group in this company previously had no pre-check at all here, throwing a
    // raw, unformatted Mongo E11000 as a 500 instead of a clean 400 (the sibling
    // master controllers all already have this check).
    if (req.body.name !== undefined) {
      const trimmedName = req.body.name.trim();
      const exists = await ItemSubGroup.findOne({
        companyId: subGroup.companyId,
        name: trimmedName,
        _id: { $ne: subGroup._id },
      });
      if (exists) {
        return res.status(400).json({ message: "Item Sub Group already exists in this company" });
      }
      subGroup.name = trimmedName;
    }

    if (req.body.supplierId !== undefined) subGroup.supplierId = req.body.supplierId;
    if (req.body.itemNameId !== undefined) subGroup.itemNameId = req.body.itemNameId;
    if (req.body.isActive !== undefined) subGroup.isActive = req.body.isActive;

    await subGroup.save();
    res.status(200).json(subGroup);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const deleteItemSubGroup = async (req, res) => {
  try {
    const subGroup = await ItemSubGroup.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!subGroup) {
      return res.status(404).json({ message: "Item Sub Group not found" });
    }
    await subGroup.deleteOne();
    res.status(200).json({ message: "Item Sub Group deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getItemSubGroups,
  createItemSubGroup,
  updateItemSubGroup,
  deleteItemSubGroup,
};
