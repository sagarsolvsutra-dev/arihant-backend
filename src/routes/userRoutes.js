const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
const { requireRole } = require("../middlewares/auth");
router.param("id", validateObjectIdParam);
const { getUsers, deleteUser, createStaff, updateUser } = require("../controllers/userController");

// Listing/deactivating accounts: super_admin sees everyone (existing
// behavior, unchanged); company_admin is also allowed now, but
// userController.getUsers/deleteUser hard-scope company_admin to only their
// own company's `staff` rows — never trusting the client for that boundary.
router.get("/", requireRole("super_admin", "company_admin"), getUsers);
router.delete("/:id", requireRole("super_admin", "company_admin"), deleteUser);

// Staff creation/editing is a company_admin-only action (managing their own
// company's staff) — super_admin still creates company_admin/staff accounts
// through the separate, existing POST /api/auth/register flow instead.
router.post("/", requireRole("company_admin"), createStaff);
router.put("/:id", requireRole("company_admin"), updateUser);

module.exports = router;
