const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
router.param("id", validateObjectIdParam);
const {
  getStockTransfers,
  getStockTransferById,
  createStockTransfer,
  updateStockTransfer,
  deleteStockTransfer,
} = require("../controllers/stockTransferController");

router.route("/").get(getStockTransfers).post(createStockTransfer);
router.route("/:id").get(getStockTransferById).put(updateStockTransfer).delete(deleteStockTransfer);

module.exports = router;
