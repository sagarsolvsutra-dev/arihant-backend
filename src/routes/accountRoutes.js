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
  exportAccountStatement,
} = require("../controllers/accountController");

router.route("/").get(getAccounts).post(createAccount);
router.route("/:id").get(getAccountById).put(updateAccount).delete(deleteAccount);
// The more specific /statement/export must come before /statement so Express
// can't match the shorter path first. Both keep this file's
// router.param("id", validateObjectIdParam) — :id is a real ObjectId on both.
router.get("/:id/statement/export", exportAccountStatement);
router.get("/:id/statement", getAccountStatement);

module.exports = router;
