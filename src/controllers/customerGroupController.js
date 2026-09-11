const CustomerGroup = require("../models/CustomerGroup");
const Customer = require("../models/Customer");
const { sendError } = require("../utils/errorHandler");
const { searchRegex, clampLimit, clampPage } = require("../utils/queryHelpers");

const getCustomerGroups = async (req, res) => {
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
      CustomerGroup.find(query).sort({ createdAt: -1 }).skip(skip).limit(parsedLimit).lean(),
      CustomerGroup.countDocuments(query)
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

const createCustomerGroup = async (req, res) => {
  try {
    const { companyId, name, zoneNo } = req.body;
    if (!companyId || !name) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const groupExists = await CustomerGroup.findOne({ companyId, name });
    if (groupExists) {
      return res.status(400).json({ message: "Customer Group already exists in this company" });
    }

    const group = await CustomerGroup.create({
      companyId,
      name,
      zoneNo,
    });

    res.status(201).json(group);
  } catch (error) {
    sendError(res, error);
  }
};

const updateCustomerGroup = async (req, res) => {
  try {
    const { name, zoneNo } = req.body;
    const group = await CustomerGroup.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });

    if (!group) {
      return res.status(404).json({ message: "Customer Group not found" });
    }

    if (name) {
      const exists = await CustomerGroup.findOne({ companyId: group.companyId, name, _id: { $ne: req.params.id } });
      if (exists) {
        return res.status(400).json({ message: "Another Customer Group already exists with this name" });
      }
      group.name = name;
    }

    if (zoneNo !== undefined) group.zoneNo = zoneNo;

    await group.save();
    res.status(200).json(group);
  } catch (error) {
    sendError(res, error);
  }
};

const deleteCustomerGroup = async (req, res) => {
  try {
    const group = await CustomerGroup.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!group) {
      return res.status(404).json({ message: "Customer Group not found" });
    }

    const hasCustomer = await Customer.exists({ companyId: group.companyId, customerGroupId: group._id });
    if (hasCustomer) {
      return res.status(400).json({ message: "Cannot delete this group — one or more Customers still belong to it." });
    }

    await group.deleteOne();
    res.status(200).json({ message: "Customer Group deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getCustomerGroups,
  createCustomerGroup,
  updateCustomerGroup,
  deleteCustomerGroup,
};
