const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
router.param("id", validateObjectIdParam);
const {
  getAccounts,
  getAccountById,
  createAccount,
  updateAccount,
  deleteAccount,
  getAccountStatement,
} = require("../controllers/accountController");

router.route("/").get(getAccounts).post(createAccount);
router.route("/:id").get(getAccountById).put(updateAccount).delete(deleteAccount);
router.get("/:id/statement", getAccountStatement);

module.exports = router;
