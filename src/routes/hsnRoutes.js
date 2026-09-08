const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
router.param("id", validateObjectIdParam);
const {
  getHsnCodes,
  createHsnCode,
  updateHsnCode,
  deleteHsnCode,
} = require("../controllers/hsnController");

router.route("/").get(getHsnCodes).post(createHsnCode);
router.route("/:id").put(updateHsnCode).delete(deleteHsnCode);

module.exports = router;
