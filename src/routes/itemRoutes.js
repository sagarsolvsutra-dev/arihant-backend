const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
router.param("id", validateObjectIdParam);
const {
  getItems,
  getItemById,
  createItem,
  updateItem,
  deleteItem,
} = require("../controllers/itemController");

router.route("/").get(getItems).post(createItem);
router.route("/:id").get(getItemById).put(updateItem).delete(deleteItem);

module.exports = router;
