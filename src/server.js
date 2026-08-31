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
const Company = require("./models/Company");
const User = require("./models/User");
const { encryptPassword } = require("./utils/crypto");

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
      const hashedPassword = encryptPassword("admin123");
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
app.use("/api/auth", authRoutes);
app.use("/api/hsn", hsnRoutes);
app.use("/api/companies", require("./routes/companyRoutes"));
app.use("/api/users", require("./routes/userRoutes"));
// Master Routes
app.use("/api/item-names", require("./routes/itemNameRoutes"));
app.use("/api/item-sub-groups", require("./routes/itemSubGroupRoutes"));
app.use("/api/customer-groups", require("./routes/customerGroupRoutes"));
app.use("/api/supplier-groups", require("./routes/supplierGroupRoutes"));
app.use("/api/godown-groups", require("./routes/godownGroupRoutes"));
app.use("/api/godowns", require("./routes/godownRoutes"));
app.use("/api/hsn", require("./routes/hsnRoutes"));

// Data Routes
app.use("/api/items", require("./routes/itemRoutes"));
app.use("/api/customers", require("./routes/customerRoutes"));
app.use("/api/suppliers", require("./routes/supplierRoutes"));
app.use("/api/salesmen", require("./routes/salesmanRoutes"));
app.use("/api/schemes", require("./routes/schemeRoutes"));
app.use("/api/opening-bills", require("./routes/openingBillRoutes"));
app.use("/api/purchases", require("./routes/purchaseRoutes"));
app.use("/api/sales", require("./routes/saleRoutes"));
app.use("/api/purchase-returns", require("./routes/purchaseReturnRoutes"));
app.use("/api/sale-returns", require("./routes/saleReturnRoutes"));

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