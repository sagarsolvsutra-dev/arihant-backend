const ItemGroup = require("../models/ItemGroup");

const getItemGroups = async (req, res) => {
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
      ItemGroup.find(query).sort({ createdAt: -1 }).skip(skip).limit(parsedLimit).lean(),
      ItemGroup.countDocuments(query)
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

const createItemGroup = async (req, res) => {
  try {
    const { companyId, name, shortName, commissionRate, isActive } = req.body;
    if (!companyId || !name) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const groupExists = await ItemGroup.findOne({ companyId, name });
    if (groupExists) {
      return res.status(400).json({ message: "Item Group already exists in this company" });
    }

    const group = await ItemGroup.create({
      companyId,
      name,
      shortName,
      commissionRate: commissionRate !== undefined ? commissionRate : 0.00,
      isActive: isActive !== undefined ? isActive : true,
    });

    res.status(201).json(group);
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

const updateItemGroup = async (req, res) => {
  try {
    const { name, shortName, commissionRate, isActive } = req.body;
    const group = await ItemGroup.findById(req.params.id);

    if (!group) {
      return res.status(404).json({ message: "Item Group not found" });
    }

    if (name) {
      const exists = await ItemGroup.findOne({ companyId: group.companyId, name, _id: { $ne: req.params.id } });
      if (exists) {
        return res.status(400).json({ message: "Another Item Group already exists with this name" });
      }
      group.name = name;
    }

    if (shortName !== undefined) group.shortName = shortName;
    if (commissionRate !== undefined) group.commissionRate = commissionRate;
    if (isActive !== undefined) group.isActive = isActive;

    await group.save();
    res.status(200).json(group);
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

const deleteItemGroup = async (req, res) => {
  try {
    const group = await ItemGroup.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ message: "Item Group not found" });
    }
    await group.deleteOne();
    res.status(200).json({ message: "Item Group deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

module.exports = {
  getItemGroups,
  createItemGroup,
  updateItemGroup,
  deleteItemGroup,
};
