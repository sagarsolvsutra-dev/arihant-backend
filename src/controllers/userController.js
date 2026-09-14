const User = require("../models/User");
const Company = require("../models/Company");
const { hashPassword } = require("../utils/crypto");
const { sanitizePermissions } = require("../utils/permissions");

// @desc    Delete (soft) user
// @route   DELETE /api/users/:id
// company_admin may only deactivate a `staff` user belonging to their own
// company — never another company_admin, never super_admin, never a staff
// member of a different company. super_admin keeps its existing unrestricted
// access (still blocked from deleting super_admin accounts).
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    if (user.role === "super_admin") {
      return res
        .status(403)
        .json({ success: false, message: "Cannot delete super admin" });
    }

    if (req.user.role === "company_admin") {
      if (user.role !== "staff" || String(user.companyId) !== String(req.user.companyId)) {
        return res.status(403).json({ success: false, message: "You can only remove staff from your own company" });
      }
    }

    user.isActive = false;
    await user.save();

    res.json({
      success: true,
      message: `User "${user.name}" deactivated`,
    });
  } catch (error) {
    console.error("Delete user error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
};

// @desc    Get all users
// @route   GET /api/users
// super_admin: unrestricted, existing behavior — any company, any role,
// via the query params (already trusted, this route is super_admin-only
// unless the caller is company_admin, handled below).
// company_admin: hard-scoped to their OWN company's `staff` users only,
// ignoring whatever companyId/role the client actually sent — this is the
// real security boundary for the new Staff management page.
const getUsers = async (req, res) => {
  try {
    let query = {};
    if (req.user.role === "company_admin") {
      query = { companyId: req.user.companyId, role: "staff" };
    } else {
      const { companyId, role } = req.query;
      if (companyId) query.companyId = companyId;
      if (role) query.role = role;
    }

    const users = await User.find(query)
      .select("-password")
      .populate("companyId", "name code")
      .sort({ createdAt: -1 }).lean();

    res.status(200).json(users);
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
};

// @desc    Create a staff user for the caller's own company
// @route   POST /api/users
// company_admin only (enforced by route-level requireRole) — role is always
// forced to "staff" and companyId is always forced to req.user.companyId,
// regardless of what's in the request body, so a company_admin can never
// mint a company_admin/super_admin account or a staff account under a
// different company through this endpoint.
const createStaff = async (req, res) => {
  try {
    const { name, email, phone, password, permissions } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: "Name, email, and password are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(400).json({ success: false, message: "Email already registered" });
    }

    const hashedPassword = await hashPassword(password);

    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      phone: phone || "",
      password: hashedPassword,
      role: "staff",
      companyId: req.user.companyId,
      permissions: sanitizePermissions(permissions),
      isActive: true,
    });

    res.status(201).json({
      success: true,
      message: "Staff created successfully",
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        companyId: user.companyId,
        permissions: user.permissions,
        isActive: user.isActive,
      },
    });
  } catch (error) {
    console.error("Create staff error:", error);
    res.status(500).json({ success: false, message: error.message || "Server error" });
  }
};

// @desc    Update a staff user (name/phone/password/permissions/isActive)
// @route   PUT /api/users/:id
// company_admin only, and only for a `staff` user belonging to their own
// company — verified before any field is touched. Password only changes if
// actually provided (same "leave blank to keep current" convention used
// elsewhere in this app, e.g. super-admin/companies' admin-edit form).
const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if (user.role !== "staff" || String(user.companyId) !== String(req.user.companyId)) {
      return res.status(403).json({ success: false, message: "You can only edit staff from your own company" });
    }

    const { name, phone, password, permissions, isActive } = req.body;
    if (name !== undefined) user.name = name.trim();
    if (phone !== undefined) user.phone = phone || "";
    if (permissions !== undefined) user.permissions = sanitizePermissions(permissions);
    if (isActive !== undefined) user.isActive = !!isActive;
    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
      }
      user.password = await hashPassword(password);
    }

    await user.save();

    res.json({
      success: true,
      message: "Staff updated successfully",
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        companyId: user.companyId,
        permissions: user.permissions,
        isActive: user.isActive,
      },
    });
  } catch (error) {
    console.error("Update user error:", error);
    res.status(500).json({ success: false, message: error.message || "Server error" });
  }
};

module.exports = { deleteUser, getUsers, createStaff, updateUser };
