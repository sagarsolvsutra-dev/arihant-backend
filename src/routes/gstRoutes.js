const express = require("express");
const router = express.Router();
const { lookupGstin } = require("../controllers/gstController");

router.get("/lookup/:gstin", lookupGstin);

module.exports = router;
