const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
router.param("id", validateObjectIdParam);
const {
  getGodownGroups,
  createGodownGroup,
  updateGodownGroup,
  deleteGodownGroup,
} = require("../controllers/godownGroupController");

router.route("/").get(getGodownGroups).post(createGodownGroup);
router.route("/:id").put(updateGodownGroup).delete(deleteGodownGroup);

module.exports = router;
