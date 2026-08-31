const Supplier = require("../models/Supplier");
const { sendError } = require("../utils/errorHandler");

const getSuppliers = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, search = "" } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const query = { companyId };
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { city: { $regex: search, $options: "i" } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const parsedLimit = parseInt(limit);

    const [suppliers, total] = await Promise.all([
      Supplier.find(query)
        .populate("supplierGroupId", "name")
        .sort({ createdAt: -1 }).lean()
        .skip(skip)
        .limit(parsedLimit).lean(),
      Supplier.countDocuments(query)
    ]);

    res.status(200).json({
      data: suppliers,
      pagination: {
        total,
        page: parseInt(page),
        limit: parsedLimit,
        totalPages: Math.ceil(total / parsedLimit)
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const getSupplierById = async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id).populate("supplierGroupId", "name");
    if (!supplier) {
      return res.status(404).json({ message: "Supplier not found" });
    }
    res.status(200).json(supplier);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const createSupplier = async (req, res) => {
  try {
    const {
      companyId, name, alias, phone, phone2, mobile, contactPerson, email, address, city, state, pincode,
      gstNo, panNo, supplierGroupId, balanceMethod, creditDays, isActive,
    } = req.body;

    if (!companyId || !name) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const supplierExists = await Supplier.findOne({ companyId, name });
    if (supplierExists) {
      return res.status(400).json({ message: "Supplier already exists in this company" });
    }

    const supplier = await Supplier.create({
      companyId,
      name: name.trim(),
      alias: alias?.trim() || "",
      phone: phone?.trim() || "",
      phone2: phone2?.trim() || "",
      mobile: mobile?.trim() || "",
      contactPerson: contactPerson?.trim() || "",
      email: email?.trim() || "",
      address: address?.trim() || "",
      city: city?.trim() || "",
      state: state?.trim() || "",
      pincode: pincode?.trim() || "",
      gstNo: gstNo?.trim() || "",
      panNo: panNo?.trim() || "",
      supplierGroupId,
      balanceMethod: balanceMethod || "Bill by bill",
      creditDays: creditDays !== undefined ? Number(creditDays) : 0,
      isActive: isActive !== undefined ? isActive : true,
    });

    res.status(201).json(supplier);
  } catch (error) {
    sendError(res, error);
  }
};

const updateSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) {
      return res.status(404).json({ message: "Supplier not found" });
    }

    const {
      name, alias, phone, phone2, mobile, contactPerson, email, address, city, state, pincode,
      gstNo, panNo, supplierGroupId, balanceMethod, creditDays, isActive,
    } = req.body;

    if (name) {
      const exists = await Supplier.findOne({ companyId: supplier.companyId, name, _id: { $ne: req.params.id } });
      if (exists) {
        return res.status(400).json({ message: "Another Supplier already exists with this name" });
      }
      supplier.name = name.trim();
    }

    if (alias !== undefined) supplier.alias = alias.trim() || "";
    if (phone !== undefined) supplier.phone = phone.trim() || "";
    if (phone2 !== undefined) supplier.phone2 = phone2.trim() || "";
    if (mobile !== undefined) supplier.mobile = mobile.trim() || "";
    if (contactPerson !== undefined) supplier.contactPerson = contactPerson.trim() || "";
    if (email !== undefined) supplier.email = email.trim() || "";
    if (address !== undefined) supplier.address = address.trim() || "";
    if (city !== undefined) supplier.city = city.trim() || "";
    if (state !== undefined) supplier.state = state.trim() || "";
    if (pincode !== undefined) supplier.pincode = pincode.trim() || "";
    if (gstNo !== undefined) supplier.gstNo = gstNo.trim() || "";
    if (panNo !== undefined) supplier.panNo = panNo.trim() || "";
    if (supplierGroupId !== undefined) supplier.supplierGroupId = supplierGroupId;
    if (balanceMethod !== undefined) supplier.balanceMethod = balanceMethod;
    if (creditDays !== undefined) supplier.creditDays = Number(creditDays);
    if (isActive !== undefined) supplier.isActive = isActive;

    await supplier.save();
    res.status(200).json(supplier);
  } catch (error) {
    sendError(res, error);
  }
};

const deleteSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) {
      return res.status(404).json({ message: "Supplier not found" });
    }
    await supplier.deleteOne();
    res.status(200).json({ message: "Supplier deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getSuppliers,
  getSupplierById,
  createSupplier,
  updateSupplier,
  deleteSupplier,
};
