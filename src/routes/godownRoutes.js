const express = require("express");
const router = express.Router();
const {
  getGodowns,
  createGodown,
  updateGodown,
  deleteGodown,
} = require("../controllers/godownController");
const { exportGodownTransactions } = require("../controllers/exportController");

router.route("/").get(getGodowns).post(createGodown);
router.get("/:id/export", exportGodownTransactions);
router.route("/:id").put(updateGodown).delete(deleteGodown);

module.exports = router;
