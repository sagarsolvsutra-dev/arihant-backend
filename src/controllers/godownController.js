const Godown = require("../models/Godown");
const { sendError } = require("../utils/errorHandler");

const getGodowns = async (req, res) => {
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

    const [godowns, total] = await Promise.all([
      Godown.find(query)
        .populate("godownGroupId", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit)
        .lean(),
      Godown.countDocuments(query)
    ]);

    res.status(200).json({
      data: godowns,
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

const createGodown = async (req, res) => {
  try {
    const { companyId, name, godownGroupId, isActive } = req.body;
    if (!companyId || !name) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const exists = await Godown.findOne({ companyId, name });
    if (exists) {
      return res.status(400).json({ message: "Godown already exists in this company" });
    }

    const godown = await Godown.create({
      companyId,
      name: name.trim(),
      godownGroupId: godownGroupId || null,
      isActive: isActive !== undefined ? isActive : true,
    });

    res.status(201).json(godown);
  } catch (error) {
    sendError(res, error);
  }
};

const updateGodown = async (req, res) => {
  try {
    const { name, godownGroupId, isActive } = req.body;
    const godown = await Godown.findById(req.params.id);

    if (!godown) {
      return res.status(404).json({ message: "Godown not found" });
    }

    if (name) {
      const exists = await Godown.findOne({ companyId: godown.companyId, name: name.trim(), _id: { $ne: req.params.id } });
      if (exists) {
        return res.status(400).json({ message: "Another Godown already exists with this name" });
      }
      godown.name = name.trim();
    }
    if (godownGroupId !== undefined) godown.godownGroupId = godownGroupId || null;
    if (isActive !== undefined) godown.isActive = isActive;

    await godown.save();
    res.status(200).json(godown);
  } catch (error) {
    sendError(res, error);
  }
};

const deleteGodown = async (req, res) => {
  try {
    const godown = await Godown.findById(req.params.id);
    if (!godown) {
      return res.status(404).json({ message: "Godown not found" });
    }
    await godown.deleteOne();
    res.status(200).json({ message: "Godown deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getGodowns,
  createGodown,
  updateGodown,
  deleteGodown,
};
