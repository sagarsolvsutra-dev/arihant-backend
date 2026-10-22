const express = require("express");
const router = express.Router();
const { getExpenses, exportExpenseStatement, getExpenseById, createExpense, updateExpense, deleteExpense } = require("../controllers/expenseController");

router.get("/", getExpenses);
// STATIC BEFORE DYNAMIC: /export must be registered before /:id, otherwise
// Express matches the literal string "export" as an :id value and the request
// falls into getExpenseById instead. Same rule the Return controllers'
// /lookup-invoice routes already follow.
router.get("/export", exportExpenseStatement);
router.get("/:id", getExpenseById);
router.post("/", createExpense);
router.put("/:id", updateExpense);
router.delete("/:id", deleteExpense);

module.exports = router;
