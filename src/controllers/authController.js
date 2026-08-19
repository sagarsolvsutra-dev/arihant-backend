const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Company = require("../models/Company");
const { encryptPassword, decryptPassword } = require("../utils/crypto");

const JWT_SECRET = process.env.JWT_SECRET || "arihant-erp-secret-key-2024";

// Generate JWT Token
const generateToken = (user) => {
  return jwt.sign(
    {
      userId: user._id.toString(),
      email: user.email,
      role: user.role,
      companyId: user.companyId ? user.companyId.toString() : null,
    },
    JWT_SECRET,
    { expiresIn: "24h" }
  );
};

// @desc    Login user
// @route   POST /api/auth/login
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "Email and password are required" });
    }

    // Find user
    const user = await User.findOne({
      email: email.toLowerCase(),
      isActive: true,
    }).populate("companyId", "name code");

    if (!user) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid email or password" });
    }

    // Compare password
    let isMatch = false;
    try {
      const decrypted = decryptPassword(user.password);
      if (decrypted) {
        isMatch = decrypted === password;
      }
    } catch (e) {}

    // Fallback to bcrypt
    if (!isMatch) {
      try {
        isMatch = await bcrypt.compare(password, user.password);
      } catch (e) {}
    }

    if (!isMatch) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid email or password" });
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    // Generate token
    const token = generateToken(user);

    res.json({
      success: true,
      message: "Login successful!",
      token,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        companyId: user.companyId ? user.companyId._id : null,
        companyName: user.companyId ? user.companyId.name : null,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// @desc    Get current user
// @route   GET /api/auth/me
const me = async (req, res) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res
        .status(401)
        .json({ success: false, message: "No token provided" });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId).populate(
      "companyId",
      "name code"
    );

    if (!user || !user.isActive) {
      return res
        .status(401)
        .json({ success: false, message: "User not found or inactive" });
    }

    res.json({
      success: true,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        companyId: user.companyId ? user.companyId._id : null,
        companyName: user.companyId ? user.companyId.name : null,
      },
    });
  } catch (error) {
    console.error("Auth check error:", error);
    res.status(401).json({ success: false, message: "Invalid token" });
  }
};

// @desc    Register a new user
// @route   POST /api/auth/register
const register = async (req, res) => {
  try {
    const { name, email, phone, password, role, companyId } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({
        success: false,
        message: "Name, email, password, and role are required",
      });
    }

    // Validate role
    const validRoles = ["super_admin", "company_admin", "staff"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ success: false, message: "Invalid role" });
    }

    // Check existing user
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res
        .status(400)
        .json({ success: false, message: "Email already registered" });
    }

    // Validate companyId for non-super-admin
    if (role !== "super_admin" && !companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required for company admin and staff",
      });
    }

    // Validate company exists
    if (companyId) {
      const company = await Company.findById(companyId);
      if (!company) {
        return res
          .status(400)
          .json({ success: false, message: "Company not found" });
      }
    }

    // Encrypt password
    const hashedPassword = encryptPassword(password);

    // Create user
    const user = await User.create({
      name,
      email: email.toLowerCase(),
      phone,
      password: hashedPassword,
      role,
      companyId: companyId || null,
      isActive: true,
    });

    res.status(201).json({
      success: true,
      message: "User created successfully",
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        companyId: user.companyId,
      },
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// @desc    Get all users (Admin only)
// @route   GET /api/auth/users
const getUsers = async (req, res) => {
  try {
    const { companyId } = req.query;

    let query = { isActive: true };
    if (companyId) {
      query.companyId = companyId;
    }

    const users = await User.find(query)
      .populate("companyId", "name code")
      .sort({ createdAt: -1 });

    const decryptedUsers = users.map((user) => {
      const userObj = user.toObject();
      userObj.password = decryptPassword(userObj.password);
      return userObj;
    });

    res.json({ success: true, users: decryptedUsers });
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

module.exports = { login, me, register, getUsers };