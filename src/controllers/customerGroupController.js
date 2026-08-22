const CustomerGroup = require("../models/CustomerGroup");

const getCustomerGroups = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, search = "" } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const query = { companyId };
    if (search) {
      query.name = { $regex: search, $options: "i" };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const parsedLimit = parseInt(limit);

    const [groups, total] = await Promise.all([
      CustomerGroup.find(query).sort({ createdAt: -1 }).skip(skip).limit(parsedLimit).lean(),
      CustomerGroup.countDocuments(query)
    ]);

    res.status(200).json({
      data: groups,
      pagination: {
        total,
        page: parseInt(page),
        limit: parsedLimit,
        totalPages: Math.ceil(total / parsedLimit)
      }
    });
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
