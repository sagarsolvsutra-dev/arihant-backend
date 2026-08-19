const express = require("express");
const router = express.Router();
const {
  getHsnCodes,
  createHsnCode,
  updateHsnCode,
  deleteHsnCode,
} = require("../controllers/hsnController");

router.route("/").get(getHsnCodes).post(createHsnCode);
router.route("/:id").put(updateHsnCode).delete(deleteHsnCode);

module.exports = router;
