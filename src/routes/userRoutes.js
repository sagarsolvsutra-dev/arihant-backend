const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
const { requireRole } = require("../middlewares/auth");
router.param("id", validateObjectIdParam);
const { getUsers, deleteUser } = require("../controllers/userController");

// User management (listing/deactivating accounts) is a super_admin-only
// action — the only documented frontend consumer is /super-admin/users.
router.get("/", requireRole("super_admin"), getUsers);
router.delete("/:id", requireRole("super_admin"), deleteUser);

module.exports = router;