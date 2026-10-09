const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
router.param("id", validateObjectIdParam);
const {
  getNarrations,
  createNarration,
  updateNarration,
  deleteNarration,
} = require("../controllers/narrationController");

router.route("/").get(getNarrations).post(createNarration);
router.route("/:id").put(updateNarration).delete(deleteNarration);

module.exports = router;
