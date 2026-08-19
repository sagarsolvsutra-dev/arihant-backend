const SupplierGroup = require("../models/SupplierGroup");

const getSupplierGroups = async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }
    const groups = await SupplierGroup.find({ companyId }).sort({ name: 1 });
    res.status(200).json(groups);
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
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
    res.status(500).json({ message: "Server Error", error: error.message });
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
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

const deleteSupplierGroup = async (req, res) => {
  try {
    const group = await SupplierGroup.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ message: "Supplier Group not found" });
    }
    await group.deleteOne();
    res.status(200).json({ message: "Supplier Group deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

module.exports = {
  getSupplierGroups,
  createSupplierGroup,
  updateSupplierGroup,
  deleteSupplierGroup,
};
