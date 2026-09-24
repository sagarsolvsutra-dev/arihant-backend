const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const Supplier = require("../models/Supplier");
const SupplierGroup = require("../models/SupplierGroup");
const GodownGroup = require("../models/GodownGroup");
const Item = require("../models/Item");
const Hsn = require("../models/Hsn");
const ItemName = require("../models/ItemName");
const ItemSubGroup = require("../models/ItemSubGroup");
const Customer = require("../models/Customer");
const CustomerGroup = require("../models/CustomerGroup");
const Salesman = require("../models/Salesman");
const Scheme = require("../models/Scheme");
const OpeningBill = require("../models/OpeningBill");
const Purchase = require("../models/Purchase");
const Sale = require("../models/Sale");
const PurchaseReturn = require("../models/PurchaseReturn");
const SaleReturn = require("../models/SaleReturn");
const StockTransfer = require("../models/StockTransfer");

function fmtDate(d) {
  if (!d) return "-";
  const date = new Date(d);
  if (isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-IN");
}

function money(n) {
  return Number(n || 0);
}

const LIST_EXPORT_CONFIG = {
  suppliers: {
    label: "Suppliers",
    model: Supplier,
    searchFields: ["name", "phone", "email", "city"],
    columns: [
      { header: "Name", width: 110, accessor: (r) => r.name },
      { header: "GST No", width: 90, accessor: (r) => r.gstNo || "-" },
      { header: "Phone", width: 70, accessor: (r) => r.phone || "-" },
      { header: "City", width: 80, accessor: (r) => r.city || "-" },
      { header: "Status", width: 60, accessor: (r) => (r.isActive ? "Active" : "Inactive") },
    ],
  },
  "supplier-groups": {
    label: "Supplier Groups",
    model: SupplierGroup,
    searchFields: ["name"],
    columns: [{ header: "Group Name", width: 150, accessor: (r) => r.name }],
  },
  "godown-groups": {
    label: "Godown Groups",
    model: GodownGroup,
    searchFields: ["name"],
    columns: [{ header: "Group Name", width: 150, accessor: (r) => r.name }],
  },
  items: {
    label: "Items",
    model: Item,
    populate: [{ path: "itemSubGroupId", select: "name" }],
    searchFields: ["itemName", "alias", "hsnCode", "codeBarCode"],
    columns: [
      { header: "Name", width: 120, accessor: (r) => r.itemName },
      { header: "Code", width: 70, accessor: (r) => r.codeBarCode || "-" },
      { header: "HSN", width: 60, accessor: (r) => r.hsnCode || "-" },
      { header: "Sub Group", width: 90, accessor: (r) => r.itemSubGroupId?.name || "-" },
      { header: "UQC", width: 55, accessor: (r) => r.uqcUnit || "-" },
      { header: "Packing", width: 55, accessor: (r) => r.packing || 1, align: "right" },
      { header: "Pur. Type", width: 65, accessor: (r) => r.purchaseType || "-" },
      { header: "MRP", width: 65, accessor: (r) => money(r.mrp), align: "right", moneyCol: true },
      { header: "Net Cost - Self", width: 80, accessor: (r) => money(r.lastCostRate), align: "right", moneyCol: true },
      { header: "Status", width: 60, accessor: (r) => (r.isActive ? "Active" : "Inactive") },
    ],
  },
  hsn: {
    label: "HSN Codes",
    model: Hsn,
    searchFields: ["hsnCode", "description"],
    columns: [
      { header: "HSN Code", width: 70, accessor: (r) => r.hsnCode },
      { header: "Description", width: 160, accessor: (r) => r.description || "-" },
      { header: "UQC Unit", width: 90, accessor: (r) => r.uqcUnit || "-" },
    ],
  },
  "item-names": {
    label: "Item Names",
    model: ItemName,
    populate: [{ path: "supplierId", select: "name" }],
    searchFields: ["name"],
    columns: [
      { header: "Name", width: 130, accessor: (r) => r.name },
      { header: "Supplier", width: 110, accessor: (r) => r.supplierId?.name || "-" },
      { header: "Status", width: 60, accessor: (r) => (r.isActive ? "Active" : "Inactive") },
    ],
  },
  "item-sub-groups": {
    label: "Item Sub Groups",
    model: ItemSubGroup,
    populate: [{ path: "supplierId", select: "name" }, { path: "itemNameId", select: "name" }],
    searchFields: ["name"],
    columns: [
      { header: "Name", width: 130, accessor: (r) => r.name },
      { header: "Supplier", width: 110, accessor: (r) => r.supplierId?.name || "-" },
      { header: "Item Name", width: 110, accessor: (r) => r.itemNameId?.name || "-" },
      { header: "Status", width: 60, accessor: (r) => (r.isActive ? "Active" : "Inactive") },
    ],
  },
  customers: {
    label: "Customers",
    model: Customer,
    populate: [{ path: "customerGroupId", select: "name" }],
    searchFields: ["name", "phone", "email", "city"],
    columns: [
      { header: "Name", width: 120, accessor: (r) => r.name },
      { header: "Group", width: 90, accessor: (r) => r.customerGroupId?.name || "-" },
      { header: "GST No", width: 90, accessor: (r) => r.gstNo || "-" },
      { header: "Phone", width: 70, accessor: (r) => r.phone || "-" },
      { header: "City", width: 80, accessor: (r) => r.city || "-" },
      { header: "Status", width: 60, accessor: (r) => (r.isActive ? "Active" : "Inactive") },
    ],
  },
  "customer-groups": {
    label: "Customer Groups",
    model: CustomerGroup,
    searchFields: ["name"],
    columns: [
      { header: "Group Name", width: 150, accessor: (r) => r.name },
      { header: "Zone No", width: 70, accessor: (r) => r.zoneNo || "-" },
    ],
  },
  salesmen: {
    label: "Salesmen",
    model: Salesman,
    searchFields: ["name", "phone", "email"],
    columns: [
      { header: "Name", width: 120, accessor: (r) => r.name },
      { header: "Phone", width: 80, accessor: (r) => r.phone || "-" },
      { header: "Email", width: 130, accessor: (r) => r.email || "-" },
      { header: "Status", width: 60, accessor: (r) => (r.isActive ? "Active" : "Inactive") },
    ],
  },
  schemes: {
    label: "Schemes",
    model: Scheme,
    populate: [{ path: "customerId", select: "name" }],
    columns: [
      { header: "Customer Name", width: 130, accessor: (r) => r.customerId?.name || "-" },
      { header: "Less %age", width: 70, accessor: (r) => (r.lessPercentage != null ? r.lessPercentage.toFixed(2) : "0.00"), align: "right" },
      { header: "C.D. %age", width: 70, accessor: (r) => (r.cdPercentage != null ? r.cdPercentage.toFixed(2) : "0.00"), align: "right" },
    ],
  },
  "opening-bills-sale": {
    label: "Opening Pending of Sale Bill",
    model: OpeningBill,
    baseFilter: { type: "sale" },
    populate: [{ path: "customerId", select: "name" }],
    dateField: "billDate",
    columns: [
      { header: "Customer Name", width: 120, accessor: (r) => r.customerId?.name || "-" },
      { header: "Invoice No", width: 70, accessor: (r) => r.billNo },
      { header: "Invoice Date", width: 70, accessor: (r) => fmtDate(r.billDate) },
      { header: "Amount", width: 80, accessor: (r) => money(r.totalAmount), align: "right", moneyCol: true },
    ],
  },
  "opening-bills-purchase": {
    label: "Opening Pending of Purchase Bill",
    model: OpeningBill,
    baseFilter: { type: "purchase" },
    populate: [{ path: "supplierId", select: "name" }],
    dateField: "billDate",
    columns: [
      { header: "Supplier Name", width: 120, accessor: (r) => r.supplierId?.name || "-" },
      { header: "Invoice No", width: 70, accessor: (r) => r.billNo },
      { header: "Invoice Date", width: 70, accessor: (r) => fmtDate(r.billDate) },
      { header: "Amount", width: 80, accessor: (r) => money(r.totalAmount), align: "right", moneyCol: true },
    ],
  },
  purchases: {
    label: "Purchases",
    model: Purchase,
    dateField: "invoiceDate",
    searchFields: ["invoiceNo"],
    columns: [
      { header: "Invoice No", width: 70, accessor: (r) => r.invoiceNo },
      { header: "Date", width: 65, accessor: (r) => fmtDate(r.invoiceDate) },
      { header: "Items", width: 50, accessor: (r) => r.totalItems || 0, align: "right" },
      { header: "Case", width: 50, accessor: (r) => r.totalCase || 0, align: "right" },
      { header: "Loose", width: 50, accessor: (r) => r.totalPcs || 0, align: "right" },
      { header: "Total Qty", width: 60, accessor: (r) => r.totalQty || 0, align: "right" },
      { header: "Net Amount", width: 85, accessor: (r) => money(r.netAmount), align: "right", moneyCol: true },
    ],
  },
  sales: {
    label: "Sales",
    model: Sale,
    dateField: "invoiceDate",
    populate: [{ path: "customerId", select: "name" }],
    searchFields: ["invoiceNo"],
    columns: [
      { header: "Invoice No", width: 70, accessor: (r) => r.invoiceNo },
      { header: "Date", width: 65, accessor: (r) => fmtDate(r.invoiceDate) },
      { header: "Customer", width: 110, accessor: (r) => r.customerId?.name || "-" },
      { header: "Items", width: 50, accessor: (r) => r.totalItems || 0, align: "right" },
      { header: "Case", width: 50, accessor: (r) => r.totalCase || 0, align: "right" },
      { header: "Loose", width: 50, accessor: (r) => r.totalPcs || 0, align: "right" },
      { header: "Total Qty", width: 60, accessor: (r) => r.totalQty || 0, align: "right" },
      { header: "Net Amount", width: 85, accessor: (r) => money(r.netAmount), align: "right", moneyCol: true },
      { header: "Pending", width: 80, accessor: (r) => money(r.pendingAmount), align: "right", moneyCol: true },
    ],
  },
  "purchase-returns": {
    label: "Purchase Returns",
    model: PurchaseReturn,
    dateField: "returnDate",
    populate: [{ path: "supplierId", select: "name" }],
    searchFields: ["returnNo"],
    columns: [
      { header: "Return No", width: 70, accessor: (r) => r.returnNo },
      { header: "Date", width: 65, accessor: (r) => fmtDate(r.returnDate) },
      { header: "Supplier", width: 110, accessor: (r) => r.supplierId?.name || "-" },
      { header: "Orig. Invoice", width: 75, accessor: (r) => r.originalInvoiceNo || "-" },
      { header: "Items", width: 50, accessor: (r) => r.totalItems || 0, align: "right" },
      { header: "Case", width: 50, accessor: (r) => r.totalCase || 0, align: "right" },
      { header: "Loose", width: 50, accessor: (r) => r.totalPcs || 0, align: "right" },
      { header: "Net Amount", width: 85, accessor: (r) => money(r.netAmount), align: "right", moneyCol: true },
      { header: "Pending", width: 80, accessor: (r) => money(r.pendingAmount), align: "right", moneyCol: true },
    ],
  },
  "sale-returns": {
    label: "Sale Returns",
    model: SaleReturn,
    dateField: "returnDate",
    populate: [{ path: "customerId", select: "name" }],
    searchFields: ["returnNo"],
    columns: [
      { header: "Return No", width: 70, accessor: (r) => r.returnNo },
      { header: "Date", width: 65, accessor: (r) => fmtDate(r.returnDate) },
      { header: "Customer", width: 110, accessor: (r) => r.customerId?.name || "-" },
      { header: "Orig. Invoice", width: 75, accessor: (r) => r.originalInvoiceNo || "-" },
      { header: "Items", width: 50, accessor: (r) => r.totalItems || 0, align: "right" },
      { header: "Case", width: 50, accessor: (r) => r.totalCase || 0, align: "right" },
      { header: "Loose", width: 50, accessor: (r) => r.totalPcs || 0, align: "right" },
      { header: "Net Amount", width: 85, accessor: (r) => money(r.netAmount), align: "right", moneyCol: true },
      { header: "Pending", width: 80, accessor: (r) => money(r.pendingAmount), align: "right", moneyCol: true },
    ],
  },
  "stock-transfers": {
    label: "Stock Transfers",
    model: StockTransfer,
    dateField: "transferDate",
    populate: [{ path: "fromGodownId", select: "name" }, { path: "toGodownId", select: "name" }],
    searchFields: ["transferNo"],
    columns: [
      { header: "Transfer No", width: 75, accessor: (r) => r.transferNo },
      { header: "Date", width: 65, accessor: (r) => fmtDate(r.transferDate) },
      { header: "From Godown", width: 95, accessor: (r) => r.fromGodownId?.name || "-" },
      { header: "To Godown", width: 95, accessor: (r) => r.toGodownId?.name || "-" },
      { header: "Items", width: 50, accessor: (r) => r.totalItems || 0, align: "right" },
      { header: "Case", width: 50, accessor: (r) => r.totalCase || 0, align: "right" },
      { header: "Loose", width: 50, accessor: (r) => r.totalPcs || 0, align: "right" },
      { header: "Total Qty", width: 60, accessor: (r) => r.totalQty || 0, align: "right" },
    ],
  },
};

function addExcelSheet(workbook, sheetName, columns, records) {
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  sheet.columns = columns.map((c, i) => ({
    header: c.header,
    key: `c${i}`,
    width: Math.max(12, Math.round(c.width / 6)),
  }));
  records.forEach((rec) => {
    const row = {};
    columns.forEach((c, i) => {
      row[`c${i}`] = c.accessor(rec);
    });
    sheet.addRow(row);
  });
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111111" } };
  });
  columns.forEach((c, i) => {
    if (c.align === "right") sheet.getColumn(i + 1).alignment = { horizontal: "right" };
  });
  const moneyCols = columns.map((c, i) => (c.moneyCol ? i : -1)).filter((i) => i >= 0);
  if (moneyCols.length) {
    const totals = {};
    moneyCols.forEach((i) => {
      totals[`c${i}`] = records.reduce((s, rec) => s + (columns[i].accessor(rec) || 0), 0);
    });
    totals[`c0`] = totals[`c0`] || "TOTAL";
    const totalRow = sheet.addRow(totals);
    totalRow.font = { bold: true };
  }
}

async function sendPdfFile(res, title, columns, records, filename) {
  const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  doc.pipe(res);

  doc.fontSize(16).fillColor("#000").text(title);
  doc.fontSize(9).fillColor("#666").text(`Generated ${new Date().toLocaleString("en-IN")}`);
  let y = doc.y + 16;
  
  const startX = doc.page.margins.left;
  const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const rowHeight = 20;

  const totalColsWidth = columns.reduce((s, c) => s + c.width, 0);
  const scale = totalWidth / totalColsWidth;

  function drawHeaderRow() {
    let x = startX;
    doc.rect(startX, y, totalWidth, rowHeight).fill("#111111");
    doc.fillColor("#fff").fontSize(9);
    columns.forEach((c) => {
      const w = c.width * scale;
      doc.text(c.header, x + 4, y + 6, { width: w - 8, align: c.align || "left" });
      x += w;
    });
    y += rowHeight;
  }

  drawHeaderRow();

  if (records.length === 0) {
    doc.fillColor("#888").fontSize(8.5).text("No records.", startX + 4, y + 4);
    y += rowHeight;
  }

  records.forEach((r, idx) => {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeaderRow();
    }
    if (idx % 2 === 1) {
      doc.rect(startX, y, totalWidth, rowHeight).fill("#f5f5f5");
    }
    let x = startX;
    doc.fillColor("#000").fontSize(8.5);
    columns.forEach((c) => {
      const w = c.width * scale;
      let val = c.accessor(r);
      if (c.moneyCol) val = `Rs.${Number(val || 0).toFixed(2)}`;
      doc.text(String(val ?? "-"), x + 4, y + 6, { width: w - 8, align: c.align || "left" });
      x += w;
    });
    y += rowHeight;
  });

  const moneyCols = columns.map((c, i) => (c.moneyCol ? i : -1)).filter((i) => i >= 0);
  if (moneyCols.length > 0 && records.length > 0) {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    doc.rect(startX, y, totalWidth, rowHeight).fill("#e5e5e5");
    doc.fillColor("#000").fontSize(9).font("Helvetica-Bold");
    let x = startX;
    columns.forEach((c, i) => {
      const w = c.width * scale;
      if (i === 0) {
        doc.text("TOTAL", x + 4, y + 6, { width: w - 8 });
      } else if (c.moneyCol) {
        const totalVal = records.reduce((s, rec) => s + (c.accessor(rec) || 0), 0);
        doc.text(`Rs.${Number(totalVal).toFixed(2)}`, x + 4, y + 6, { width: w - 8, align: "right" });
      }
      x += w;
    });
    y += rowHeight;
  }

  doc.end();
}

// GET /api/export-list/:resource?companyId=&dateFrom=&dateTo=&search=
const exportList = async (req, res) => {
  try {
    const resource = req.params.resource;
    const { companyId, dateFrom, dateTo, search } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }
    if (!Object.prototype.hasOwnProperty.call(LIST_EXPORT_CONFIG, resource)) {
      return res.status(400).json({ message: "Invalid export resource" });
    }
    const config = LIST_EXPORT_CONFIG[resource];

    const filter = { companyId, ...(config.baseFilter || {}) };
    if (config.dateField && (dateFrom || dateTo)) {
      filter[config.dateField] = {};
      if (dateFrom) filter[config.dateField].$gte = new Date(`${dateFrom}T00:00:00.000Z`);
      if (dateTo) filter[config.dateField].$lte = new Date(`${dateTo}T23:59:59.999Z`);
    }
    if (search && search.trim() && Array.isArray(config.searchFields) && config.searchFields.length) {
      const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = { $regex: escaped, $options: "i" };
      filter.$or = config.searchFields.map((field) => ({ [field]: regex }));
    }

    let query = config.model.find(filter);
    (config.populate || []).forEach((p) => {
      query = query.populate(p.path, p.select);
    });
    const sortField = config.dateField || "createdAt";
    const records = await query.sort({ [sortField]: -1 }).limit(10000).lean();

    const format = req.query.format || "excel";
    const safeName = config.label.replace(/[^a-z0-9]+/gi, "_");
    
    if (format === "pdf") {
      await sendPdfFile(res, config.label, config.columns, records, `${safeName}.pdf`);
    } else {
      const workbook = new ExcelJS.Workbook();
      addExcelSheet(workbook, config.label, config.columns, records);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}.xlsx"`);
      await workbook.xlsx.write(res);
      res.end();
    }
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.status(500).json({ message: error.message || "Failed to generate export" });
    } else {
      res.end();
    }
  }
};

module.exports = { exportList, LIST_EXPORT_CONFIG };
