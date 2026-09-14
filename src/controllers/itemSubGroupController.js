const ItemSubGroup = require("../models/ItemSubGroup");
const Item = require("../models/Item");
const Supplier = require("../models/Supplier");
const ItemName = require("../models/ItemName");
const { searchRegex, clampLimit, clampPage, assertRefBelongsToCompany } = require("../utils/queryHelpers");

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

    // Cross-tenant reference leak guard — see queryHelpers.assertRefBelongsToCompany.
    await assertRefBelongsToCompany(Supplier, supplierId, companyId, "Supplier");
    await assertRefBelongsToCompany(ItemName, itemNameId, companyId, "Item Name");

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

    if (req.body.supplierId !== undefined) {
      await assertRefBelongsToCompany(Supplier, req.body.supplierId, subGroup.companyId, "Supplier");
      subGroup.supplierId = req.body.supplierId;
    }
    if (req.body.itemNameId !== undefined) {
      await assertRefBelongsToCompany(ItemName, req.body.itemNameId, subGroup.companyId, "Item Name");
      subGroup.itemNameId = req.body.itemNameId;
    }
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

    // Every sibling group controller (Customer/Supplier/Godown Group) already
    // checks its children before hard-deleting — this one was the one
    // outlier, hard-deleting unconditionally even though Item.itemSubGroupId
    // is a real ref (and half of Item's own compound unique index), silently
    // orphaning every Item that pointed at it.
    const hasItem = await Item.exists({ companyId: subGroup.companyId, itemSubGroupId: subGroup._id });
    if (hasItem) {
      return res.status(400).json({ message: "Cannot delete this Sub Group — one or more Items still belong to it." });
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
