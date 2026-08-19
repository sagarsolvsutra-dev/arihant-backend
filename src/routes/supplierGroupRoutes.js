const express = require("express");
const router = express.Router();
const {
  getSupplierGroups,
  createSupplierGroup,
  updateSupplierGroup,
  deleteSupplierGroup,
} = require("../controllers/supplierGroupController");

router.route("/").get(getSupplierGroups).post(createSupplierGroup);
router.route("/:id").put(updateSupplierGroup).delete(deleteSupplierGroup);

module.exports = router;
