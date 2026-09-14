require("dotenv").config();
const express = require("express");
const cors = require("cors");
const dns = require("dns");
const helmet = require("helmet");
const morgan = require("morgan");
dns.setServers(["8.8.8.8", "1.1.1.1"]);
const connectDB = require("./config/db");
const hsnRoutes = require("./routes/hsnRoutes");
const authRoutes = require("./routes/authRoutes");
const { protect, scopeCompany, requirePermission } = require("./middlewares/auth");
const Company = require("./models/Company");
const User = require("./models/User");
const { hashPassword } = require("./utils/crypto");

// Connect to Database
connectDB().then(async () => {
  try {
    // Seed Companies if empty
    const companyCount = await Company.countDocuments();
    if (companyCount === 0) {
      await Company.create([
        { name: "Arihant Enterprise", code: "enterprise" },
        { name: "Arihant Agency", code: "agency" },
      ]);
      console.log("✅ Database seeded: Created initial companies");
    }

    // Seed Super Admin if no super admin exists
    const superAdminCount = await User.countDocuments({ role: "super_admin" });
    if (superAdminCount === 0) {
      const hashedPassword = await hashPassword("admin123");
      await User.create({
        name: "Super Admin",
        email: "superadmin@arihant.com",
        phone: "9999999999",
        password: hashedPassword,
        role: "super_admin",
        companyId: null,
        isActive: true,
      });
      console.log("✅ Database seeded: Created Super Admin");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("📧 Email:    superadmin@arihant.com");
      console.log("🔑 Password: admin123");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    }
  } catch (err) {
    console.error(`❌ Database seeding failed: ${err.message}`);
  }
});

const app = express();

// Middlewares
app.use(helmet());
app.use(cors({
  origin: [
    "http://localhost:3000",
    "http://localhost:3001",
    "https://arihant-frontend-seven.vercel.app",
    "http://localhost:64992",
    process.env.FRONTEND_URL
  ].filter(Boolean),
  credentials: true,
  // The frontend's Excel/PDF exports now fetch()+blob() instead of
  // window.open()'ing the file URL directly (see lib/download.ts) — that
  // requires reading the filename back out of Content-Disposition via
  // `response.headers.get()`, which the browser hides on cross-origin
  // responses unless it's explicitly exposed here.
  exposedHeaders: ["Content-Disposition"],
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
}

// Routes
// authRoutes applies protect()/requireRole() per-route internally (login/
// logout stay public — there's no token yet to check at login).
app.use("/api/auth", authRoutes);

// Every other route requires a valid token; scopeCompany then forces
// company_admin/staff onto their own companyId regardless of what the client
// sent, and passes super_admin's explicit companyId through untouched.
app.use("/api/companies", protect, scopeCompany, require("./routes/companyRoutes"));
app.use("/api/users", protect, scopeCompany, require("./routes/userRoutes"));
// Dashboard — deliberately NOT behind requirePermission: every logged-in
// user (staff included, regardless of what they're granted) always sees
// Dashboard, so this route stays open to anyone with a valid token. Branches
// internally on req.user.role (super_admin gets a system-wide summary,
// everyone else gets their own company's, scoped via req.effectiveCompanyId).
app.use("/api/dashboard", protect, scopeCompany, require("./routes/dashboardRoutes"));

// Master Routes — each master-data resource is its OWN permission module now
// (see utils/permissions.js's history note — this used to be one combined
// "masters" key, split apart on direct request), but every one of them stays
// READ-ONLY (GET stays open regardless of permission; only POST/PUT/DELETE
// are checked) since master data is shared reference info other modules need
// to function even without that specific module's permission (e.g. a staff
// member with only "sale" permission still needs to read the customer list
// to make a sale). See requirePermission's readOnly option.
app.use("/api/item-names", protect, scopeCompany, requirePermission("itemNames", { readOnly: true }), require("./routes/itemNameRoutes"));
app.use("/api/item-sub-groups", protect, scopeCompany, requirePermission("itemSubGroups", { readOnly: true }), require("./routes/itemSubGroupRoutes"));
app.use("/api/customer-groups", protect, scopeCompany, requirePermission("customerGroups", { readOnly: true }), require("./routes/customerGroupRoutes"));
app.use("/api/supplier-groups", protect, scopeCompany, requirePermission("supplierGroups", { readOnly: true }), require("./routes/supplierGroupRoutes"));
app.use("/api/godown-groups", protect, scopeCompany, requirePermission("godownGroups", { readOnly: true }), require("./routes/godownGroupRoutes"));
app.use("/api/godowns", protect, scopeCompany, requirePermission("godowns", { readOnly: true }), require("./routes/godownRoutes"));
app.use("/api/hsn", protect, scopeCompany, requirePermission("hsn", { readOnly: true }), hsnRoutes);

// Data Routes
app.use("/api/items", protect, scopeCompany, requirePermission("items", { readOnly: true }), require("./routes/itemRoutes"));
app.use("/api/customers", protect, scopeCompany, requirePermission("customers", { readOnly: true }), require("./routes/customerRoutes"));
app.use("/api/suppliers", protect, scopeCompany, requirePermission("suppliers", { readOnly: true }), require("./routes/supplierRoutes"));
app.use("/api/salesmen", protect, scopeCompany, requirePermission("salesmen", { readOnly: true }), require("./routes/salesmanRoutes"));
app.use("/api/schemes", protect, scopeCompany, requirePermission("schemes", { readOnly: true }), require("./routes/schemeRoutes"));
app.use("/api/opening-bills", protect, scopeCompany, requirePermission("openingBills", { readOnly: true }), require("./routes/openingBillRoutes"));
// Transactional modules — gated by their own permission, ALL methods
// (including GET/list): unlike master data, a staff member without a given
// module's permission genuinely shouldn't see that module's records at all.
app.use("/api/purchases", protect, scopeCompany, requirePermission("purchase"), require("./routes/purchaseRoutes"));
app.use("/api/sales", protect, scopeCompany, requirePermission("sale"), require("./routes/saleRoutes"));
app.use("/api/purchase-returns", protect, scopeCompany, requirePermission("purchaseReturn"), require("./routes/purchaseReturnRoutes"));
app.use("/api/sale-returns", protect, scopeCompany, requirePermission("saleReturn"), require("./routes/saleReturnRoutes"));
app.use("/api/stock-transfers", protect, scopeCompany, requirePermission("stockTransfer"), require("./routes/stockTransferRoutes"));
app.use("/api/export-list", protect, scopeCompany, require("./routes/exportListRoutes"));
app.use("/api/reports", protect, scopeCompany, requirePermission("reports"), require("./routes/reportRoutes"));

// Health Check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK", message: "Server is healthy" });
});

// Error Handler
app.use((err, req, res, next) => {
  const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
  res.status(statusCode).json({
    message: err.message,
    stack: process.env.NODE_ENV === "production" ? null : err.stack,
  });
});

const PORT = process.env.PORT;

app.listen(PORT, () => {
  console.log(`🚀 Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
});