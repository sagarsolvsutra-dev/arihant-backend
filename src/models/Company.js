const mongoose = require("mongoose");

const CompanySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    code: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    address: {
      type: String,
      default: "",
    },
    phone: {
      type: String,
      default: "",
    },
    email: {
      type: String,
      default: "",
      lowercase: true,
      trim: true,
    },
    gstNo: {
      type: String,
      default: "",
      uppercase: true,
      trim: true,
    },
    panNo: {
      type: String,
      default: "",
      uppercase: true,
      trim: true,
    },
    // --- Tax-invoice letterhead/footer fields -------------------------------
    // Everything the printed GST invoice needs beyond the basics above. All
    // optional and all maintained by the company_admin on the Settings page
    // (PUT /api/companies/my-company), so the invoice is never hardcoded.
    state: {
      type: String,
      default: "",
      trim: true,
    },
    // Second contact number — the reference invoice prints two ("Mobile : X
    // Mobile : Y"); `phone` above is the first.
    mobile2: {
      type: String,
      default: "",
      trim: true,
    },
    // Prints as "Subject to <jurisdiction> Jurisdiction, E.& O.E."
    jurisdiction: {
      type: String,
      default: "",
      trim: true,
    },
    // Prints as "Cheque Return Charges Rs.<n>/-." Omitted entirely when 0.
    chequeReturnCharges: {
      type: Number,
      default: 0,
    },
    // Fallback bank printed on the invoice when the transaction itself has no
    // bankAccountId (e.g. a Cash sale). The transaction's own selected bank
    // always wins — see buildInvoiceModel in utils/invoicePdf.js.
    defaultBankAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BankAccount",
      default: null,
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Company", CompanySchema);