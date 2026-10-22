const Supplier = require("../models/Supplier");
const Item = require("../models/Item");
const ItemName = require("../models/ItemName");
const ItemSubGroup = require("../models/ItemSubGroup");
const PurchaseReturn = require("../models/PurchaseReturn");
const SupplierGroup = require("../models/SupplierGroup");
const OpeningBill = require("../models/OpeningBill");
const Payment = require("../models/Payment");
const { sendError } = require("../utils/errorHandler");
const { searchRegex, clampLimit, clampPage, assertRefBelongsToCompany } = require("../utils/queryHelpers");

const getSuppliers = async (req, res) => {
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
        { email: searchRegex(search) },
        { city: searchRegex(search) }
      ];
    }

    const parsedPage = clampPage(page);
    const parsedLimit = clampLimit(limit);
    const skip = (parsedPage - 1) * parsedLimit;

    const [suppliers, total] = await Promise.all([
      Supplier.find(query)
        .populate("supplierGroupId", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit).lean(),
      Supplier.countDocuments(query)
    ]);

    res.status(200).json({
      data: suppliers,
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

const getSupplierById = async (req, res) => {
  try {
    const supplier = await Supplier.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId }).populate("supplierGroupId", "name");
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
      shippingAddress, shippingCity, shippingState, shippingPincode,
      gstNo, panNo, fssaiLicenseNumber, fssaiIssueDate, fssaiExpiryDate, supplierGroupId, balanceMethod, creditDays, isActive,
    } = req.body;

    if (!companyId || !name) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }
    if (creditDays !== undefined && parseInt(creditDays) < 0) {
      return res.status(400).json({ message: "Credit Days cannot be negative" });
    }

    // Cross-tenant reference leak guard — see queryHelpers.assertRefBelongsToCompany.
    await assertRefBelongsToCompany(SupplierGroup, supplierGroupId, companyId, "Supplier Group");

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
      // Ship To (delivery) address — optional; blank means "same as billing"
      // and the invoice then prints a single address block.
      shippingAddress: shippingAddress?.trim() || "",
      shippingCity: shippingCity?.trim() || "",
      shippingState: shippingState?.trim() || "",
      shippingPincode: shippingPincode?.trim() || "",
      gstNo: gstNo?.trim() || "",
      panNo: panNo?.trim() || "",
      fssaiLicenseNumber: fssaiLicenseNumber?.trim() || "",
      fssaiIssueDate: fssaiIssueDate || null,
      fssaiExpiryDate: fssaiExpiryDate || null,
      supplierGroupId,
      balanceMethod: balanceMethod || "Bill by bill",
      creditDays: parseInt(creditDays) || 0,
      isActive: isActive !== undefined ? isActive : true,
    });

    res.status(201).json(supplier);
  } catch (error) {
    sendError(res, error);
  }
};

const updateSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!supplier) {
      return res.status(404).json({ message: "Supplier not found" });
    }

    const {
      name, alias, phone, phone2, mobile, contactPerson, email, address, city, state, pincode,
      shippingAddress, shippingCity, shippingState, shippingPincode,
      gstNo, panNo, fssaiLicenseNumber, fssaiIssueDate, fssaiExpiryDate, supplierGroupId, balanceMethod, creditDays, isActive,
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
    if (shippingAddress !== undefined) supplier.shippingAddress = shippingAddress.trim() || "";
    if (shippingCity !== undefined) supplier.shippingCity = shippingCity.trim() || "";
    if (shippingState !== undefined) supplier.shippingState = shippingState.trim() || "";
    if (shippingPincode !== undefined) supplier.shippingPincode = shippingPincode.trim() || "";
    if (gstNo !== undefined) supplier.gstNo = gstNo.trim() || "";
    if (panNo !== undefined) supplier.panNo = panNo.trim() || "";
    if (fssaiLicenseNumber !== undefined) supplier.fssaiLicenseNumber = fssaiLicenseNumber.trim() || "";
    if (fssaiIssueDate !== undefined) supplier.fssaiIssueDate = fssaiIssueDate || null;
    if (fssaiExpiryDate !== undefined) supplier.fssaiExpiryDate = fssaiExpiryDate || null;
    if (supplierGroupId !== undefined) {
      await assertRefBelongsToCompany(SupplierGroup, supplierGroupId, supplier.companyId, "Supplier Group");
      supplier.supplierGroupId = supplierGroupId;
    }
    if (balanceMethod !== undefined) supplier.balanceMethod = balanceMethod;
    if (creditDays !== undefined) {
      if (parseInt(creditDays) < 0) throw new Error("Credit Days cannot be negative");
      supplier.creditDays = parseInt(creditDays) || 0;
    }
    if (isActive !== undefined) supplier.isActive = isActive;

    await supplier.save();
    res.status(200).json(supplier);
  } catch (error) {
    sendError(res, error);
  }
};

const deleteSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!supplier) {
      return res.status(404).json({ message: "Supplier not found" });
    }

    // Item.supplierId, ItemName.supplierId (required), ItemSubGroup.supplierId,
    // PurchaseReturn.supplierId, OpeningBill.supplierId (type=purchase), and
    // Payment.partyId (Supplier) all reference Supplier. Hard-deleting a still-
    // referenced Supplier leaves dangling references.
    const [hasItem, hasItemName, hasItemSubGroup, hasPurchaseReturn, hasOpeningBill, hasPayment] = await Promise.all([
      Item.exists({ companyId: supplier.companyId, supplierId: supplier._id }),
      ItemName.exists({ companyId: supplier.companyId, supplierId: supplier._id }),
      ItemSubGroup.exists({ companyId: supplier.companyId, supplierId: supplier._id }),
      PurchaseReturn.exists({ companyId: supplier.companyId, supplierId: supplier._id }),
      OpeningBill.exists({ companyId: supplier.companyId, supplierId: supplier._id }),
      Payment.exists({ companyId: supplier.companyId, partyType: "Supplier", partyId: supplier._id }),
    ]);
    if (hasItem || hasItemName || hasItemSubGroup || hasPurchaseReturn || hasOpeningBill || hasPayment) {
      return res.status(400).json({
        message: "Cannot delete this supplier — it is still referenced by Items, Item Names, Item Sub Groups, Purchase Returns, Opening Bills, or Payments. Deactivate it instead.",
      });
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
