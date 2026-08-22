const express = require("express");
const router = express.Router();
const {
  getSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
} = require("../controllers/supplierController");

router.route("/").get(getSuppliers).post(createSupplier);
router.route("/:id").put(updateSupplier).delete(deleteSupplier);

module.exports = router;
