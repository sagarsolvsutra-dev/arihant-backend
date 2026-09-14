const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Company = require("../models/Company");
const { hashPassword, comparePassword } = require("../utils/crypto");
const { sanitizePermissions } = require("../utils/permissions");

const JWT_SECRET = process.env.JWT_SECRET || "arihant-erp-secret-key-2024";

// Generate JWT Token
// user.companyId may be a plain ObjectId OR a populated Company subdocument
// (login() populates it for the response) — .toString() on a populated
// Mongoose document returns its debug-inspect output ("{ _id: ..., name:
// ... }"), not the id, so this must unwrap ._id first when populated. This
// was a real, previously-dormant bug: nothing ever read the JWT's companyId
// field before real route auth existed, so a garbled value here was invisible
// until scopeCompany started relying on it.
const generateToken = (user) => {
  const companyIdValue = user.companyId
    ? (user.companyId._id || user.companyId).toString()
    : null;
  return jwt.sign(
    {
      userId: user._id.toString(),
      email: user.email,
      role: user.role,
      companyId: companyIdValue,
      // Only meaningful for role:"staff" — see utils/permissions.js.
      permissions: user.role === "staff" ? user.permissions || {} : {},
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

    // Passwords are always bcrypt hashes now (migrated from the old reversible
    // AES storage — see scripts/migrate-passwords-to-bcrypt.js).
    const isMatch = await comparePassword(password, user.password);

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
        permissions: user.role === "staff" ? user.permissions || {} : {},
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
    // req.user is set by the protect() middleware, which already verified the
    // token — re-fetch the live User row here for fresh name/role/isActive
    // (the JWT payload itself is a point-in-time snapshot from login).
    const user = await User.findById(req.user.userId).populate(
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
        permissions: user.role === "staff" ? user.permissions || {} : {},
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
    const { name, email, phone, password, role, companyId, permissions } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({
        success: false,
        message: "Name, email, password, and role are required",
      });
    }

    // This endpoint has no caller-identity check (see the project-wide no-auth
    // issue), so it must never be allowed to mint a super_admin — that would be a
    // one-request privilege escalation for anyone who can reach the API at all.
    // super_admin accounts are only ever created by the initial server.js seed.
    const validRoles = ["company_admin", "staff"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ success: false, message: "Invalid role" });
    }

    // Check existing user — an ACTIVE match is a genuine duplicate (unchanged
    // behavior); an INACTIVE match is reactivated below instead of being
    // rejected or duplicated, mirroring companyController.updateCompany's own
    // admin-reactivation logic (see its "Reactivate rather than duplicate"
    // comment) — without this, an email could never be reused for a new
    // company_admin/staff account once its previous row was soft-deactivated.
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing && existing.isActive) {
      return res
        .status(400)
        .json({ success: false, message: "Email already registered" });
    }

    // companyId is required for both allowed roles now that super_admin can't
    // self-register through this endpoint.
    if (!companyId) {
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

    const hashedPassword = await hashPassword(password);

    // permissions only means anything for role:"staff" (see utils/
    // permissions.js — company_admin/super_admin are never checked against
    // it) and is always run through sanitizePermissions before being
    // persisted, same as userController.createStaff's own staff-creation
    // path — never trust a client-submitted permissions object as-is.
    const sanitizedPermissions = role === "staff" ? sanitizePermissions(permissions) : {};

    let user;
    if (existing) {
      // Reactivate the existing inactive row instead of creating a duplicate.
      existing.name = name;
      existing.phone = phone;
      existing.password = hashedPassword;
      existing.role = role;
      existing.companyId = companyId || null;
      existing.isActive = true;
      existing.permissions = sanitizedPermissions;
      user = await existing.save();
    } else {
      user = await User.create({
        name,
        email: email.toLowerCase(),
        phone,
        password: hashedPassword,
        role,
        companyId: companyId || null,
        isActive: true,
        permissions: sanitizedPermissions,
      });
    }

    res.status(201).json({
      success: true,
      message: "User created successfully",
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        companyId: user.companyId,
        permissions: user.permissions,
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

    // Passwords are one-way bcrypt hashes now — never returned, not even
    // hashed (see the migration in scripts/migrate-passwords-to-bcrypt.js).
    // This closes the plaintext-password leak this endpoint used to have.
    const users = await User.find(query)
      .select("-password")
      .populate("companyId", "name code")
      .sort({ createdAt: -1 }).lean();

    res.json({ success: true, users });
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// @desc    Logout — JWTs are stateless here (no server-side session/blacklist),
//          so this is a no-op that exists only so the frontend's best-effort
//          logout call gets a real 200 instead of a 404 on every logout.
// @route   POST /api/auth/logout
const logout = async (req, res) => {
  res.status(200).json({ success: true, message: "Logged out" });
};

module.exports = { login, me, register, getUsers, logout };