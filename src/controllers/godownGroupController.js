const GodownGroup = require("../models/GodownGroup");
const { sendError } = require("../utils/errorHandler");

const getGodownGroups = async (req, res) => {
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
      GodownGroup.find(query).sort({ createdAt: -1 }).skip(skip).limit(parsedLimit).lean(),
      GodownGroup.countDocuments(query)
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
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const createGodownGroup = async (req, res) => {
  try {
    const { companyId, name } = req.body;
    if (!companyId || !name) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const groupExists = await GodownGroup.findOne({ companyId, name });
    if (groupExists) {
      return res.status(400).json({ message: "Godown Group already exists in this company" });
    }

    const group = await GodownGroup.create({
      companyId,
      name,
    });

    res.status(201).json(group);
  } catch (error) {
    sendError(res, error);
  }
};

const updateGodownGroup = async (req, res) => {
  try {
    const { name } = req.body;
    const group = await GodownGroup.findById(req.params.id);

    if (!group) {
      return res.status(404).json({ message: "Godown Group not found" });
    }

    if (name) {
      const exists = await GodownGroup.findOne({ companyId: group.companyId, name, _id: { $ne: req.params.id } });
      if (exists) {
        return res.status(400).json({ message: "Another Godown Group already exists with this name" });
      }
      group.name = name;
    }

    await group.save();
    res.status(200).json(group);
  } catch (error) {
    sendError(res, error);
  }
};

const deleteGodownGroup = async (req, res) => {
  try {
    const group = await GodownGroup.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ message: "Godown Group not found" });
    }
    await group.deleteOne();
    res.status(200).json({ message: "Godown Group deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getGodownGroups,
  createGodownGroup,
  updateGodownGroup,
  deleteGodownGroup,
};
