const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
router.param("id", validateObjectIdParam);
const {
  getCustomerGroups,
  createCustomerGroup,
  updateCustomerGroup,
  deleteCustomerGroup,
} = require("../controllers/customerGroupController");

router.route("/").get(getCustomerGroups).post(createCustomerGroup);
router.route("/:id").put(updateCustomerGroup).delete(deleteCustomerGroup);

module.exports = router;
