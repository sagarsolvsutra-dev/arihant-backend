const CustomerGroup = require("../models/CustomerGroup");

const getCustomerGroups = async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }
    const groups = await CustomerGroup.find({ companyId }).sort({ name: 1 });
    res.status(200).json(groups);
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
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
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

const updateCustomerGroup = async (req, res) => {
  try {
    const { name, zoneNo } = req.body;
    const group = await CustomerGroup.findById(req.params.id);

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
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

const deleteCustomerGroup = async (req, res) => {
  try {
    const group = await CustomerGroup.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ message: "Customer Group not found" });
    }
    await group.deleteOne();
    res.status(200).json({ message: "Customer Group deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

module.exports = {
  getCustomerGroups,
  createCustomerGroup,
  updateCustomerGroup,
  deleteCustomerGroup,
};
