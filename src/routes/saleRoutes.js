const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
router.param("id", validateObjectIdParam);
const {
  getSales,
  getSaleById,
  createSale,
  updateSale,
  deleteSale,
} = require("../controllers/saleController");

router.route("/").get(getSales).post(createSale);
router.route("/:id").get(getSaleById).put(updateSale).delete(deleteSale);

module.exports = router;
