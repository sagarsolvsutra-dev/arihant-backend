const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
router.param("id", validateObjectIdParam);
const {
  getSaleReturns,
  getSaleReturnById,
  lookupOriginalInvoice,
  createSaleReturn,
  updateSaleReturn,
  deleteSaleReturn,
  getSaleReturnInvoice,
} = require("../controllers/saleReturnController");

// Static path registered before the /:id param route so "lookup-invoice" isn't
// swallowed as an :id value.
router.get("/lookup-invoice", lookupOriginalInvoice);
// Printable GST tax-invoice PDF for a single record.
router.get("/:id/invoice", getSaleReturnInvoice);

router.route("/").get(getSaleReturns).post(createSaleReturn);
router.route("/:id").get(getSaleReturnById).put(updateSaleReturn).delete(deleteSaleReturn);

module.exports = router;
