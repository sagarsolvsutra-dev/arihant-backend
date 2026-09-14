const OpeningBill = require("../models/OpeningBill");
const Customer = require("../models/Customer");
const Supplier = require("../models/Supplier");
const Salesman = require("../models/Salesman");
const { sendError } = require("../utils/errorHandler");
const { assertRefBelongsToCompany } = require("../utils/queryHelpers");

const getOpeningBills = async (req, res) => {
  try {
    const { companyId, type } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const filter = { companyId };
    if (type) filter.type = type;

    const bills = await OpeningBill.find(filter).lean()
      .populate("customerId", "name")
      .populate("supplierId", "name")
      .populate("salesmanId", "name")
      .sort({ billDate: -1 }).lean();

    res.status(200).json(bills);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const createOpeningBill = async (req, res) => {
  try {
    const { companyId, type, customerId, supplierId, taxInvoice, billNo, billDate, dueDate, totalAmount, pendingAmount, salesmanId, notes } = req.body;

    if (!companyId || !type || !billNo || !billDate || totalAmount === undefined) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    // Cross-tenant reference leak guard — see queryHelpers.assertRefBelongsToCompany.
    await assertRefBelongsToCompany(Customer, customerId, companyId, "Customer");
    await assertRefBelongsToCompany(Supplier, supplierId, companyId, "Supplier");
    await assertRefBelongsToCompany(Salesman, salesmanId, companyId, "Salesman");

    if (parseFloat(totalAmount) < 0) {
      throw new Error("Total Amount cannot be negative");
    }
    if (pendingAmount !== undefined && parseFloat(pendingAmount) < 0) {
      throw new Error("Pending Amount cannot be negative");
    }

    const billExists = await OpeningBill.findOne({ companyId, type, billNo });
    if (billExists) {
      return res.status(400).json({ message: "Bill number already exists for this type in this company" });
    }

    const payload = {
      companyId,
      type,
      billNo: billNo.trim(),
      billDate,
      totalAmount: parseFloat(totalAmount) || 0,
      pendingAmount: parseFloat(pendingAmount) || 0,
      notes: notes?.trim() || "",
    };

    if (type === "sale") {
      if (customerId) payload.customerId = customerId;
      if (taxInvoice) payload.taxInvoice = taxInvoice.trim();
      if (dueDate) payload.dueDate = dueDate;
      if (salesmanId) payload.salesmanId = salesmanId;
    } else if (type === "purchase") {
      if (supplierId) payload.supplierId = supplierId;
    }

    const bill = await OpeningBill.create(payload);

    res.status(201).json(bill);
  } catch (error) {
    sendError(res, error);
  }
};

const updateOpeningBill = async (req, res) => {
  try {
    const bill = await OpeningBill.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!bill) {
      return res.status(404).json({ message: "Opening Bill not found" });
    }

    const { customerId, supplierId, taxInvoice, billNo, billDate, dueDate, totalAmount, pendingAmount, salesmanId, notes } = req.body;

    if (billNo) {
      const exists = await OpeningBill.findOne({ companyId: bill.companyId, type: bill.type, billNo, _id: { $ne: req.params.id } });
      if (exists) {
        return res.status(400).json({ message: "Another bill with this number already exists" });
      }
      bill.billNo = billNo.trim();
    }

    if (bill.type === "sale") {
      if (customerId !== undefined) {
        await assertRefBelongsToCompany(Customer, customerId, bill.companyId, "Customer");
        bill.customerId = customerId;
      }
      if (taxInvoice !== undefined) bill.taxInvoice = taxInvoice.trim();
      if (dueDate !== undefined) bill.dueDate = dueDate;
      if (salesmanId !== undefined) {
        await assertRefBelongsToCompany(Salesman, salesmanId, bill.companyId, "Salesman");
        bill.salesmanId = salesmanId;
      }
    } else if (bill.type === "purchase") {
      if (supplierId !== undefined) {
        await assertRefBelongsToCompany(Supplier, supplierId, bill.companyId, "Supplier");
        bill.supplierId = supplierId;
      }
    }

    if (billDate !== undefined) bill.billDate = billDate;
    if (totalAmount !== undefined) {
      if (parseFloat(totalAmount) < 0) throw new Error("Total Amount cannot be negative");
      bill.totalAmount = parseFloat(totalAmount) || 0;
    }
    if (pendingAmount !== undefined) {
      if (parseFloat(pendingAmount) < 0) throw new Error("Pending Amount cannot be negative");
      bill.pendingAmount = parseFloat(pendingAmount) || 0;
    }
    if (notes !== undefined) bill.notes = notes.trim() || "";

    await bill.save();
    res.status(200).json(bill);
  } catch (error) {
    sendError(res, error);
  }
};

const deleteOpeningBill = async (req, res) => {
  try {
    const bill = await OpeningBill.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!bill) {
      return res.status(404).json({ message: "Opening Bill not found" });
    }
    await bill.deleteOne();
    res.status(200).json({ message: "Opening Bill deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getOpeningBills,
  createOpeningBill,
  updateOpeningBill,
  deleteOpeningBill,
};
