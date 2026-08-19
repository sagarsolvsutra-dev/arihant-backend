const express = require("express");
const router = express.Router();
const {
  getItemGroups,
  createItemGroup,
  updateItemGroup,
  deleteItemGroup,
} = require("../controllers/itemGroupController");

router.route("/").get(getItemGroups).post(createItemGroup);
router.route("/:id").put(updateItemGroup).delete(deleteItemGroup);

module.exports = router;
