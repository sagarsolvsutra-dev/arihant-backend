const User = require("../models/User");
const Company = require("../models/Company");

// @desc    Delete (soft) user
// @route   DELETE /api/users/:id
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
const getUsers = async (req, res) => {
  try {
    const { companyId, role } = req.query;

    let query = {};
    if (companyId) query.companyId = companyId;
    if (role) query.role = role;

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

module.exports = { deleteUser, getUsers };