const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
router.param("id", validateObjectIdParam);
const {
  getSuppliers,
  getSupplierById,
  createSupplier,
  updateSupplier,
  deleteSupplier,
} = require("../controllers/supplierController");

router.route("/").get(getSuppliers).post(createSupplier);
router.route("/:id").get(getSupplierById).put(updateSupplier).delete(deleteSupplier);

module.exports = router;
