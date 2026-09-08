const Customer = require("../models/Customer");
const { sendError } = require("../utils/errorHandler");
const { searchRegex, clampLimit, clampPage } = require("../utils/queryHelpers");

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

    res.status(200).json({
      data: customers,
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

const getCustomerById = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id).populate("customerGroupId", "name");
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
      gstNo, panNo, uniqueIdNo, drugLicNo, customerType, balanceMethod, salesmanId, customerGroupId, routeNo, zoneNo, creditLimit, creditDays, isActive,
    } = req.body;

    if (!companyId || !name) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

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
    const customer = await Customer.findById(req.params.id);
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    const {
      name, alias, contactPerson, mobile, phone, email, address, city, state, pincode,
      gstNo, panNo, uniqueIdNo, drugLicNo, customerType, balanceMethod, salesmanId, customerGroupId, routeNo, zoneNo, creditLimit, creditDays, isActive,
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
    if (uniqueIdNo !== undefined) customer.uniqueIdNo = uniqueIdNo.trim() || "";
    if (drugLicNo !== undefined) customer.drugLicNo = drugLicNo.trim() || "";
    if (customerType !== undefined) customer.customerType = customerType.trim() || "";
    if (balanceMethod !== undefined) customer.balanceMethod = balanceMethod.trim() || "";
    if (salesmanId !== undefined) customer.salesmanId = salesmanId || null;
    if (customerGroupId !== undefined) customer.customerGroupId = customerGroupId;
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
    const customer = await Customer.findById(req.params.id);
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
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
  createCustomer,
  updateCustomer,
  deleteCustomer,
};
