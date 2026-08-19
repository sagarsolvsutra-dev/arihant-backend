const express = require("express");
const router = express.Router();
const {
  getCustomerGroups,
  createCustomerGroup,
  updateCustomerGroup,
  deleteCustomerGroup,
} = require("../controllers/customerGroupController");

router.route("/").get(getCustomerGroups).post(createCustomerGroup);
router.route("/:id").put(updateCustomerGroup).delete(deleteCustomerGroup);

module.exports = router;
