const express = require("express");
const router = express.Router();
const {
  getItemReport,
  getCustomerReport,
  getSupplierReport,
  getPurchaseReport,
  getSaleReport,
  getPurchaseReturnReport,
  getSaleReturnReport,
  getCustomerLedger,
  getSupplierLedger,
  exportItemReport,
  exportCustomerReport,
  exportSupplierReport,
  exportPurchaseReport,
  exportSaleReport,
  exportPurchaseReturnReport,
  exportSaleReturnReport,
  exportCustomerLedger,
  exportSupplierLedger,
} = require("../controllers/reportController");
const { validateObjectIdParam } = require("../middlewares/validateObjectId");

// Export routes registered before their JSON siblings' shared path prefix so
// "/items/export" never gets swallowed by a param route — there isn't one
// here, but this ordering matches the established convention elsewhere in
// this codebase (see purchaseReturnRoutes.js's /lookup-invoice).
router.get("/items/export", exportItemReport);
router.get("/items", getItemReport);
router.get("/customers/export", exportCustomerReport);
router.get("/customers", getCustomerReport);
router.get("/suppliers/export", exportSupplierReport);
router.get("/suppliers", getSupplierReport);
router.get("/purchases/export", exportPurchaseReport);
router.get("/purchases", getPurchaseReport);
router.get("/sales/export", exportSaleReport);
router.get("/sales", getSaleReport);
router.get("/purchase-returns/export", exportPurchaseReturnReport);
router.get("/purchase-returns", getPurchaseReturnReport);
router.get("/sale-returns/export", exportSaleReturnReport);
router.get("/sale-returns", getSaleReturnReport);

router.param("customerId", validateObjectIdParam);
router.param("supplierId", validateObjectIdParam);
router.get("/customer-ledger/:customerId/export", exportCustomerLedger);
router.get("/customer-ledger/:customerId", getCustomerLedger);
router.get("/supplier-ledger/:supplierId/export", exportSupplierLedger);
router.get("/supplier-ledger/:supplierId", getSupplierLedger);

module.exports = router;
