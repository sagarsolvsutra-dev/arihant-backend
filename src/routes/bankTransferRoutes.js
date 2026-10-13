const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
router.param("id", validateObjectIdParam);
const { getBankTransfers, getBankTransferById, createBankTransfer, updateBankTransfer, deleteBankTransfer } = require("../controllers/bankTransferController");

router.get("/", getBankTransfers);
router.get("/:id", getBankTransferById);
router.post("/", createBankTransfer);
router.put("/:id", updateBankTransfer);
router.delete("/:id", deleteBankTransfer);

module.exports = router;
