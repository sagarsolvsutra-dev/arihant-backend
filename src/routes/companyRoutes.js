const express = require("express");
const router = express.Router();
const { validateObjectIdParam } = require("../middlewares/validateObjectId");
router.param("id", validateObjectIdParam);
const {
  getCompanyById,
  getCompanies,
  createCompany,
  updateCompany,
  deleteCompany,
} = require("../controllers/companyController");

// GET all companies (with admin counts)
router.get("/", getCompanies);

// GET single company by ID
router.get("/:id", getCompanyById);

// POST create new company + first admin
router.post("/", createCompany);

// PUT update company + admin
router.put("/:id", updateCompany);

// DELETE company
router.delete("/:id", deleteCompany);

module.exports = router;