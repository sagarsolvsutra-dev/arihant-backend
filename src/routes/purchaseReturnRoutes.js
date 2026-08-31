const express = require("express");
const router = express.Router();
const {
  getPurchaseReturns,
  getPurchaseReturnById,
  lookupOriginalInvoice,
  createPurchaseReturn,
  updatePurchaseReturn,
  deletePurchaseReturn,
} = require("../controllers/purchaseReturnController");

// Static path registered before the /:id param route so "lookup-invoice" isn't
// swallowed as an :id value.
router.get("/lookup-invoice", lookupOriginalInvoice);
router.route("/").get(getPurchaseReturns).post(createPurchaseReturn);
router.route("/:id").get(getPurchaseReturnById).put(updatePurchaseReturn).delete(deletePurchaseReturn);

module.exports = router;
