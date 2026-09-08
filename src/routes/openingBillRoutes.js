const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
router.param("id", validateObjectIdParam);
const {
  getOpeningBills,
  createOpeningBill,
  updateOpeningBill,
  deleteOpeningBill,
} = require("../controllers/openingBillController");

router.route("/").get(getOpeningBills).post(createOpeningBill);
router.route("/:id").put(updateOpeningBill).delete(deleteOpeningBill);

module.exports = router;
