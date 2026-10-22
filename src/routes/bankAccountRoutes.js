const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
router.param("id", validateObjectIdParam);

const {
  createBankAccount,
  getBankAccounts,
  updateBankAccount,
  deleteBankAccount,
  getBankAccountStatement,
  exportBankAccountStatement,
  transferFunds
} = require("../controllers/bankAccountController");

router.post("/", createBankAccount);
router.post("/transfer", transferFunds);
router.get("/", getBankAccounts);
// The more specific /statement/export must be registered before /statement so
// Express can't match the shorter path first. Both still go through this
// file's router.param("id", validateObjectIdParam), which is correct — :id is
// a real ObjectId on both.
router.get("/:id/statement/export", exportBankAccountStatement);
router.get("/:id/statement", getBankAccountStatement);
router.put("/:id", updateBankAccount);
router.delete("/:id", deleteBankAccount);

module.exports = router;
