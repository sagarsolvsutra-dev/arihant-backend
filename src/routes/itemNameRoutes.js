const express = require("express");
const router = express.Router();
const itemNameController = require("../controllers/itemNameController");

router.post("/", itemNameController.createItemName);
router.get("/company/:companyId", itemNameController.getItemNames);
router.put("/:id", itemNameController.updateItemName);
router.delete("/:id", itemNameController.deleteItemName);

module.exports = router;
