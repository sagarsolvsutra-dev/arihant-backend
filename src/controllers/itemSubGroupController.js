const ItemSubGroup = require("../models/ItemSubGroup");

const getItemSubGroups = async (req, res) => {
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

    const [subGroups, total] = await Promise.all([
      ItemSubGroup.find(query).populate("itemNameId", "name").sort({ createdAt: -1 }).skip(skip).limit(parsedLimit).lean(),
      ItemSubGroup.countDocuments(query)
    ]);

    res.status(200).json({
      data: subGroups,
      pagination: {
        total,
        page: parseInt(page),
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

    const exists = await ItemSubGroup.findOne({ companyId, name });
    if (exists) {
      return res.status(400).json({ message: "Item Sub Group already exists in this company" });
    }

    const subGroup = await ItemSubGroup.create({
      companyId,
      name,
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
    const subGroup = await ItemSubGroup.findById(req.params.id);
    if (!subGroup) {
      return res.status(404).json({ message: "Item Sub Group not found" });
    }

    if (req.body.name !== undefined) subGroup.name = req.body.name;

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
    const subGroup = await ItemSubGroup.findById(req.params.id);
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
