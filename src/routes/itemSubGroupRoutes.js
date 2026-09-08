const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
router.param("id", validateObjectIdParam);
const {
  getItemSubGroups,
  createItemSubGroup,
  updateItemSubGroup,
  deleteItemSubGroup,
} = require("../controllers/itemSubGroupController");

router.get("/", getItemSubGroups);
router.post("/", createItemSubGroup);
router.put("/:id", updateItemSubGroup);
router.delete("/:id", deleteItemSubGroup);

module.exports = router;
