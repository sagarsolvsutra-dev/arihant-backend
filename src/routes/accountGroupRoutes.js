const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
router.param("id", validateObjectIdParam);
const {
  getAccountGroups,
  createAccountGroup,
  updateAccountGroup,
  deleteAccountGroup,
} = require("../controllers/accountGroupController");

router.route("/").get(getAccountGroups).post(createAccountGroup);
router.route("/:id").put(updateAccountGroup).delete(deleteAccountGroup);

module.exports = router;
