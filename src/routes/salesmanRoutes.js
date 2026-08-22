const express = require("express");
const router = express.Router();
const {
  getSalesmen,
  createSalesman,
  updateSalesman,
  deleteSalesman,
} = require("../controllers/salesmanController");

router.route("/").get(getSalesmen).post(createSalesman);
router.route("/:id").put(updateSalesman).delete(deleteSalesman);

module.exports = router;
