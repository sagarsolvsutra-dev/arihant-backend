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
  getSaleInvoice,
} = require("../controllers/saleController");

// Printable GST tax-invoice PDF for a single record.
router.get("/:id/invoice", getSaleInvoice);

router.route("/").get(getSales).post(createSale);
router.route("/:id").get(getSaleById).put(updateSale).delete(deleteSale);

module.exports = router;
