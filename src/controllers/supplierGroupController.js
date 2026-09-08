const SupplierGroup = require("../models/SupplierGroup");
const Supplier = require("../models/Supplier");
const { sendError } = require("../utils/errorHandler");
const { searchRegex, clampLimit, clampPage } = require("../utils/queryHelpers");

const getSupplierGroups = async (req, res) => {
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

    const [groups, total] = await Promise.all([
      SupplierGroup.find(query).sort({ createdAt: -1 }).skip(skip).limit(parsedLimit).lean(),
      SupplierGroup.countDocuments(query)
    ]);

    res.status(200).json({
      data: groups,
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

const createSupplierGroup = async (req, res) => {
  try {
    const { companyId, name } = req.body;
    if (!companyId || !name) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const groupExists = await SupplierGroup.findOne({ companyId, name });
    if (groupExists) {
      return res.status(400).json({ message: "Supplier Group already exists in this company" });
    }

    const group = await SupplierGroup.create({
      companyId,
      name,
    });

    res.status(201).json(group);
  } catch (error) {
    sendError(res, error);
  }
};

const updateSupplierGroup = async (req, res) => {
  try {
    const { name } = req.body;
    const group = await SupplierGroup.findById(req.params.id);

    if (!group) {
      return res.status(404).json({ message: "Supplier Group not found" });
    }

    if (name) {
      const exists = await SupplierGroup.findOne({ companyId: group.companyId, name, _id: { $ne: req.params.id } });
      if (exists) {
        return res.status(400).json({ message: "Another Supplier Group already exists with this name" });
      }
      group.name = name;
    }

    await group.save();
    res.status(200).json(group);
  } catch (error) {
    sendError(res, error);
  }
};

const deleteSupplierGroup = async (req, res) => {
  try {
    const group = await SupplierGroup.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ message: "Supplier Group not found" });
    }

    const hasSupplier = await Supplier.exists({ companyId: group.companyId, supplierGroupId: group._id });
    if (hasSupplier) {
      return res.status(400).json({ message: "Cannot delete this group — one or more Suppliers still belong to it." });
    }

    await group.deleteOne();
    res.status(200).json({ message: "Supplier Group deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getSupplierGroups,
  createSupplierGroup,
  updateSupplierGroup,
  deleteSupplierGroup,
};
