const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
router.param("id", validateObjectIdParam);
const {
  getSchemes,
  createScheme,
  updateScheme,
  deleteScheme,
} = require("../controllers/schemeController");

router.route("/").get(getSchemes).post(createScheme);
router.route("/:id").put(updateScheme).delete(deleteScheme);

module.exports = router;
