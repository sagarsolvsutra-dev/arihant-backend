const Hsn = require("../models/Hsn");

// @desc    Get all HSN codes for a company
// @route   GET /api/hsn
// @access  Public
const getHsnCodes = async (req, res) => {
  try {
    const { companyId } = req.query;

    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const hsnCodes = await Hsn.find({ companyId }).sort({ hsnCode: 1 });
    res.status(200).json(hsnCodes);
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
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
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// @desc    Update an HSN code
// @route   PUT /api/hsn/:id
// @access  Public
const updateHsnCode = async (req, res) => {
  try {
    const { description, uqcUnit } = req.body;
    const hsn = await Hsn.findById(req.params.id);

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
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// @desc    Delete an HSN code
// @route   DELETE /api/hsn/:id
// @access  Public
const deleteHsnCode = async (req, res) => {
  try {
    const hsn = await Hsn.findById(req.params.id);

    if (!hsn) {
      return res.status(404).json({ message: "HSN Code not found" });
    }

    await hsn.deleteOne();
    res.status(200).json({ message: "HSN Code deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

module.exports = {
  getHsnCodes,
  createHsnCode,
  updateHsnCode,
  deleteHsnCode,
};
