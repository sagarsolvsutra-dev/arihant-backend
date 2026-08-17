const express = require("express");
const router = express.Router();
const {
  getProducts,
  createProduct,
  deleteProduct,
} = require("../controllers/productController");

router.route("/").get(getProducts).post(createProduct);
router.route("/:id").delete(deleteProduct);

module.exports = router;
