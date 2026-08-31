const express = require("express");
const router = express.Router();
const {
  getSaleReturns,
  getSaleReturnById,
  lookupOriginalInvoice,
  createSaleReturn,
  updateSaleReturn,
  deleteSaleReturn,
} = require("../controllers/saleReturnController");

// Static path registered before the /:id param route so "lookup-invoice" isn't
// swallowed as an :id value.
router.get("/lookup-invoice", lookupOriginalInvoice);
router.route("/").get(getSaleReturns).post(createSaleReturn);
router.route("/:id").get(getSaleReturnById).put(updateSaleReturn).delete(deleteSaleReturn);

module.exports = router;
