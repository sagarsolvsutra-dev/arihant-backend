const express = require("express");
const router = express.Router();
const { protect, requireRole } = require("../middlewares/auth");
const { login, me, register, getUsers, logout } = require("../controllers/authController");

// login/logout stay public — there's no token yet to check at login, and
// logout is a stateless no-op either way.
router.post("/login", login);
router.post("/logout", logout);
router.get("/me", protect, me);

// Account creation is now a super_admin-only action, not public self-service —
// the only real caller is the /super-admin/users "Add User" dialog. This is on
// top of (not instead of) register()'s own role whitelist (no super_admin via
// this endpoint) — that whitelist still matters as defense in depth.
router.post("/register", protect, requireRole("super_admin"), register);

// This endpoint used to leak plaintext passwords (see authController.getUsers'
// history) — now that passwords are one-way bcrypt hashes it can't leak them
// even if reached, but it's still full user PII, so lock it down too.
router.get("/users", protect, requireRole("super_admin"), getUsers);

module.exports = router;