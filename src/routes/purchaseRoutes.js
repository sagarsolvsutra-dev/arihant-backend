const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
router.param("id", validateObjectIdParam);
const {
  getPurchases,
  getPurchaseById,
  createPurchase,
  updatePurchase,
  deletePurchase,
} = require("../controllers/purchaseController");

router.route("/").get(getPurchases).post(createPurchase);
router.route("/:id").get(getPurchaseById).put(updatePurchase).delete(deletePurchase);

module.exports = router;
