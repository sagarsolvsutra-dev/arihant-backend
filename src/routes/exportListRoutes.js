const express = require("express");
const router = express.Router();
const { exportList } = require("../controllers/exportListController");

// GET /api/export-list/:resource?companyId=&dateFrom=&dateTo=&search=
// Always emits .xlsx — there is no `format` param here (unlike the per-godown
// PDF/Excel export at GET /api/godowns/:id/export, which genuinely supports both).
router.get("/:resource", exportList);

module.exports = router;
