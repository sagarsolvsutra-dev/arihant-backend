const express = require("express");
const router = express.Router();
const {
  getGodownGroups,
  createGodownGroup,
  updateGodownGroup,
  deleteGodownGroup,
} = require("../controllers/godownGroupController");

router.route("/").get(getGodownGroups).post(createGodownGroup);
router.route("/:id").put(updateGodownGroup).delete(deleteGodownGroup);

module.exports = router;
