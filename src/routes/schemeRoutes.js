const express = require("express");
const router = express.Router();
const {
  getSchemes,
  createScheme,
  updateScheme,
  deleteScheme,
} = require("../controllers/schemeController");

router.route("/").get(getSchemes).post(createScheme);
router.route("/:id").put(updateScheme).delete(deleteScheme);

module.exports = router;
