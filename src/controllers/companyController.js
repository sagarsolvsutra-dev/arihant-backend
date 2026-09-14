const Company = require("../models/Company");
const User = require("../models/User");
const { hashPassword } = require("../utils/crypto");

// @desc    Get single company by ID with admin details
// @route   GET /api/companies/:id
// company_admin/staff may only ever fetch their OWN company — this route has
// no requireRole gate (every logged-in role needs it, e.g. CompanyContext),
// so without this check a company_admin/staff could pass any other
// company's real _id and read its GST No/PAN No plus its admin's real name/
// email/phone. Confirmed as a real, live cross-tenant data leak — not a
// documented/deliberate trade-off. super_admin is unrestricted, as before.
const getCompanyById = async (req, res) => {
  try {
    const { id } = req.params;
    if (req.user.role !== "super_admin" && String(req.user.companyId) !== String(id)) {
      return res
        .status(403)
        .json({ success: false, message: "Forbidden" });
    }
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
// Same tenant-isolation gap as getCompanyById above (no requireRole gate on
// this route) — company_admin/staff must only ever see their OWN company in
// this list, never every other real tenant's GST/PAN/contact info.
// super_admin is unrestricted, as before (the super-admin Companies page and
// the "Add User" company dropdown both need the full list).
const getCompanies = async (req, res) => {
  try {
    const filter = req.user.role === "super_admin" ? {} : { _id: req.user.companyId };
    const companies = await Company.find(filter).sort({ createdAt: -1 }).lean();

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
      // `.lean()` returns exactly what's stored in Mongo — it skips Mongoose's
      // usual default-applying hydration, so a handful of pre-existing
      // companies saved before `isActive` existed on the schema come back
      // with the field simply absent (not `false`). `undefined` is falsy in
      // JS/JSX, so the frontend's `c.isActive ? "Active" : "Inactive"` badge
      // rendered those as Inactive even though they're real, in-use
      // companies. Normalize here rather than trusting the schema default to
      // apply on a lean read.
      isActive: c.isActive !== false,
      adminCount: countMap[c._id.toString()] || 0,
    }));

    res.json({
      success: true,
      companies: companiesWithCount,
    });
  } catch (error) {
    console.error("Get companies error:", error);
    res.status(500).json({ success: false, message: error.message || "Server error" });
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
    const trimmedName = name.trim();

    const existingCode = await Company.findOne({ code: normalizedCode });
    if (existingCode) {
      return res.status(400).json({
        success: false,
        message: "Company code already exists",
      });
    }
    // Company.name also has its own unique index — checked explicitly here (not just
    // relying on the DB to reject it) so a collision surfaces as this same clean 400
    // instead of a raw Mongo E11000 message from an uncaught create() failure.
    const existingName = await Company.findOne({ name: trimmedName });
    if (existingName) {
      return res.status(400).json({
        success: false,
        message: "A company with this name already exists",
      });
    }

    // Validate the admin BEFORE creating the company — otherwise a bad admin email
    // (checked below) rejects the request while the Company row it was validated
    // against has already been permanently committed, leaving an orphaned,
    // admin-less company with no way to discover it short of trial and error.
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
    }

    const company = await Company.create({
      name: trimmedName,
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
      const hashedPassword = await hashPassword(adminData.password);
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

    // `runValidators` does not enforce uniqueness — a same-name collision would
    // otherwise surface as a raw, uncaught Mongo E11000 500. Checked explicitly here.
    if (set.name !== undefined) {
      const trimmedName = String(set.name).trim();
      set.name = trimmedName;
      const existingName = await Company.findOne({ name: trimmedName, _id: { $ne: id } });
      if (existingName) {
        return res.status(400).json({
          success: false,
          message: "A company with this name already exists",
        });
      }
    }

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
      // Only an ACTIVE admin counts as "the existing admin" here — a
      // deactivated one (removed via the frontend's "Remove Admin" action,
      // which soft-deactivates rather than hard-deletes) must NOT be matched
      // and silently edited in place. Without this, filling in fresh admin
      // details after a removal would just update the deactivated row's
      // fields (name/email/etc.) without ever setting isActive back to true,
      // leaving the company still showing "No admin" despite the save
      // appearing to succeed. Excluding inactive rows here means a removed
      // admin's slot is correctly treated as empty, so the `else` branch
      // below creates a genuinely new, active admin instead.
      const existingAdmin = await User.findOne({
        companyId: id,
        role: "company_admin",
        isActive: true,
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
          adminSet.password = await hashPassword(adminUpdates.password);
        }

        updatedUser = await User.findByIdAndUpdate(existingAdmin._id, adminSet, {
          new: true,
        });
      } else {
        // If no ACTIVE admin exists for this company, either create a new
        // admin, or — if the submitted email belongs to an existing but
        // INACTIVE user (e.g. one just removed via the frontend's "Remove
        // Admin" action, which soft-deactivates rather than hard-deletes) —
        // reactivate that same account for this company instead of
        // rejecting it as a duplicate. Without this, an email could never
        // be reused for a company_admin once removed, even to restore the
        // exact same person moments later: confirmed live, removing
        // "sagar" and then re-submitting sagar@gmail.com as the new admin
        // failed with "Admin email sagar@gmail.com already exists." even
        // though the only "existing" row was the just-deactivated one.
        if (adminUpdates.email && adminUpdates.name) {
          const newEmail = adminUpdates.email.toLowerCase().trim();
          const emailExists = await User.findOne({ email: newEmail });

          if (emailExists && emailExists.isActive) {
            return res.status(400).json({
              success: false,
              message: `Admin email ${newEmail} already exists.`,
            });
          }

          if (emailExists) {
            // Reactivate rather than duplicate. Password/phone only change
            // if actually provided, matching the "leave blank to keep
            // current" convention used when editing an already-active admin.
            const reactivateSet = {
              name: adminUpdates.name.trim(),
              role: "company_admin",
              companyId: id,
              isActive: true,
            };
            if (adminUpdates.phone !== undefined) reactivateSet.phone = adminUpdates.phone || "";
            if (adminUpdates.password) reactivateSet.password = await hashPassword(adminUpdates.password);
            updatedUser = await User.findByIdAndUpdate(emailExists._id, reactivateSet, { new: true });
          } else {
            const passwordToUse = adminUpdates.password || "admin123";
            const hashedPassword = await hashPassword(passwordToUse);

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