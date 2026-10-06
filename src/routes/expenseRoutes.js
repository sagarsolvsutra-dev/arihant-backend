const express = require("express");
const router = express.Router();
const { getExpenses, getExpenseById, createExpense, deleteExpense } = require("../controllers/expenseController");

router.get("/", getExpenses);
router.get("/:id", getExpenseById);
router.post("/", createExpense);
router.delete("/:id", deleteExpense);

module.exports = router;
