const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
router.param("id", validateObjectIdParam);

const {
  createPayment,
  getPayments,
  exportPaymentStatement,
  getPaymentById,
  updatePayment,
  deletePayment,
  getPendingInvoices
} = require("../controllers/paymentController");


router.get("/pending/:partyType/:partyId", getPendingInvoices);
router.post("/", createPayment);
router.get("/", getPayments);
// STATIC BEFORE DYNAMIC: /export must be registered before /:id, otherwise
// Express matches "export" as an :id value — and this file's
// router.param("id", validateObjectIdParam) would then reject it as a
// malformed ObjectId with a 400 before the handler ever ran. Same rule the
// Return controllers' /lookup-invoice routes already follow.
router.get("/export", exportPaymentStatement);
router.get("/:id", getPaymentById);
router.put("/:id", updatePayment);
router.delete("/:id", deletePayment);

module.exports = router;
