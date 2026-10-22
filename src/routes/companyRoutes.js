const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
const { requireRole } = require("../middlewares/auth");
router.param("id", validateObjectIdParam);
const {
  getCompanyById,
  getCompanies,
  createCompany,
  updateCompany,
  deleteCompany,
  updateMyCompany,
} = require("../controllers/companyController");

// GET all companies (with admin counts) — every logged-in role reads this
// (CompanyContext uses it to resolve the caller's own company), not just
// super_admin.
router.get("/", getCompanies);

// Self-service letterhead update for the caller's OWN company (Settings
// page). MUST stay above "/:id" — Express would otherwise match "my-company"
// as an :id value, and validateObjectIdParam would 400 it before this ever
// ran. Same static-before-dynamic ordering rule as /lookup-invoice on the
// Return routes.
router.put("/my-company", requireRole("company_admin", "super_admin"), updateMyCompany);

// GET single company by ID
router.get("/:id", getCompanyById);

// Creating/editing/deleting a company is a super_admin-only action.
router.post("/", requireRole("super_admin"), createCompany);
router.put("/:id", requireRole("super_admin"), updateCompany);
router.delete("/:id", requireRole("super_admin"), deleteCompany);

module.exports = router;