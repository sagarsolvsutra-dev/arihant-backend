const Hsn = require("../models/Hsn");
const Item = require("../models/Item");
const { sendError } = require("../utils/errorHandler");
const { searchRegex, clampLimit, clampPage } = require("../utils/queryHelpers");

// @desc    Get all HSN codes for a company
// @route   GET /api/hsn
// @access  Public
const getHsnCodes = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, search = "" } = req.query;

    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const query = { companyId };
    if (search) {
      query.$or = [
        { hsnCode: searchRegex(search) },
        { description: searchRegex(search) }
      ];
    }

    const parsedPage = clampPage(page);
    const parsedLimit = clampLimit(limit);
    const skip = (parsedPage - 1) * parsedLimit;

    const [hsnCodes, total] = await Promise.all([
      Hsn.find(query).sort({ createdAt: -1 }).skip(skip).limit(parsedLimit).lean(),
      Hsn.countDocuments(query)
    ]);

    res.status(200).json({
      data: hsnCodes,
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

// @desc    Create a new HSN code
// @route   POST /api/hsn
// @access  Public
const createHsnCode = async (req, res) => {
  try {
    const { companyId, hsnCode, description, uqcUnit } = req.body;

    if (!companyId || !hsnCode || !description || !uqcUnit) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    // Prevent special characters in description as per screen warning
    const hasSpecialChars = /[()\[\]{}|\\^%`]/.test(description);
    if (hasSpecialChars) {
      return res.status(400).json({ message: "Special characters like ( ), [ ], { } are not allowed in description" });
    }

    // Check if HSN code already exists for this company
    const hsnExists = await Hsn.findOne({ companyId, hsnCode });
    if (hsnExists) {
      return res.status(400).json({ message: "HSN Code already exists in this company" });
    }

    const newHsn = await Hsn.create({
      companyId,
      hsnCode,
      description,
      uqcUnit,
    });

    res.status(201).json(newHsn);
  } catch (error) {
    sendError(res, error);
  }
};

// @desc    Update an HSN code
// @route   PUT /api/hsn/:id
// @access  Public
const updateHsnCode = async (req, res) => {
  try {
    const { description, uqcUnit } = req.body;
    const hsn = await Hsn.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });

    if (!hsn) {
      return res.status(404).json({ message: "HSN Code not found" });
    }

    if (description) {
      const hasSpecialChars = /[()\[\]{}|\\^%`]/.test(description);
      if (hasSpecialChars) {
        return res.status(400).json({ message: "Special characters are not allowed in description" });
      }
      hsn.description = description;
    }

    if (uqcUnit) {
      hsn.uqcUnit = uqcUnit;
    }

    await hsn.save();
    res.status(200).json(hsn);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

// @desc    Delete an HSN code
// @route   DELETE /api/hsn/:id
// @access  Public
const deleteHsnCode = async (req, res) => {
  try {
    const hsn = await Hsn.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });

    if (!hsn) {
      return res.status(404).json({ message: "HSN Code not found" });
    }

    // Item.hsnCode is a plain string (the code itself), not an ObjectId ref to
    // this model — matched by value, not by _id.
    const hasItem = await Item.exists({ companyId: hsn.companyId, hsnCode: hsn.hsnCode });
    if (hasItem) {
      return res.status(400).json({
        message: "Cannot delete this HSN code — it is still referenced by one or more Items. Change those Items' HSN Code first.",
      });
    }

    await hsn.deleteOne();
    res.status(200).json({ message: "HSN Code deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getHsnCodes,
  createHsnCode,
  updateHsnCode,
  deleteHsnCode,
};
