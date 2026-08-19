const express = require("express");
const router = express.Router();
const { deleteUser } = require("../controllers/userController");

// DELETE user (soft delete)
router.delete("/:id", deleteUser);

module.exports = router;