const Salesman = require("../models/Salesman");
const Customer = require("../models/Customer");
const OpeningBill = require("../models/OpeningBill");
const { sendError } = require("../utils/errorHandler");
const { searchRegex, clampLimit, clampPage } = require("../utils/queryHelpers");

const getSalesmen = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, search = "" } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const query = { companyId };
    if (search) {
      query.$or = [
        { name: searchRegex(search) },
        { phone: searchRegex(search) },
        { email: searchRegex(search) }
      ];
    }

    const parsedPage = clampPage(page);
    const parsedLimit = clampLimit(limit);
    const skip = (parsedPage - 1) * parsedLimit;

    const [salesmen, total] = await Promise.all([
      Salesman.find(query).sort({ createdAt: -1 }).skip(skip).limit(parsedLimit).lean(),
      Salesman.countDocuments(query)
    ]);

    res.status(200).json({
      data: salesmen,
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

const createSalesman = async (req, res) => {
  try {
    const { companyId, name, phone, email, address, commissionRate, isActive } = req.body;
    if (!companyId || !name) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const salesmanExists = await Salesman.findOne({ companyId, name });
    if (salesmanExists) {
      return res.status(400).json({ message: "Salesman already exists in this company" });
    }

    const salesman = await Salesman.create({
      companyId,
      name: name.trim(),
      phone: phone?.trim() || "",
      email: email?.trim() || "",
      address: address?.trim() || "",
      commissionRate: parseFloat(commissionRate) || 0,
      isActive: isActive !== undefined ? isActive : true,
    });

    res.status(201).json(salesman);
  } catch (error) {
    sendError(res, error);
  }
};

const updateSalesman = async (req, res) => {
  try {
    const salesman = await Salesman.findById(req.params.id);
    if (!salesman) {
      return res.status(404).json({ message: "Salesman not found" });
    }

    const { name, phone, email, address, commissionRate, isActive } = req.body;

    if (name) {
      const exists = await Salesman.findOne({ companyId: salesman.companyId, name, _id: { $ne: req.params.id } });
      if (exists) {
        return res.status(400).json({ message: "Another Salesman already exists with this name" });
      }
      salesman.name = name.trim();
    }

    if (phone !== undefined) salesman.phone = phone.trim() || "";
    if (email !== undefined) salesman.email = email.trim() || "";
    if (address !== undefined) salesman.address = address.trim() || "";
    if (commissionRate !== undefined) salesman.commissionRate = parseFloat(commissionRate) || 0;
    if (isActive !== undefined) salesman.isActive = isActive;

    await salesman.save();
    res.status(200).json(salesman);
  } catch (error) {
    sendError(res, error);
  }
};

const deleteSalesman = async (req, res) => {
  try {
    const salesman = await Salesman.findById(req.params.id);
    if (!salesman) {
      return res.status(404).json({ message: "Salesman not found" });
    }

    const [hasCustomer, hasOpeningBill] = await Promise.all([
      Customer.exists({ companyId: salesman.companyId, salesmanId: salesman._id }),
      OpeningBill.exists({ companyId: salesman.companyId, salesmanId: salesman._id }),
    ]);
    if (hasCustomer || hasOpeningBill) {
      return res.status(400).json({
        message: "Cannot delete this salesman — still referenced by Customers or Opening Bills. Deactivate it instead.",
      });
    }

    await salesman.deleteOne();
    res.status(200).json({ message: "Salesman deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getSalesmen,
  createSalesman,
  updateSalesman,
  deleteSalesman,
};
