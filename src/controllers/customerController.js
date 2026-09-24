const mongoose = require("mongoose");
const Customer = require("../models/Customer");
const Sale = require("../models/Sale");
const SaleReturn = require("../models/SaleReturn");
const OpeningBill = require("../models/OpeningBill");
const Scheme = require("../models/Scheme");
const CustomerGroup = require("../models/CustomerGroup");
const Salesman = require("../models/Salesman");
const { sendError } = require("../utils/errorHandler");
const { searchRegex, clampLimit, clampPage, assertRefBelongsToCompany } = require("../utils/queryHelpers");

// A customer with `creditDays` unset/0 has no configured due-date policy at
// all, so "overdue" has no meaning for them — never flagged, matching the
// same "empty means no limit" rule the credit-limit check uses. For everyone
// else, a Sale counts against them once it's still unpaid past its own
// `dueDate`, or past `invoiceDate + creditDays` when no explicit due date was
// set on that particular invoice.
async function computeOverdueFlags(companyId, customers) {
  const withDays = customers.filter((c) => (c.creditDays || 0) > 0);
  if (!withDays.length) return new Map();

  const ids = withDays.map((c) => c._id);
  const sales = await Sale.find({
    companyId,
    customerId: { $in: ids },
    pendingAmount: { $gt: 0 },
  })
    .select("customerId invoiceDate dueDate")
    .lean();

  const creditDaysById = new Map(withDays.map((c) => [String(c._id), c.creditDays || 0]));
  const now = new Date();
  const overdue = new Map();
  sales.forEach((s) => {
    const id = String(s.customerId);
    if (overdue.get(id)) return;
    let effectiveDue = s.dueDate ? new Date(s.dueDate) : null;
    if (!effectiveDue) {
      const days = creditDaysById.get(id) || 0;
      effectiveDue = new Date(s.invoiceDate);
      effectiveDue.setDate(effectiveDue.getDate() + days);
    }
    if (effectiveDue < now) overdue.set(id, true);
  });
  return overdue;
}

const getCustomers = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, search = "", customerType = "" } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const query = { companyId };
    if (search) {
      query.$or = [
        { name: searchRegex(search) },
        { phone: searchRegex(search) },
        { email: searchRegex(search) },
        { city: searchRegex(search) }
      ];
    }
    if (customerType) {
      query.customerType = customerType;
    }

    const parsedPage = clampPage(page);
    const parsedLimit = clampLimit(limit);
    const skip = (parsedPage - 1) * parsedLimit;

    const [customers, total] = await Promise.all([
      Customer.find(query)
        .populate("customerGroupId", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit).lean(),
      Customer.countDocuments(query)
    ]);

    const overdueMap = await computeOverdueFlags(companyId, customers);
    const data = customers.map((c) => ({ ...c, isOverdue: overdueMap.get(String(c._id)) || false }));

    res.status(200).json({
      data,
      pagination: {
        total,
        page: parsedPage,
        limit: parsedLimit,
        totalPages: Math.ceil(total / parsedLimit)
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

// GET /api/customers/:id/outstanding?companyId=
// Powers the credit-limit warning on Sale add/edit — total unpaid (pendingAmount)
// across every Sale for this customer, plus their configured limit/days so the
// frontend can decide whether to warn at all (0/unset = no limit configured).
const getCustomerOutstanding = async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId) return res.status(400).json({ message: "companyId is required" });

    const customer = await Customer.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId }).lean();
    if (!customer) return res.status(404).json({ message: "Customer not found" });

    const rows = await Sale.aggregate([
      { $match: { companyId: new mongoose.Types.ObjectId(String(customer.companyId)), customerId: customer._id } },
      { $group: { _id: null, total: { $sum: "$pendingAmount" } } },
    ]);

    res.status(200).json({
      outstanding: rows[0]?.total || 0,
      creditLimit: customer.creditLimit || 0,
      creditDays: customer.creditDays || 0,
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const getCustomerById = async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId }).populate("customerGroupId", "name");
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }
    res.status(200).json(customer);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const createCustomer = async (req, res) => {
  try {
    const {
      companyId, name, alias, contactPerson, mobile, phone, email, address, city, state, pincode,
      gstNo, panNo, fssaiLicenseNumber, fssaiIssueDate, fssaiExpiryDate, uniqueIdNo, drugLicNo, customerType, balanceMethod, salesmanId, customerGroupId, routeNo, zoneNo, creditLimit, creditDays, isActive,
    } = req.body;

    if (!companyId || !name) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    // Cross-tenant reference leak guard — see queryHelpers.assertRefBelongsToCompany.
    await assertRefBelongsToCompany(CustomerGroup, customerGroupId, companyId, "Customer Group");
    await assertRefBelongsToCompany(Salesman, salesmanId, companyId, "Salesman");

    const customerExists = await Customer.findOne({ companyId, name });
    if (customerExists) {
      return res.status(400).json({ message: "Customer already exists in this company" });
    }

    const customer = await Customer.create({
      companyId,
      name: name.trim(),
      alias: alias?.trim() || "",
      contactPerson: contactPerson?.trim() || "",
      mobile: mobile?.trim() || "",
      phone: phone?.trim() || "",
      email: email?.trim() || "",
      address: address?.trim() || "",
      city: city?.trim() || "",
      state: state?.trim() || "",
      pincode: pincode?.trim() || "",
      gstNo: gstNo?.trim() || "",
      panNo: panNo?.trim() || "",
      fssaiLicenseNumber: fssaiLicenseNumber?.trim() || "",
      fssaiIssueDate: fssaiIssueDate || null,
      fssaiExpiryDate: fssaiExpiryDate || null,
      uniqueIdNo: uniqueIdNo?.trim() || "",
      drugLicNo: drugLicNo?.trim() || "",
      customerType: customerType?.trim() || "Retailer",
      balanceMethod: balanceMethod?.trim() || "Bill by bill",
      salesmanId: salesmanId || null,
      customerGroupId,
      routeNo: routeNo?.trim() || "",
      zoneNo: zoneNo?.trim() || "",
      creditLimit: parseFloat(creditLimit) || 0,
      creditDays: parseInt(creditDays) || 0,
      isActive: isActive !== undefined ? isActive : true,
    });

    res.status(201).json(customer);
  } catch (error) {
    sendError(res, error);
  }
};

const updateCustomer = async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    const {
      name, alias, contactPerson, mobile, phone, email, address, city, state, pincode,
      gstNo, panNo, fssaiLicenseNumber, fssaiIssueDate, fssaiExpiryDate, uniqueIdNo, drugLicNo, customerType, balanceMethod, salesmanId, customerGroupId, routeNo, zoneNo, creditLimit, creditDays, isActive,
    } = req.body;

    if (name) {
      const exists = await Customer.findOne({ companyId: customer.companyId, name, _id: { $ne: req.params.id } });
      if (exists) {
        return res.status(400).json({ message: "Another Customer already exists with this name" });
      }
      customer.name = name.trim();
    }

    if (alias !== undefined) customer.alias = alias.trim() || "";
    if (contactPerson !== undefined) customer.contactPerson = contactPerson.trim() || "";
    if (mobile !== undefined) customer.mobile = mobile.trim() || "";
    if (phone !== undefined) customer.phone = phone.trim() || "";
    if (email !== undefined) customer.email = email.trim() || "";
    if (address !== undefined) customer.address = address.trim() || "";
    if (city !== undefined) customer.city = city.trim() || "";
    if (state !== undefined) customer.state = state.trim() || "";
    if (pincode !== undefined) customer.pincode = pincode.trim() || "";
    if (gstNo !== undefined) customer.gstNo = gstNo.trim() || "";
    if (panNo !== undefined) customer.panNo = panNo.trim() || "";
    if (fssaiLicenseNumber !== undefined) customer.fssaiLicenseNumber = fssaiLicenseNumber.trim() || "";
    if (fssaiIssueDate !== undefined) customer.fssaiIssueDate = fssaiIssueDate || null;
    if (fssaiExpiryDate !== undefined) customer.fssaiExpiryDate = fssaiExpiryDate || null;
    if (uniqueIdNo !== undefined) customer.uniqueIdNo = uniqueIdNo.trim() || "";
    if (drugLicNo !== undefined) customer.drugLicNo = drugLicNo.trim() || "";
    if (customerType !== undefined) customer.customerType = customerType.trim() || "";
    if (balanceMethod !== undefined) customer.balanceMethod = balanceMethod.trim() || "";
    if (salesmanId !== undefined) {
      await assertRefBelongsToCompany(Salesman, salesmanId, customer.companyId, "Salesman");
      customer.salesmanId = salesmanId || null;
    }
    if (customerGroupId !== undefined) {
      await assertRefBelongsToCompany(CustomerGroup, customerGroupId, customer.companyId, "Customer Group");
      customer.customerGroupId = customerGroupId;
    }
    if (routeNo !== undefined) customer.routeNo = routeNo.trim() || "";
    if (zoneNo !== undefined) customer.zoneNo = zoneNo.trim() || "";
    if (creditLimit !== undefined) customer.creditLimit = parseFloat(creditLimit) || 0;
    if (creditDays !== undefined) customer.creditDays = parseInt(creditDays) || 0;
    if (isActive !== undefined) customer.isActive = isActive;

    await customer.save();
    res.status(200).json(customer);
  } catch (error) {
    sendError(res, error);
  }
};

const deleteCustomer = async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    // Sale.customerId, SaleReturn.customerId, and OpeningBill.customerId (type=sale)
    // all reference Customer, as does Scheme.customerId. Hard-deleting a still-
    // referenced Customer leaves each of those with a dangling ref.
    const [hasSale, hasSaleReturn, hasOpeningBill, hasScheme] = await Promise.all([
      Sale.exists({ companyId: customer.companyId, customerId: customer._id }),
      SaleReturn.exists({ companyId: customer.companyId, customerId: customer._id }),
      OpeningBill.exists({ companyId: customer.companyId, customerId: customer._id }),
      Scheme.exists({ companyId: customer.companyId, customerId: customer._id }),
    ]);
    if (hasSale || hasSaleReturn || hasOpeningBill || hasScheme) {
      return res.status(400).json({
        message: "Cannot delete this customer — it is still referenced by Sales, Sale Returns, Opening Bills, or Schemes. Deactivate it instead.",
      });
    }

    await customer.deleteOne();
    res.status(200).json({ message: "Customer deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getCustomers,
  getCustomerById,
  getCustomerOutstanding,
  createCustomer,
  updateCustomer,
  deleteCustomer,
};
