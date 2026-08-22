const bcrypt = require("bcryptjs");
const Company = require("../models/Company");
const User = require("../models/User");
const { encryptPassword, decryptPassword } = require("../utils/crypto");

// @desc    Get single company by ID with admin details
// @route   GET /api/companies/:id
const getCompanyById = async (req, res) => {
  try {
    const { id } = req.params;
    const company = await Company.findById(id);
    if (!company) {
      return res
        .status(404)
        .json({ success: false, message: "Company not found" });
    }

    // Get the first (primary) admin for this company
    const admin = await User.findOne({
      companyId: id,
      role: "company_admin",
      isActive: true,
    }).select("-password");

    res.json({
      success: true,
      company: company.toObject(),
      admin,
    });
  } catch (error) {
    console.error("Get company by id error:", error);
    if (error.kind === "ObjectId") {
      return res
        .status(404)
        .json({ success: false, message: "Company not found" });
    }
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// @desc    Get all companies with admin counts
// @route   GET /api/companies
const getCompanies = async (req, res) => {
  try {
    const companies = await Company.find().sort({ createdAt: -1 }).lean();

    const counts = await User.aggregate([
      { $match: { role: "company_admin", isActive: true } },
      { $group: { _id: "$companyId", count: { $sum: 1 } } },
    ]);
    const countMap = {};
    counts.forEach((c) => {
      countMap[c._id ? c._id.toString() : "null"] = c.count;
    });

    const companiesWithCount = companies.map((c) => ({
      ...c,
      adminCount: countMap[c._id.toString()] || 0,
    }));

    res.json({
      success: true,
      companies: companiesWithCount,
    });
  } catch (error) {
    console.error("Get companies error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// @desc    Create new company + first admin user
// @route   POST /api/companies
const createCompany = async (req, res) => {
  try {
    const companyData = req.body.company || req.body;
    const adminData = req.body.admin || null;

    const {
      name,
      code,
      address,
      phone,
      email,
      gstNo,
      panNo,
    } = companyData;

    if (!name || !code) {
      return res.status(400).json({
        success: false,
        message: "Company name and code are required",
      });
    }

    const normalizedCode = code.toLowerCase().trim();

    const existing = await Company.findOne({ code: normalizedCode });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: "Company code already exists",
      });
    }

    const company = await Company.create({
      name: name.trim(),
      code: normalizedCode,
      address: address || "",
      phone: phone || "",
      email: email ? email.toLowerCase().trim() : "",
      gstNo: gstNo ? gstNo.toUpperCase().trim() : "",
      panNo: panNo ? panNo.toUpperCase().trim() : "",
      isActive: true,
    });

    let createdUser = null;
    if (adminData && adminData.name && adminData.email && adminData.password) {
      const existingUser = await User.findOne({
        email: adminData.email.toLowerCase().trim(),
      });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: `Admin email ${adminData.email} already exists.`,
        });
      }

      const hashedPassword = encryptPassword(adminData.password);
      createdUser = await User.create({
        name: adminData.name.trim(),
        email: adminData.email.toLowerCase().trim(),
        phone: adminData.phone || "",
        password: hashedPassword,
        role: "company_admin",
        companyId: company._id,
        isActive: true,
      });
    }

    res.status(201).json({
      success: true,
      message: createdUser
        ? "Company and admin created successfully"
        : "Company created successfully",
      company,
      user: createdUser
        ? {
            _id: createdUser._id,
            name: createdUser.name,
            email: createdUser.email,
            role: createdUser.role,
            companyId: createdUser.companyId,
          }
        : null,
    });
  } catch (error) {
    console.error("Create company error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
};

// @desc    Update company
// @route   PUT /api/companies/:id
const updateCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = (req.body.company || req.body) || {};

    const allowed = [
      "name",
      "address",
      "phone",
      "email",
      "gstNo",
      "panNo",
      "isActive",
    ];
    const set = {};
    allowed.forEach((k) => {
      if (updates[k] !== undefined) set[k] = updates[k];
    });

    const company = await Company.findByIdAndUpdate(id, set, {
      new: true,
      runValidators: true,
    });

    if (!company) {
      return res
        .status(404)
        .json({ success: false, message: "Company not found" });
    }

    // If admin updates provided
    let updatedUser = null;
    if (req.body.admin) {
      const adminUpdates = req.body.admin;
      const existingAdmin = await User.findOne({
        companyId: id,
        role: "company_admin",
      });

      if (existingAdmin) {
        const adminSet = {};
        if (adminUpdates.name) adminSet.name = adminUpdates.name.trim();
        if (adminUpdates.email) {
          const newEmail = adminUpdates.email.toLowerCase().trim();
          if (newEmail !== existingAdmin.email) {
            const emailExists = await User.findOne({ email: newEmail });
            if (emailExists) {
              return res.status(400).json({
                success: false,
                message: `Admin email ${newEmail} already exists.`,
              });
            }
            adminSet.email = newEmail;
          }
        }
        if (adminUpdates.phone !== undefined)
          adminSet.phone = adminUpdates.phone || "";
        if (adminUpdates.password) {
          adminSet.password = encryptPassword(adminUpdates.password);
        }

        updatedUser = await User.findByIdAndUpdate(existingAdmin._id, adminSet, {
          new: true,
        });
      } else {
        // If no admin exists for this company, create a new admin
        if (adminUpdates.email && adminUpdates.name) {
          const newEmail = adminUpdates.email.toLowerCase().trim();
          const emailExists = await User.findOne({ email: newEmail });
          if (emailExists) {
            return res.status(400).json({
              success: false,
              message: `Admin email ${newEmail} already exists.`,
            });
          }

          const passwordToUse = adminUpdates.password || "admin123";
          const hashedPassword = encryptPassword(passwordToUse);

          updatedUser = await User.create({
            name: adminUpdates.name.trim(),
            email: newEmail,
            phone: adminUpdates.phone || "",
            password: hashedPassword,
            role: "company_admin",
            companyId: id,
            isActive: true,
          });
        }
      }
    }

    res.json({
      success: true,
      message: "Company updated successfully",
      company,
      user: updatedUser
        ? {
            _id: updatedUser._id,
            name: updatedUser.name,
            email: updatedUser.email,
            role: updatedUser.role,
            companyId: updatedUser.companyId,
          }
        : null,
    });
  } catch (error) {
    console.error("Update company error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
};

const deleteCompany = async (req, res) => {
  try {
    const { id } = req.params;

    const company = await Company.findById(id);
    if (!company) {
      return res
        .status(404)
        .json({ success: false, message: "Company not found" });
    }

    // Hard delete admins
    await User.deleteMany({ companyId: id });

    // Hard delete company
    await Company.findByIdAndDelete(id);

    res.json({
      success: true,
      message: `Company "${company.name}" and its admins deleted successfully`,
    });
  } catch (error) {
    console.error("Delete company error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
};

module.exports = { getCompanyById, getCompanies, createCompany, updateCompany, deleteCompany };