const express = require("express");
const router = express.Router();
const { protect, requireRole } = require("../middlewares/auth");
const { createRateLimiter } = require("../middlewares/rateLimit");
const {
  login,
  me,
  register,
  getUsers,
  logout,
  forgotPassword,
  resetPassword,
  updateProfile,
  updatePassword,
} = require("../controllers/authController");

// login/logout stay public — there's no token yet to check at login, and
// logout is a stateless no-op either way. Login itself had no rate limit at
// all (found in the same audit pass that added the forgot/reset-password
// limiters below) — an attacker could script unlimited password guesses
// against any known email, throttled only by bcrypt's own per-call cost.
// Threshold is looser than forgot/reset-password's (legitimate concurrent
// logins from behind one shared NAT/proxy IP are far more common than
// legitimate concurrent password resets).
router.post(
  "/login",
  createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20, message: "Too many login attempts — please try again in a few minutes" }),
  login
);
router.post("/logout", logout);
router.get("/me", protect, me);

// Public like login, for the same reason: somebody who cannot sign in is exactly
// who needs these. Rate-limited by IP — found via security audit that neither
// had any throttle at all: forgot-password could be used to email-bomb any
// address (each call sends a real OTP mail) and, combined with its own
// deliberate distinct-404-for-unregistered-email response, to enumerate which
// emails have accounts; reset-password's per-OTP 5-attempt counter (see
// authController.resetPassword) only limits guesses against one already-issued
// code, not how fast an attacker can request fresh ones to begin with.
router.post(
  "/forgot-password",
  createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5, message: "Too many reset requests — please try again in a few minutes" }),
  forgotPassword
);
router.post(
  "/reset-password",
  createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, message: "Too many attempts — please try again in a few minutes" }),
  resetPassword
);

// Your own account. Narrow on purpose — see updateProfile in the controller.
router.put("/profile", protect, updateProfile);
router.put("/password", protect, updatePassword);

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