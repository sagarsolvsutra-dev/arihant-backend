const express = require("express");
const router = express.Router();

const {
  createBankAccount,
  getBankAccounts,
  updateBankAccount,
  deleteBankAccount,
  getBankAccountStatement,
  transferFunds
} = require("../controllers/bankAccountController");

router.post("/", createBankAccount);
router.post("/transfer", transferFunds);
router.get("/", getBankAccounts);
router.get("/:id/statement", getBankAccountStatement);
router.put("/:id", updateBankAccount);
router.delete("/:id", deleteBankAccount);

module.exports = router;
