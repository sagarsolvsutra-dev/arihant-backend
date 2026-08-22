const ItemName = require("../models/ItemName");

exports.createItemName = async (req, res) => {
  try {
    const { companyId, itemGroupId, name, isActive } = req.body;
    if (!companyId || !itemGroupId || !name) {
      return res.status(400).json({ message: "Company ID, Item Group ID, and Name are required" });
    }

    const exists = await ItemName.findOne({ companyId, itemGroupId, name: name.trim() });
    if (exists) {
      return res.status(400).json({ message: "Item Name already exists in this group" });
    }

    const itemName = new ItemName({
      companyId,
      itemGroupId,
      name: name.trim(),
      isActive: isActive !== undefined ? isActive : true,
    });

    await itemName.save();
    res.status(201).json(itemName);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getItemNames = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { search, itemGroupId } = req.query;

    if (!companyId) {
      return res.status(400).json({ message: "Company ID is required" });
    }

    let filter = { companyId };
    if (itemGroupId) {
      filter.itemGroupId = itemGroupId;
    }
    
    if (search) {
      filter.name = { $regex: search, $options: "i" };
    }

    const itemNames = await ItemName.find(filter).lean()
      .populate("itemGroupId", "name")
      .sort({ createdAt: -1 }).lean();
      
    res.status(200).json({ data: itemNames });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateItemName = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, itemGroupId, isActive } = req.body;

    const itemName = await ItemName.findById(id);
    if (!itemName) {
      return res.status(404).json({ message: "Item Name not found" });
    }

    if (name) itemName.name = name.trim();
    if (itemGroupId) itemName.itemGroupId = itemGroupId;
    if (isActive !== undefined) itemName.isActive = isActive;

    await itemName.save();
    res.status(200).json(itemName);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deleteItemName = async (req, res) => {
  try {
    const { id } = req.params;
    const itemName = await ItemName.findByIdAndDelete(id);
    if (!itemName) {
      return res.status(404).json({ message: "Item Name not found" });
    }
    res.status(200).json({ message: "Item Name deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
