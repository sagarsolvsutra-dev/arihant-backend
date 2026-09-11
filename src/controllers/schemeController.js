const Scheme = require("../models/Scheme");
const { searchRegex, clampLimit, clampPage } = require("../utils/queryHelpers");

const getSchemes = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, search = "" } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const query = { companyId };
    if (search) {
      query.$or = [
        { name: searchRegex(search) },
        { description: searchRegex(search) }
      ];
    }

    const parsedPage = clampPage(page);
    const parsedLimit = clampLimit(limit);
    const skip = (parsedPage - 1) * parsedLimit;

    const [schemes, total] = await Promise.all([
      Scheme.find(query)
        .populate("customerId", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit).lean(),
      Scheme.countDocuments(query)
    ]);

    res.status(200).json({
      data: schemes,
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

const createScheme = async (req, res) => {
  try {
    const {
      companyId, itemGroupId, customerId, lessPercentage, cdPercentage
    } = req.body;

    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const scheme = await Scheme.create({
      companyId,
      itemGroupId: itemGroupId || null,
      customerId: customerId || null,
      lessPercentage: parseFloat(lessPercentage) || 0,
      cdPercentage: parseFloat(cdPercentage) || 0,
    });

    res.status(201).json(scheme);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const updateScheme = async (req, res) => {
  try {
    const scheme = await Scheme.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!scheme) {
      return res.status(404).json({ message: "Scheme not found" });
    }

    const {
      itemGroupId, customerId, lessPercentage, cdPercentage
    } = req.body;

    if (itemGroupId !== undefined) scheme.itemGroupId = itemGroupId || null;
    if (customerId !== undefined) scheme.customerId = customerId || null;
    if (lessPercentage !== undefined) scheme.lessPercentage = parseFloat(lessPercentage) || 0;
    if (cdPercentage !== undefined) scheme.cdPercentage = parseFloat(cdPercentage) || 0;

    await scheme.save();
    res.status(200).json(scheme);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const deleteScheme = async (req, res) => {
  try {
    const scheme = await Scheme.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!scheme) {
      return res.status(404).json({ message: "Scheme not found" });
    }
    await scheme.deleteOne();
    res.status(200).json({ message: "Scheme deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getSchemes,
  createScheme,
  updateScheme,
  deleteScheme,
};
