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
const { protect, scopeCompany } = require("./middlewares/auth");
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
// Master Routes
app.use("/api/item-names", protect, scopeCompany, require("./routes/itemNameRoutes"));
app.use("/api/item-sub-groups", protect, scopeCompany, require("./routes/itemSubGroupRoutes"));
app.use("/api/customer-groups", protect, scopeCompany, require("./routes/customerGroupRoutes"));
app.use("/api/supplier-groups", protect, scopeCompany, require("./routes/supplierGroupRoutes"));
app.use("/api/godown-groups", protect, scopeCompany, require("./routes/godownGroupRoutes"));
app.use("/api/godowns", protect, scopeCompany, require("./routes/godownRoutes"));
app.use("/api/hsn", protect, scopeCompany, hsnRoutes);

// Data Routes
app.use("/api/items", protect, scopeCompany, require("./routes/itemRoutes"));
app.use("/api/customers", protect, scopeCompany, require("./routes/customerRoutes"));
app.use("/api/suppliers", protect, scopeCompany, require("./routes/supplierRoutes"));
app.use("/api/salesmen", protect, scopeCompany, require("./routes/salesmanRoutes"));
app.use("/api/schemes", protect, scopeCompany, require("./routes/schemeRoutes"));
app.use("/api/opening-bills", protect, scopeCompany, require("./routes/openingBillRoutes"));
app.use("/api/purchases", protect, scopeCompany, require("./routes/purchaseRoutes"));
app.use("/api/sales", protect, scopeCompany, require("./routes/saleRoutes"));
app.use("/api/purchase-returns", protect, scopeCompany, require("./routes/purchaseReturnRoutes"));
app.use("/api/sale-returns", protect, scopeCompany, require("./routes/saleReturnRoutes"));
app.use("/api/stock-transfers", protect, scopeCompany, require("./routes/stockTransferRoutes"));
app.use("/api/export-list", protect, scopeCompany, require("./routes/exportListRoutes"));
app.use("/api/reports", protect, scopeCompany, require("./routes/reportRoutes"));

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