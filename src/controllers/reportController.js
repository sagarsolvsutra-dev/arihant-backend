const mongoose = require("mongoose");
const { XLSX, PDF, styleHeaderRow, styleTotalRow, styleDataRow } = require("../utils/exportTheme");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const Item = require("../models/Item");
const Customer = require("../models/Customer");
const Supplier = require("../models/Supplier");
const Godown = require("../models/Godown");
const Purchase = require("../models/Purchase");
const Sale = require("../models/Sale");
const PurchaseReturn = require("../models/PurchaseReturn");
const SaleReturn = require("../models/SaleReturn");
const OpeningBill = require("../models/OpeningBill");
const Payment = require("../models/Payment");
const Company = require("../models/Company");
const BankAccount = require("../models/BankAccount");
const { searchRegex, clampLimit, clampPage, isValidObjectId } = require("../utils/queryHelpers");

const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

// A report can be exported to Excel far larger than any one paginated page —
// this is the same cap `exportListController.js` uses for its own exports.
const EXPORT_ROW_CAP = 10000;

// Mirrors exportListController.js's own addExcelSheet — duplicated rather
// than imported, matching this codebase's established per-controller style
// for the handful of export helpers (see exportController.js too).
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
    cell.font = { bold: true, color: { argb: XLSX.headerText }, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XLSX.headerBg } };
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

async function sendExcelFile(res, sheetName, columns, records, filename) {
  const workbook = new ExcelJS.Workbook();
  addExcelSheet(workbook, sheetName, columns, records);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}

// Draws the striped/paginated data table shared by every PDF export below —
// extracted out of the old sendPdfFile so the Ledger PDF (which now also
// needs a title/subtitle/summary-cards header above this same table, to
// visually match the on-screen Ledger page) can reuse the exact table
// styling without duplicating the header-row/pagination logic.
// Hard-truncates a string to the given pixel width using the font metrics
// actually in effect, appending an ellipsis. drawDataTable draws fixed-height
// rows, so a cell MUST occupy exactly one line — pdfkit's own lineBreak/
// ellipsis options were tried first and did not reliably clamp (confirmed by
// reading back generated PDFs), hence measuring and cutting here instead.
function fitText(doc, str, maxWidth) {
  let t = String(str ?? "-");
  if (doc.widthOfString(t) <= maxWidth) return t;
  while (t.length > 1 && doc.widthOfString(t + "…") > maxWidth) t = t.slice(0, -1);
  return t + "…";
}

function drawDataTable(doc, columns, records, startY) {
  let y = startY;
  const startX = doc.page.margins.left;
  const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const rowHeight = 20;

  const totalColsWidth = columns.reduce((s, c) => s + c.width, 0);
  const scale = totalWidth / totalColsWidth;

  function drawHeaderRow() {
    let x = startX;
    doc.rect(startX, y, totalWidth, rowHeight).fill(PDF.headerBg);
    doc.fillColor(PDF.headerText).fontSize(9);
    columns.forEach((c) => {
      const w = c.width * scale;
      doc.text(fitText(doc, c.header, w - 8), x + 4, y + 6, { width: w - 8, align: c.align || "left", lineBreak: false });
      x += w;
    });
    y += rowHeight;
  }

  drawHeaderRow();

  if (records.length === 0) {
    doc.fillColor(PDF.mutedText).fontSize(8.5).text("No records.", startX + 4, y + 4);
    y += rowHeight;
  }

  records.forEach((r, idx) => {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeaderRow();
    }
    if (idx % 2 === 1) {
      doc.rect(startX, y, totalWidth, rowHeight).fill(PDF.zebraBg);
    }
    let x = startX;
    doc.fillColor(PDF.bodyText).fontSize(8.5);
    columns.forEach((c) => {
      const w = c.width * scale;
      let val = c.accessor(r);
      if (c.moneyCol) val = `Rs.${Number(val || 0).toFixed(2)}`;
      // lineBreak:false is load-bearing, not cosmetic: rowHeight is fixed, so
      // a cell allowed to wrap pushes its own text into the NEXT row's band
      // and the table silently de-aligns from that row on.
      doc.text(fitText(doc, val, w - 8), x + 4, y + 6, { width: w - 8, align: c.align || "left", lineBreak: false });
      x += w;
    });
    y += rowHeight;
  });

  return y;
}

async function sendPdfFile(res, title, columns, records, filename, company) {
  // Wide reports (the Item Report alone now carries ~27 columns once every
  // quantity also prints its Case/Loose split) are unreadable squeezed into
  // portrait. Same >480pt rule exportController.js already uses.
  const totalColsWidth = columns.reduce((s, c) => s + (c.width || 60), 0);
  const layout = totalColsWidth > 480 ? "landscape" : "portrait";
  const doc = new PDFDocument({ margin: 40, size: "A4", layout });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  doc.pipe(res);

  const startX = doc.page.margins.left;
  const innerWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Company letterhead — the same name/address/PH/GSTIN block the Tally
  // ledger PDFs print, so every PDF this app produces is recognisably on the
  // same stationery. Values come from the Company record, which a
  // company_admin maintains themselves on the Settings page.
  if (company?.name) {
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#000")
      .text(String(company.name).toUpperCase(), startX, doc.y, { width: innerWidth, align: "center" });
    if (company.address) {
      doc.font("Helvetica").fontSize(8.5).fillColor("#333")
        .text(String(company.address).toUpperCase(), startX, doc.y + 1, { width: innerWidth, align: "center" });
    }
    const sub = [];
    if (company.phone) sub.push(`PH: ${company.phone}`);
    if (company.gstNo) sub.push(`GSTIN: ${company.gstNo}`);
    if (sub.length) {
      doc.font("Helvetica").fontSize(8).fillColor("#444")
        .text(sub.join("  |  "), startX, doc.y + 1, { width: innerWidth, align: "center" });
    }
    doc.moveDown(0.6);
  }

  doc.font("Helvetica-Bold").fontSize(13).fillColor(PDF.accent)
    .text(title, startX, doc.y, { width: innerWidth, align: "center" });
  doc.font("Helvetica").fontSize(8).fillColor(PDF.mutedText)
    .text(`Generated ${new Date().toLocaleString("en-IN")}`, startX, doc.y + 1, { width: innerWidth, align: "center" });
  // Quantity cells print compactly as "23C 10P" so 12+ columns still fit a
  // landscape page without the numbers themselves getting truncated.
  if (columns.some((c) => c.qtyLegend)) {
    doc.fontSize(7.5).fillColor(PDF.mutedText)
      .text("Quantities shown as  <Case>C <Loose Pcs>P", startX, doc.y + 1, { width: innerWidth, align: "center" });
  }
  const y = doc.y + 14;

  drawDataTable(doc, columns, records, y);

  doc.end();
}

// Every report export endpoint accepts ?format=pdf alongside its default
// Excel. Both formats are driven off the SAME `columns` array, so a column
// added to one can never silently go missing from the other.
async function sendReportFile(res, { format, company, title, columns, pdfColumns, records, baseFilename }) {
  if (String(format || "").toLowerCase() === "pdf") {
    // A spreadsheet can carry 28 columns and still be usable; a printed page
    // cannot. `pdfColumns` lets a wide report collapse its Case/Loose/total
    // triples into one "N Case M Pcs" cell for print while the Excel export
    // keeps every figure in its own sortable column.
    return sendPdfFile(res, title, pdfColumns || columns, records, `${baseFilename}.pdf`, company);
  }
  return sendExcelFile(res, title, columns, records, `${baseFilename}.xlsx`);
}

// Letterhead for any PDF this controller emits. Scoped by
// req.effectiveCompanyId (the value scopeCompany actually computed), never
// req.user.companyId — see CLAUDE.md quirk #62.
async function loadCompanyLetterhead(req) {
  try {
    const cid = req.effectiveCompanyId || req.query.companyId;
    if (!cid || !isValidObjectId(cid)) return null;
    return await Company.findById(cid).select("name address phone gstNo").lean();
  } catch {
    return null;
  }
}

// Stat-card boxes (label above a bold value) drawn side-by-side across the
// page width — mirrors the on-screen Ledger page's summary cards (Total
// Purchases/Total Paid/Closing Balance, etc.) so the exported PDF looks like
// a printout of what the user actually sees on screen, not just a bare table.
function drawSummaryCards(doc, cards, startY) {
  const startX = doc.page.margins.left;
  const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gap = 10;
  const cardWidth = (totalWidth - gap * (cards.length - 1)) / cards.length;
  const cardHeight = 48;

  cards.forEach((card, i) => {
    const x = startX + i * (cardWidth + gap);
    doc.rect(x, startY, cardWidth, cardHeight).lineWidth(1).strokeColor("#d9d9d9").stroke();
    doc.fillColor("#666").fontSize(8).font("Helvetica").text(card.label, x + 10, startY + 10, { width: cardWidth - 20 });
    doc
      .fillColor(card.color || "#111111")
      .fontSize(13)
      .font("Helvetica-Bold")
      .text(card.value, x + 10, startY + 25, { width: cardWidth - 20 });
    doc.font("Helvetica");
  });

  return startY + cardHeight + 18;
}

// The Tally-style Ledger Account PDF renderer (and its Indian-format date/
// number helpers) now lives in utils/tallyPdf.js so the Bank Account,
// Account, Expense and Payment statements print on the identical
// letterhead and table as the Customer/Supplier ledgers below.
const { sendLedgerPdf } = require("../utils/tallyPdf");

function fmtDate(d) {
  if (!d) return "-";
  const date = new Date(d);
  if (isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-IN");
}

function oid(id) {
  return new mongoose.Types.ObjectId(id);
}

// Aggregation $match doesn't auto-cast strings to ObjectId/Date the way
// Mongoose's find() does — every date-range/companyId condition below has to
// be built explicitly with real BSON values or the $match silently matches
// nothing.
function dateRangeFilter(field, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return {};
  const range = {};
  if (dateFrom) range.$gte = new Date(`${dateFrom}T00:00:00.000Z`);
  if (dateTo) range.$lte = new Date(`${dateTo}T23:59:59.999Z`);
  return { [field]: range };
}

// GET /api/reports/items?companyId=&dateFrom=&dateTo=&search=&page=&limit=
// Per-item summary: purchased/sold/returned qty+value within the date range,
// plus current stock (the flat, always-current fields — not date-filtered,
// since "current stock" only has one meaning: right now).
const getItemReport = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo, search = "", page = 1, limit = 10 } = req.query;
    // super_admin calling with no explicit companyId gets `{ $ne: null }` from
    // scopeCompany as its "match any company" sentinel — passing that straight
    // into `new mongoose.Types.ObjectId(...)` throws a raw BSON cast error, a
    // 500. A specific, ObjectId-shaped companyId is required for every report.
    if (!companyId || !isValidObjectId(companyId)) {
      return res.status(400).json({ message: "A specific companyId is required for this report" });
    }

    const itemQuery = { companyId };
    if (search && search.trim()) itemQuery.itemName = searchRegex(search.trim());

    const parsedPage = clampPage(page);
    const parsedLimit = clampLimit(limit);
    const skip = (parsedPage - 1) * parsedLimit;

    const [items, total] = await Promise.all([
      Item.find(itemQuery).populate("itemSubGroupId", "name").sort({ itemName: 1 }).skip(skip).limit(parsedLimit).lean(),
      Item.countDocuments(itemQuery),
    ]);
    const itemIds = items.map((i) => i._id);

    async function aggregateByItem(Model, dateField) {
      if (!itemIds.length) return new Map();
      const match = {
        companyId: oid(companyId),
        ...dateRangeFilter(dateField, dateFrom, dateTo),
      };
      const rows = await Model.aggregate([
        { $match: match },
        { $unwind: "$items" },
        { $match: { "items.itemId": { $in: itemIds } } },
        {
          $group: {
            _id: "$items.itemId",
            qty: { $sum: "$items.totalPieces" },
            amount: { $sum: "$items.netValue" },
          },
        },
      ]);
      return new Map(rows.map((r) => [String(r._id), { qty: r.qty, amount: r.amount }]));
    }

    const [purchaseMap, saleMap, purchaseReturnMap, saleReturnMap] = await Promise.all([
      aggregateByItem(Purchase, "invoiceDate"),
      aggregateByItem(Sale, "invoiceDate"),
      aggregateByItem(PurchaseReturn, "returnDate"),
      aggregateByItem(SaleReturn, "returnDate"),
    ]);

    const zero = { qty: 0, amount: 0 };
    const data = items.map((item) => {
      const id = String(item._id);
      const purchased = purchaseMap.get(id) || zero;
      const sold = saleMap.get(id) || zero;
      const purchaseReturned = purchaseReturnMap.get(id) || zero;
      const saleReturned = saleReturnMap.get(id) || zero;
      const packing = item.packing || 1;
      // Every quantity on this report was previously a bare total-pieces
      // number. A wholesale distributor reads stock as "Carton + loose
      // pieces", so each one now ALSO carries its Case/Loose split, keyed
      // off this item's own packing. splitCasePcsTrunc (not lib/stock.ts's
      // Math.floor-based splitCasePcs) truncates toward zero, so a negative
      // figure reads as "0 Case -3 Pcs" rather than "-1 Case 47 Pcs" — the
      // same convention the Full Report already uses.
      const split = (totalPcs) => {
        const { caseQty, pcs } = splitCasePcsTrunc(totalPcs, packing);
        return { case: caseQty, loose: pcs };
      };
      const purchasedSplit = split(purchased.qty);
      const soldSplit = split(sold.qty);
      const purchaseReturnedSplit = split(purchaseReturned.qty);
      const saleReturnedSplit = split(saleReturned.qty);
      const freshSplit = split(item.openingStockFreshPcs || 0);
      const expiredSplit = split(item.openingStockExpiredPcs || 0);
      const damagedSplit = split(item.openingStockDamagedPcs || 0);
      return {
        itemId: item._id,
        itemName: item.itemName,
        subGroupName: item.itemSubGroupId?.name || null,
        packing,
        currentStockFreshPcs: item.openingStockFreshPcs || 0,
        currentStockExpiredPcs: item.openingStockExpiredPcs || 0,
        currentStockDamagedPcs: item.openingStockDamagedPcs || 0,
        currentStockFreshCase: freshSplit.case,
        currentStockFreshLoosePcs: freshSplit.loose,
        currentStockExpiredCase: expiredSplit.case,
        currentStockExpiredLoosePcs: expiredSplit.loose,
        currentStockDamagedCase: damagedSplit.case,
        currentStockDamagedLoosePcs: damagedSplit.loose,
        purchasedQty: purchased.qty,
        purchasedCase: purchasedSplit.case,
        purchasedLoosePcs: purchasedSplit.loose,
        purchasedAmount: purchased.amount,
        soldQty: sold.qty,
        soldCase: soldSplit.case,
        soldLoosePcs: soldSplit.loose,
        soldAmount: sold.amount,
        purchaseReturnedQty: purchaseReturned.qty,
        purchaseReturnedCase: purchaseReturnedSplit.case,
        purchaseReturnedLoosePcs: purchaseReturnedSplit.loose,
        purchaseReturnedAmount: purchaseReturned.amount,
        saleReturnedQty: saleReturned.qty,
        saleReturnedCase: saleReturnedSplit.case,
        saleReturnedLoosePcs: saleReturnedSplit.loose,
        saleReturnedAmount: saleReturned.amount,
      };
    });

    res.status(200).json({
      data,
      pagination: { total, page: parsedPage, limit: parsedLimit, totalPages: Math.ceil(total / parsedLimit) },
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

// GET /api/reports/customers?companyId=&dateFrom=&dateTo=&search=&page=&limit=
const getCustomerReport = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo, search = "", page = 1, limit = 10 } = req.query;
    // super_admin calling with no explicit companyId gets `{ $ne: null }` from
    // scopeCompany as its "match any company" sentinel — passing that straight
    // into `new mongoose.Types.ObjectId(...)` throws a raw BSON cast error, a
    // 500. A specific, ObjectId-shaped companyId is required for every report.
    if (!companyId || !isValidObjectId(companyId)) {
      return res.status(400).json({ message: "A specific companyId is required for this report" });
    }

    const query = { companyId };
    if (search && search.trim()) {
      const r = searchRegex(search.trim());
      query.$or = [{ name: r }, { phone: r }, { email: r }, { city: r }];
    }

    const parsedPage = clampPage(page);
    const parsedLimit = clampLimit(limit);
    const skip = (parsedPage - 1) * parsedLimit;

    const [customers, total] = await Promise.all([
      Customer.find(query).sort({ name: 1 }).skip(skip).limit(parsedLimit).lean(),
      Customer.countDocuments(query),
    ]);
    const customerIds = customers.map((c) => c._id);

    async function aggregateByCustomer(Model, dateField) {
      if (!customerIds.length) return new Map();
      const match = {
        companyId: oid(companyId),
        customerId: { $in: customerIds },
        ...dateRangeFilter(dateField, dateFrom, dateTo),
      };
      const rows = await Model.aggregate([
        { $match: match },
        {
          $group: {
            _id: "$customerId",
            count: { $sum: 1 },
            netAmount: { $sum: "$netAmount" },
            pendingAmount: { $sum: "$pendingAmount" },
          },
        },
      ]);
      return new Map(rows.map((r) => [String(r._id), r]));
    }

    const [saleMap, saleReturnMap] = await Promise.all([
      aggregateByCustomer(Sale, "invoiceDate"),
      aggregateByCustomer(SaleReturn, "returnDate"),
    ]);

    const zero = { count: 0, netAmount: 0, pendingAmount: 0 };
    const data = customers.map((c) => {
      const id = String(c._id);
      const sale = saleMap.get(id) || zero;
      const saleReturn = saleReturnMap.get(id) || zero;
      return {
        customerId: c._id,
        name: c.name,
        phone: c.phone,
        city: c.city,
        saleCount: sale.count,
        saleAmount: sale.netAmount,
        salePendingAmount: sale.pendingAmount,
        saleReturnCount: saleReturn.count,
        saleReturnAmount: saleReturn.netAmount,
        saleReturnPendingAmount: saleReturn.pendingAmount,
        netPendingAmount: (sale.pendingAmount || 0) - (saleReturn.pendingAmount || 0),
      };
    });

    res.status(200).json({
      data,
      pagination: { total, page: parsedPage, limit: parsedLimit, totalPages: Math.ceil(total / parsedLimit) },
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

// GET /api/reports/suppliers?companyId=&dateFrom=&dateTo=&search=&page=&limit=
// Purchase has no supplierId field (see CLAUDE.md quirk #9) — a Purchase invoice
// is attributed to this supplier if any line's Item.supplierId matches, using
// the sum of only the matching lines' netValue (not the whole invoice), same
// convention already established on suppliers/purchases/[id]'s drill-down page.
const getSupplierReport = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo, search = "", page = 1, limit = 10 } = req.query;
    // super_admin calling with no explicit companyId gets `{ $ne: null }` from
    // scopeCompany as its "match any company" sentinel — passing that straight
    // into `new mongoose.Types.ObjectId(...)` throws a raw BSON cast error, a
    // 500. A specific, ObjectId-shaped companyId is required for every report.
    if (!companyId || !isValidObjectId(companyId)) {
      return res.status(400).json({ message: "A specific companyId is required for this report" });
    }

    const query = { companyId };
    if (search && search.trim()) {
      const r = searchRegex(search.trim());
      query.$or = [{ name: r }, { phone: r }, { email: r }, { city: r }];
    }

    const parsedPage = clampPage(page);
    const parsedLimit = clampLimit(limit);
    const skip = (parsedPage - 1) * parsedLimit;

    const [suppliers, total] = await Promise.all([
      Supplier.find(query).sort({ name: 1 }).skip(skip).limit(parsedLimit).lean(),
      Supplier.countDocuments(query),
    ]);
    const supplierIds = suppliers.map((s) => s._id);

    let purchaseMap = new Map();
    if (supplierIds.length) {
      const rows = await Purchase.aggregate([
        { $match: { companyId: oid(companyId), ...dateRangeFilter("invoiceDate", dateFrom, dateTo) } },
        { $unwind: "$items" },
        { $lookup: { from: "items", localField: "items.itemId", foreignField: "_id", as: "itemDoc" } },
        { $unwind: "$itemDoc" },
        { $match: { "itemDoc.supplierId": { $in: supplierIds } } },
        {
          $group: {
            _id: { purchaseId: "$_id", supplierId: "$itemDoc.supplierId" },
            lineAmount: { $sum: "$items.netValue" },
            // Purchase's pendingAmount is header-level (one invoice, not per-line —
            // see quirk #9), so when a single invoice's lines span more than one
            // supplier, naively attributing the FULL header pendingAmount to every
            // supplier that touched it would double- (or N-times-) count that money
            // across the report. Instead each supplier's share is apportioned below,
            // proportional to its own lines' share of the invoice's total billed
            // amount — the shares sum back to exactly the invoice's real
            // pendingAmount, no matter how many suppliers its lines span.
            pendingAmount: { $first: "$pendingAmount" },
            netAmount: { $first: "$netAmount" },
          },
        },
        {
          $project: {
            lineAmount: 1,
            pendingShare: {
              $cond: [
                { $gt: ["$netAmount", 0] },
                { $multiply: ["$pendingAmount", { $divide: ["$lineAmount", "$netAmount"] }] },
                0,
              ],
            },
          },
        },
        {
          $group: {
            _id: "$_id.supplierId",
            count: { $sum: 1 },
            amount: { $sum: "$lineAmount" },
            pendingAmount: { $sum: "$pendingShare" },
          },
        },
      ]);
      purchaseMap = new Map(rows.map((r) => [String(r._id), r]));
    }

    let purchaseReturnMap = new Map();
    if (supplierIds.length) {
      const rows = await PurchaseReturn.aggregate([
        {
          $match: {
            companyId: oid(companyId),
            supplierId: { $in: supplierIds },
            ...dateRangeFilter("returnDate", dateFrom, dateTo),
          },
        },
        {
          $group: {
            _id: "$supplierId",
            count: { $sum: 1 },
            netAmount: { $sum: "$netAmount" },
            pendingAmount: { $sum: "$pendingAmount" },
          },
        },
      ]);
      purchaseReturnMap = new Map(rows.map((r) => [String(r._id), r]));
    }

    const zero = { count: 0, amount: 0, netAmount: 0, pendingAmount: 0 };
    const data = suppliers.map((s) => {
      const id = String(s._id);
      const purchase = purchaseMap.get(id) || zero;
      const purchaseReturn = purchaseReturnMap.get(id) || zero;
      return {
        supplierId: s._id,
        name: s.name,
        phone: s.phone,
        city: s.city,
        purchaseCount: purchase.count,
        purchaseAmount: purchase.amount,
        purchasePendingAmount: purchase.pendingAmount,
        purchaseReturnCount: purchaseReturn.count,
        purchaseReturnAmount: purchaseReturn.netAmount,
        purchaseReturnPendingAmount: purchaseReturn.pendingAmount,
        netPendingAmount: (purchase.pendingAmount || 0) - (purchaseReturn.pendingAmount || 0),
      };
    });

    res.status(200).json({
      data,
      pagination: { total, page: parsedPage, limit: parsedLimit, totalPages: Math.ceil(total / parsedLimit) },
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

// Shared builder for the 4 line-level transaction reports below — each invoice/
// return is flattened to one row per line, filterable by item/godown (and
// customer/supplier + condition where those fields are real) entirely
// server-side via a single aggregation ($facet gives back data + totals +
// count in one round trip).
async function buildLineReport({
  Model,
  dateField,
  noField,
  match,
  lineMatch,
  lookup,
  extraProject,
  skip,
  limit,
}) {
  const pipeline = [{ $match: match }];
  if (lookup) {
    pipeline.push(
      { $lookup: lookup },
      { $unwind: { path: `$${lookup.as}`, preserveNullAndEmptyArrays: true } }
    );
  }
  // includeArrayIndex gives every unwound line a genuinely unique sort key
  // alongside the parent doc's _id/date (both shared by every sibling line of
  // the same invoice) — without it, $skip/$limit pagination across separate
  // query invocations has no deterministic tie-break between sibling lines,
  // which can show a line twice or skip one across two page loads.
  pipeline.push({ $unwind: { path: "$items", includeArrayIndex: "lineIdx" } });
  if (lineMatch && Object.keys(lineMatch).length) pipeline.push({ $match: lineMatch });
  // Every one of these 4 line-level reports shows an Item Name column, and each
  // one needs its Sub Group alongside it — the line only snapshots itemName, not
  // itemSubGroupId, so it's looked up fresh off the live Item/ItemSubGroup docs
  // (two flat $lookups chained, not a nested pipeline — simplest way to go
  // items.itemId -> Item.itemSubGroupId -> ItemSubGroup.name in a linear stage list).
  pipeline.push(
    { $lookup: { from: "items", localField: "items.itemId", foreignField: "_id", as: "itemMaster" } },
    { $unwind: { path: "$itemMaster", preserveNullAndEmptyArrays: true } },
    { $lookup: { from: "itemsubgroups", localField: "itemMaster.itemSubGroupId", foreignField: "_id", as: "subGroupDoc" } },
    { $unwind: { path: "$subGroupDoc", preserveNullAndEmptyArrays: true } }
  );
  pipeline.push({ $sort: { [dateField]: -1, _id: -1, lineIdx: 1 } });
  pipeline.push({
    $facet: {
      data: [
        { $skip: skip },
        { $limit: limit },
        {
          $project: {
            _id: 0,
            recordId: "$_id",
            [noField]: 1,
            [dateField]: 1,
            itemId: "$items.itemId",
            itemName: "$items.itemName",
            subGroupName: "$subGroupDoc.name",
            godownId: "$items.godownId",
            caseQty: "$items.caseQty",
            pcsQty: "$items.pcsQty",
            // The line already stored its own Case/Pcs, but not the total
            // physical pieces those add up to, nor the packing they were
            // computed against — both are needed to show "N Case + M Pcs
            // (= T pcs)" consistently with the Item/Full reports.
            totalPieces: "$items.totalPieces",
            freeQty: "$items.freeQty",
            packing: "$items.packing",
            taxableValue: "$items.taxableValue",
            gstAmount: "$items.gstAmount",
            netValue: "$items.netValue",
            ...extraProject,
          },
        },
      ],
      totals: [
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            caseQty: { $sum: "$items.caseQty" },
            pcsQty: { $sum: "$items.pcsQty" },
            totalPieces: { $sum: "$items.totalPieces" },
            taxableValue: { $sum: "$items.taxableValue" },
            gstAmount: { $sum: "$items.gstAmount" },
            netValue: { $sum: "$items.netValue" },
          },
        },
      ],
    },
  });

  const [result] = await Model.aggregate(pipeline);
  const data = result?.data || [];
  const totalsRow = result?.totals?.[0] || { count: 0, caseQty: 0, pcsQty: 0, totalPieces: 0, taxableValue: 0, gstAmount: 0, netValue: 0 };
  return { data, totalsRow };
}

function buildLineFilterParams(req) {
  const { companyId, dateFrom, dateTo, itemId, godownId, search = "", page = 1, limit = 20 } = req.query;
  const parsedPage = clampPage(page);
  const parsedLimit = clampLimit(limit, { max: 500, fallback: 20 });
  const lineMatch = {};
  if (itemId && isValidObjectId(itemId)) lineMatch["items.itemId"] = oid(itemId);
  if (godownId && isValidObjectId(godownId)) lineMatch["items.godownId"] = oid(godownId);
  return { companyId, dateFrom, dateTo, search, parsedPage, parsedLimit, lineMatch };
}

// GET /api/reports/purchases?companyId=&dateFrom=&dateTo=&itemId=&godownId=&search=&page=&limit=
const getPurchaseReport = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo, search, parsedPage, parsedLimit, lineMatch } = buildLineFilterParams(req);
    // super_admin calling with no explicit companyId gets `{ $ne: null }` from
    // scopeCompany as its "match any company" sentinel — passing that straight
    // into `new mongoose.Types.ObjectId(...)` throws a raw BSON cast error, a
    // 500. A specific, ObjectId-shaped companyId is required for every report.
    if (!companyId || !isValidObjectId(companyId)) {
      return res.status(400).json({ message: "A specific companyId is required for this report" });
    }

    const match = { companyId: oid(companyId), ...dateRangeFilter("invoiceDate", dateFrom, dateTo) };
    if (search && search.trim()) match.invoiceNo = searchRegex(search.trim());

    const { data, totalsRow } = await buildLineReport({
      Model: Purchase,
      dateField: "invoiceDate",
      noField: "invoiceNo",
      match,
      lineMatch,
      extraProject: { rate: "$items.afterGstRate", amount: "$items.amount" },
      skip: (parsedPage - 1) * parsedLimit,
      limit: parsedLimit,
    });

    res.status(200).json({
      data,
      totals: {
        caseQty: totalsRow.caseQty || 0,
        pcsQty: totalsRow.pcsQty || 0,
        totalPieces: totalsRow.totalPieces || 0,
        taxableValue: round2(totalsRow.taxableValue),
        gstAmount: round2(totalsRow.gstAmount),
        netValue: round2(totalsRow.netValue),
      },
      pagination: { total: totalsRow.count, page: parsedPage, limit: parsedLimit, totalPages: Math.ceil(totalsRow.count / parsedLimit) },
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

// GET /api/reports/sales?companyId=&dateFrom=&dateTo=&itemId=&godownId=&customerId=&search=&page=&limit=
const getSaleReport = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo, search, parsedPage, parsedLimit, lineMatch } = buildLineFilterParams(req);
    const { customerId } = req.query;
    // super_admin calling with no explicit companyId gets `{ $ne: null }` from
    // scopeCompany as its "match any company" sentinel — passing that straight
    // into `new mongoose.Types.ObjectId(...)` throws a raw BSON cast error, a
    // 500. A specific, ObjectId-shaped companyId is required for every report.
    if (!companyId || !isValidObjectId(companyId)) {
      return res.status(400).json({ message: "A specific companyId is required for this report" });
    }

    const match = { companyId: oid(companyId), ...dateRangeFilter("invoiceDate", dateFrom, dateTo) };
    if (search && search.trim()) match.invoiceNo = searchRegex(search.trim());
    if (customerId && isValidObjectId(customerId)) match.customerId = oid(customerId);

    const { data, totalsRow } = await buildLineReport({
      Model: Sale,
      dateField: "invoiceDate",
      noField: "invoiceNo",
      match,
      lineMatch,
      lookup: { from: "customers", localField: "customerId", foreignField: "_id", as: "customer" },
      extraProject: { rate: "$items.afterGstRate", amount: "$items.amount", customerName: "$customer.name" },
      skip: (parsedPage - 1) * parsedLimit,
      limit: parsedLimit,
    });

    res.status(200).json({
      data,
      totals: {
        caseQty: totalsRow.caseQty || 0,
        pcsQty: totalsRow.pcsQty || 0,
        totalPieces: totalsRow.totalPieces || 0,
        taxableValue: round2(totalsRow.taxableValue),
        gstAmount: round2(totalsRow.gstAmount),
        netValue: round2(totalsRow.netValue),
      },
      pagination: { total: totalsRow.count, page: parsedPage, limit: parsedLimit, totalPages: Math.ceil(totalsRow.count / parsedLimit) },
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

// GET /api/reports/purchase-returns?companyId=&dateFrom=&dateTo=&itemId=&godownId=&supplierId=&condition=&search=&page=&limit=
const getPurchaseReturnReport = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo, search, parsedPage, parsedLimit, lineMatch } = buildLineFilterParams(req);
    const { supplierId, condition } = req.query;
    // super_admin calling with no explicit companyId gets `{ $ne: null }` from
    // scopeCompany as its "match any company" sentinel — passing that straight
    // into `new mongoose.Types.ObjectId(...)` throws a raw BSON cast error, a
    // 500. A specific, ObjectId-shaped companyId is required for every report.
    if (!companyId || !isValidObjectId(companyId)) {
      return res.status(400).json({ message: "A specific companyId is required for this report" });
    }

    const match = { companyId: oid(companyId), ...dateRangeFilter("returnDate", dateFrom, dateTo) };
    if (search && search.trim()) match.returnNo = searchRegex(search.trim());
    if (supplierId && isValidObjectId(supplierId)) match.supplierId = oid(supplierId);
    if (condition) lineMatch["items.condition"] = condition;

    const { data, totalsRow } = await buildLineReport({
      Model: PurchaseReturn,
      dateField: "returnDate",
      noField: "returnNo",
      match,
      lineMatch,
      lookup: { from: "suppliers", localField: "supplierId", foreignField: "_id", as: "supplier" },
      extraProject: { rate: "$items.afterGstRate", amount: "$items.amount", condition: "$items.condition", supplierName: "$supplier.name" },
      skip: (parsedPage - 1) * parsedLimit,
      limit: parsedLimit,
    });

    res.status(200).json({
      data,
      totals: {
        caseQty: totalsRow.caseQty || 0,
        pcsQty: totalsRow.pcsQty || 0,
        totalPieces: totalsRow.totalPieces || 0,
        taxableValue: round2(totalsRow.taxableValue),
        gstAmount: round2(totalsRow.gstAmount),
        netValue: round2(totalsRow.netValue),
      },
      pagination: { total: totalsRow.count, page: parsedPage, limit: parsedLimit, totalPages: Math.ceil(totalsRow.count / parsedLimit) },
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

// GET /api/reports/sale-returns?companyId=&dateFrom=&dateTo=&itemId=&godownId=&customerId=&condition=&search=&page=&limit=
const getSaleReturnReport = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo, search, parsedPage, parsedLimit, lineMatch } = buildLineFilterParams(req);
    const { customerId, condition } = req.query;
    // super_admin calling with no explicit companyId gets `{ $ne: null }` from
    // scopeCompany as its "match any company" sentinel — passing that straight
    // into `new mongoose.Types.ObjectId(...)` throws a raw BSON cast error, a
    // 500. A specific, ObjectId-shaped companyId is required for every report.
    if (!companyId || !isValidObjectId(companyId)) {
      return res.status(400).json({ message: "A specific companyId is required for this report" });
    }

    const match = { companyId: oid(companyId), ...dateRangeFilter("returnDate", dateFrom, dateTo) };
    if (search && search.trim()) match.returnNo = searchRegex(search.trim());
    if (customerId && isValidObjectId(customerId)) match.customerId = oid(customerId);
    if (condition) lineMatch["items.condition"] = condition;

    const { data, totalsRow } = await buildLineReport({
      Model: SaleReturn,
      dateField: "returnDate",
      noField: "returnNo",
      match,
      lineMatch,
      lookup: { from: "customers", localField: "customerId", foreignField: "_id", as: "customer" },
      extraProject: { rate: "$items.afterGstRate", amount: "$items.amount", condition: "$items.condition", customerName: "$customer.name" },
      skip: (parsedPage - 1) * parsedLimit,
      limit: parsedLimit,
    });

    res.status(200).json({
      data,
      totals: {
        caseQty: totalsRow.caseQty || 0,
        pcsQty: totalsRow.pcsQty || 0,
        totalPieces: totalsRow.totalPieces || 0,
        taxableValue: round2(totalsRow.taxableValue),
        gstAmount: round2(totalsRow.gstAmount),
        netValue: round2(totalsRow.netValue),
      },
      pagination: { total: totalsRow.count, page: parsedPage, limit: parsedLimit, totalPages: Math.ceil(totalsRow.count / parsedLimit) },
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

// Shared chronological-ledger builder. Every Sale/Purchase/Return contributes
// its own NET amount (gross, dated) as a debit or credit — this is a real,
// date-ordered ledger of invoice activity, not a payment-by-payment statement,
// because this app has no separate payment-voucher/date to hang a partial
// settlement on (see CLAUDE.md "Accounts — entirely missing"). Each row still
// carries its own `pendingAmount` for reference so outstanding invoices are
// visible without conflating them into the dated running balance.
// `debitIncreases` flips which column drives the running balance up: true for a
// debtor ledger (Customer — a Sale/debit increases what they owe), false for a
// creditor ledger (Supplier — a Purchase/credit increases what we owe them). The
// `debit`/`credit` fields on each entry always keep their standard accounting
// meaning regardless of this flag — only the arithmetic direction changes.
function buildLedger(entries, dateFrom, dateTo, { debitIncreases = true } = {}) {
  entries.sort((a, b) => new Date(a.date) - new Date(b.date));
  const from = dateFrom ? new Date(`${dateFrom}T00:00:00.000Z`) : null;
  const to = dateTo ? new Date(`${dateTo}T23:59:59.999Z`) : null;
  const delta = (e) => (debitIncreases ? e.debit - e.credit : e.credit - e.debit);

  let openingBalance = 0;
  const inRange = [];
  entries.forEach((e) => {
    const d = new Date(e.date);
    if (from && d < from) {
      openingBalance += delta(e);
    } else if (to && d > to) {
      // after range — excluded entirely, doesn't affect opening or closing
    } else {
      inRange.push(e);
    }
  });

  openingBalance = round2(openingBalance);
  let running = openingBalance;
  const rows = inRange.map((e) => {
    running = round2(running + delta(e));
    return { ...e, balance: running };
  });

  return { openingBalance, closingBalance: running, entries: rows };
}

// A Payment's Ref No for ledger display: its own referenceNo field if set,
// else a join of whatever Narration codes are attached to it (the closest
// thing this app has to a reference for a payment that predates the
// referenceNo field actually being persisted — see Payment.js's schema
// comment, referenceNo/notes were read+written by paymentController from the
// start but silently dropped by Mongoose since neither was ever declared on
// the schema until this ledger fix). "-" only when genuinely neither exists.
function paymentRef(p) {
  if (p.referenceNo) return p.referenceNo;
  return "-";
}

// Shared by getCustomerLedger and exportCustomerLedger — fetches the party and
// every raw (unfiltered-by-date) entry; date filtering happens in buildLedger.
//
// ⚠️→✅ Now also pulls real Payment-voucher rows (both the auto-created
// advance-payment Payments quirk #53/#54 wired into Sale/SaleReturn's own
// create path, AND standalone payments entered via the /payments page) — a
// payment is a genuinely separate, dated event from the invoice it settles,
// exactly like Tally's own General Account Ledger shows both a "General
// Sales" bill row AND a separate "Customer Receipt" row for the same party.
// This closes a real reported bug: a payment recorded via the Payments page
// against a Customer/Supplier was invisible in that party's own Ledger —
// only the underlying Sale/Purchase's `pendingAmount` reflected it, with no
// dated row of its own. Doesn't double-count anything — the invoice's own
// entry is still its full gross `netAmount`, unaffected by how much of it has
// since been paid; the Payment entry is the separate cash-movement event.
async function loadCustomerLedgerEntries(companyId, customerId) {
  const customer = await Customer.findOne({ _id: customerId, companyId }).lean();
  if (!customer) return null;

  const [sales, saleReturns, openingBills, payments] = await Promise.all([
    Sale.find({ companyId, customerId }).select("invoiceNo invoiceDate netAmount pendingAmount narrations").lean(),
    SaleReturn.find({ companyId, customerId }).select("returnNo returnDate netAmount pendingAmount narrations").lean(),
    OpeningBill.find({ companyId, type: "sale", customerId }).select("billNo billDate totalAmount pendingAmount").lean(),
    Payment.find({ companyId, partyType: "Customer", partyId: customerId })
      .select("paymentType paymentDate amount referenceNo narrations allocations notes bankAccountId paymentMode")
      .populate("bankAccountId", "bankName accountNumber")
      .lean(),
  ]);

  const billMap = new Map();
  sales.forEach((s) => billMap.set(String(s._id), { billNo: s.invoiceNo, type: "Sale", id: s._id }));
  saleReturns.forEach((sr) => billMap.set(String(sr._id), { billNo: sr.returnNo, type: "Sale Return", id: sr._id }));
  openingBills.forEach((ob) => billMap.set(String(ob._id), { billNo: ob.billNo, type: "Opening Balance", id: ob._id }));

  const remainingIds = [];
  for (const p of payments) {
    for (const a of (p.allocations || [])) {
      if (a.invoiceId && !billMap.has(String(a.invoiceId))) {
        remainingIds.push(a.invoiceId);
      }
    }
  }
  if (remainingIds.length > 0) {
    const extraSales = await Sale.find({ _id: { $in: remainingIds } }).select("_id invoiceNo").lean();
    extraSales.forEach((s) => billMap.set(String(s._id), { billNo: s.invoiceNo, type: "Sale", id: s._id }));
  }

  const entries = [
    ...openingBills.map((b) => ({
      date: b.billDate,
      type: "Opening Balance",
      particulars: "Opening Balance",
      vchType: "",
      vchNo: b.billNo || "-",
      opposingDrCr: "Cr",
      ref: b.billNo,
      id: b._id,
      debit: b.totalAmount,
      credit: 0,
      pendingAmount: b.pendingAmount,
      narrations: [],
      bills: [],
    })),
    ...sales.map((s) => {
      const narText = Array.isArray(s.narrations) && s.narrations.length > 0
        ? s.narrations.map((n) => (typeof n === "string" ? n : n.code || n.type)).filter(Boolean).join(", ")
        : "";
      return {
        date: s.invoiceDate,
        type: "Sale",
        particulars: narText || "Sales Account",
        vchType: "Sale",
        vchNo: s.invoiceNo,
        opposingDrCr: "Cr",
        ref: s.invoiceNo,
        id: s._id,
        debit: s.netAmount,
        credit: 0,
        pendingAmount: s.pendingAmount,
        narrations: s.narrations || [],
        bills: [],
      };
    }),
    ...saleReturns.map((r) => ({
      date: r.returnDate,
      type: "Sale Return",
      particulars: "Sale Return",
      vchType: "Credit Note",
      vchNo: r.returnNo,
      opposingDrCr: "Dr",
      ref: r.returnNo,
      id: r._id,
      debit: 0,
      credit: r.netAmount,
      pendingAmount: r.pendingAmount,
      narrations: r.narrations || [],
      bills: [],
    })),
    ...payments.map((p) => {
      let bills = (p.allocations || [])
        .map((a) => {
          const match = billMap.get(String(a.invoiceId));
          if (!match) return null;
          return {
            id: String(match.id),
            billNo: match.billNo,
            type: match.type,
            allocatedAmount: a.allocatedAmount,
          };
        })
        .filter(Boolean);

      if (bills.length === 0 && p.notes) {
        const m = p.notes.match(/Invoice\s+([A-Za-z0-9_-]+)/i);
        if (m) {
          const found = [...billMap.values()].find((b) => String(b.billNo) === m[1]);
          bills = [{ id: found ? String(found.id) : null, billNo: m[1], type: "Sale", allocatedAmount: p.amount }];
        }
      }

      const bankName = p.bankAccountId?.bankName || (p.paymentMode === "Cash" ? "Cash" : "Bank");
      const isReceive = p.paymentType === "Receive";

      return {
        date: p.paymentDate,
        type: isReceive ? "Payment Received" : "Payment Paid",
        particulars: bankName || (isReceive ? "Receipt" : "Payment"),
        vchType: isReceive ? "Receipt" : "Payment",
        vchNo: paymentRef(p),
        opposingDrCr: isReceive ? "Dr" : "Cr",
        ref: paymentRef(p),
        id: p._id,
        debit: !isReceive ? p.amount : 0,
        credit: isReceive ? p.amount : 0,
        pendingAmount: null,
        narrations: p.narrations || [],
        bills,
      };
    }),
  ];

  return { party: customer, entries };
}

// GET /api/reports/customer-ledger/:customerId?companyId=&dateFrom=&dateTo=
// Debit increases what the customer owes (Sale, opening balance); credit
// decreases it (Sale Return) — standard debtor-ledger convention.
const getCustomerLedger = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo } = req.query;
    const { customerId } = req.params;
    // super_admin calling with no explicit companyId gets `{ $ne: null }` from
    // scopeCompany as its "match any company" sentinel — passing that straight
    // into `new mongoose.Types.ObjectId(...)` throws a raw BSON cast error, a
    // 500. A specific, ObjectId-shaped companyId is required for every report.
    if (!companyId || !isValidObjectId(companyId)) {
      return res.status(400).json({ message: "A specific companyId is required for this report" });
    }
    if (!isValidObjectId(customerId)) return res.status(400).json({ message: "Invalid customer id" });

    const loaded = await loadCustomerLedgerEntries(companyId, customerId);
    if (!loaded) return res.status(404).json({ message: "Customer not found" });

    const ledger = buildLedger(loaded.entries, dateFrom, dateTo);
    const customer = loaded.party;

    res.status(200).json({
      party: {
        id: customer._id,
        name: customer.name,
        phone: customer.phone,
        gstNo: customer.gstNo,
        city: customer.city,
        address: customer.address,
        state: customer.state,
        pincode: customer.pincode,
      },
      ...ledger,
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

// Shared by getSupplierLedger and exportSupplierLedger.
async function loadSupplierLedgerEntries(companyId, supplierId) {
  const supplier = await Supplier.findOne({ _id: supplierId, companyId }).lean();
  if (!supplier) return null;

  const supplierItemIds = (await Item.find({ companyId, supplierId }).select("_id").lean()).map((i) => i._id);

  const purchaseRows = supplierItemIds.length
    ? await Purchase.aggregate([
        { $match: { companyId: oid(companyId) } },
        { $unwind: "$items" },
        { $match: { "items.itemId": { $in: supplierItemIds } } },
        {
          $group: {
            _id: "$_id",
            invoiceNo: { $first: "$invoiceNo" },
            invoiceDate: { $first: "$invoiceDate" },
            amount: { $sum: "$items.netValue" },
            narrations: { $first: "$narrations" },
          },
        },
      ])
    : [];

  const [purchaseReturns, openingBills, payments] = await Promise.all([
    PurchaseReturn.find({ companyId, supplierId }).select("returnNo returnDate netAmount pendingAmount narrations").lean(),
    OpeningBill.find({ companyId, type: "purchase", supplierId }).select("billNo billDate totalAmount pendingAmount").lean(),
    Payment.find({ companyId, partyType: "Supplier", partyId: supplierId })
      .select("paymentType paymentDate amount referenceNo narrations allocations notes bankAccountId paymentMode")
      .populate("bankAccountId", "bankName accountNumber")
      .lean(),
  ]);

  const billMap = new Map();
  purchaseRows.forEach((pr) => billMap.set(String(pr._id), { billNo: pr.invoiceNo, type: "Purchase", id: pr._id }));
  purchaseReturns.forEach((pr) => billMap.set(String(pr._id), { billNo: pr.returnNo, type: "Purchase Return", id: pr._id }));
  openingBills.forEach((ob) => billMap.set(String(ob._id), { billNo: ob.billNo, type: "Opening Balance", id: ob._id }));

  const remainingIds = [];
  for (const p of payments) {
    for (const a of (p.allocations || [])) {
      if (a.invoiceId && !billMap.has(String(a.invoiceId))) {
        remainingIds.push(a.invoiceId);
      }
    }
  }
  if (remainingIds.length > 0) {
    const extraPurchases = await Purchase.find({ _id: { $in: remainingIds } }).select("_id invoiceNo").lean();
    extraPurchases.forEach((pr) => billMap.set(String(pr._id), { billNo: pr.invoiceNo, type: "Purchase", id: pr._id }));
  }

  const entries = [
    ...openingBills.map((b) => ({
      date: b.billDate,
      type: "Opening Balance",
      particulars: "Opening Balance",
      vchType: "",
      vchNo: b.billNo || "-",
      opposingDrCr: "Dr",
      ref: b.billNo,
      id: b._id,
      debit: 0,
      credit: b.totalAmount,
      pendingAmount: b.pendingAmount,
      narrations: [],
      bills: [],
    })),
    ...purchaseRows.map((p) => {
      const narText = Array.isArray(p.narrations) && p.narrations.length > 0
        ? p.narrations.map((n) => (typeof n === "string" ? n : n.code || n.type)).filter(Boolean).join(", ")
        : "";
      return {
        date: p.invoiceDate,
        type: "Purchase",
        particulars: narText || "TRANSPORT FREIGHT (18%)",
        vchType: "Purchase",
        vchNo: p.invoiceNo,
        opposingDrCr: "Dr",
        ref: p.invoiceNo,
        id: p._id,
        debit: 0,
        credit: p.amount,
        pendingAmount: null,
        narrations: p.narrations || [],
        bills: [],
      };
    }),
    ...purchaseReturns.map((r) => ({
      date: r.returnDate,
      type: "Purchase Return",
      particulars: "Purchase Return",
      vchType: "Debit Note",
      vchNo: r.returnNo,
      opposingDrCr: "Cr",
      ref: r.returnNo,
      id: r._id,
      debit: r.netAmount,
      credit: 0,
      pendingAmount: r.pendingAmount,
      narrations: r.narrations || [],
      bills: [],
    })),
    ...payments.map((p) => {
      let bills = (p.allocations || [])
        .map((a) => {
          const match = billMap.get(String(a.invoiceId));
          if (!match) return null;
          return {
            id: String(match.id),
            billNo: match.billNo,
            type: match.type,
            allocatedAmount: a.allocatedAmount,
          };
        })
        .filter(Boolean);

      if (bills.length === 0 && p.notes) {
        const m = p.notes.match(/Invoice\s+([A-Za-z0-9_-]+)/i);
        if (m) {
          const found = [...billMap.values()].find((b) => String(b.billNo) === m[1]);
          bills = [{ id: found ? String(found.id) : null, billNo: m[1], type: "Purchase", allocatedAmount: p.amount }];
        }
      }

      const bankName = p.bankAccountId?.bankName || (p.paymentMode === "Cash" ? "Cash" : "Bank of India");
      const isPay = p.paymentType === "Pay";

      return {
        date: p.paymentDate,
        type: isPay ? "Payment Paid" : "Payment Received",
        particulars: bankName || (isPay ? "Payment" : "Receipt"),
        vchType: isPay ? "Payment" : "Receipt",
        vchNo: paymentRef(p),
        opposingDrCr: isPay ? "Cr" : "Dr",
        ref: paymentRef(p),
        id: p._id,
        debit: isPay ? p.amount : 0,
        credit: !isPay ? p.amount : 0,
        pendingAmount: null,
        narrations: p.narrations || [],
        bills,
      };
    }),
  ];

  return { party: supplier, entries };
}

// GET /api/reports/supplier-ledger/:supplierId?companyId=&dateFrom=&dateTo=
// Credit increases what we owe the supplier (Purchase, opening balance); debit
// decreases it (Purchase Return) — standard creditor-ledger convention.
const getSupplierLedger = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo } = req.query;
    const { supplierId } = req.params;
    // super_admin calling with no explicit companyId gets `{ $ne: null }` from
    // scopeCompany as its "match any company" sentinel — passing that straight
    // into `new mongoose.Types.ObjectId(...)` throws a raw BSON cast error, a
    // 500. A specific, ObjectId-shaped companyId is required for every report.
    if (!companyId || !isValidObjectId(companyId)) {
      return res.status(400).json({ message: "A specific companyId is required for this report" });
    }
    if (!isValidObjectId(supplierId)) return res.status(400).json({ message: "Invalid supplier id" });

    const loaded = await loadSupplierLedgerEntries(companyId, supplierId);
    if (!loaded) return res.status(404).json({ message: "Supplier not found" });

    const ledger = buildLedger(loaded.entries, dateFrom, dateTo, { debitIncreases: false });
    const supplier = loaded.party;

    res.status(200).json({
      party: {
        id: supplier._id,
        name: supplier.name,
        phone: supplier.phone,
        gstNo: supplier.gstNo,
        city: supplier.city,
        address: supplier.address,
        state: supplier.state,
        pincode: supplier.pincode,
      },
      ...ledger,
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

// Splits a (possibly negative) total-pieces figure into whole Case + a
// remainder of loose Pcs via truncation-toward-zero, NOT `lib/stock.ts`'s own
// `Math.floor`-based `splitCasePcs` — this deliberately reproduces the exact
// behavior of the legacy "Full Report" stock-summary export the user supplied
// as a reference (a genuinely negative closing figure, e.g. a company that
// oversold before this system's own oversell-guards existed, showed as Case 0
// / Pcs -1 in that file, not Case -1 / Pcs 19 the way Math.floor would split
// it) — confirmed by re-deriving that file's own numbers from its column
// values before writing this.
function splitCasePcsTrunc(totalPcs, packing) {
  const p = packing || 1;
  const caseQty = Math.trunc(totalPcs / p);
  return { caseQty, pcs: totalPcs - caseQty * p };
}

const FULL_STOCK_ROW_CAP = 5000;

// GET/export shared builder for the "Full Report" — a comprehensive per-item
// stock movement report grouped by Supplier (the "group" concept; ItemGroup
// itself no longer exists, Supplier absorbed that role, see CLAUDE.md), with
// a subtotal row per group and one grand-total row. Modeled directly on a
// legacy stock-summary export the user supplied as a reference: its own
// column layout is group/itcod/hsncode/item/unit/weight/packing/opening/
// purchase/sale/closing, with opening/purchase/sale/closing EACH also split
// into its own case+pcs pair, plus mrp_rate/rate/value.
//
// Not paginated — every matching item is loaded in one response (capped),
// the same design as the Customer/Supplier Ledgers, because group and grand
// totals need the full filtered set, not just one page.
//
// "Opening" is computed as of dateFrom — not just the item's flat entered
// opening stock — by adding every purchase/sale/return dated BEFORE dateFrom
// (mirrors `buildLedger`'s own openingBalance-before-range accumulation). With
// no dateFrom, Opening is simply the flat entered value and Purchase/Sale
// below cover all-time.
//
// Purchase and Sale are each netted against their own Return type within the
// range (Purchase − PurchaseReturn, Sale − SaleReturn) specifically so
// Closing = Opening + Purchase − Sale holds exactly — verified against the
// reference file's own GROUP TOTAL/GRAND TOTAL rows, which have no separate
// Return columns at all (that legacy software either never used returns or
// netted them directly) — while still correctly accounting for this app's
// real, separate Purchase Return / Sale Return modules.
async function buildFullStockReport(query, { cap = FULL_STOCK_ROW_CAP } = {}) {
  const { companyId, dateFrom, dateTo, supplierId, search = "" } = query;

  const itemQuery = { companyId };
  if (supplierId && isValidObjectId(supplierId)) itemQuery.supplierId = oid(supplierId);
  if (search && search.trim()) itemQuery.itemName = searchRegex(search.trim());

  const items = await Item.find(itemQuery).populate("supplierId", "name").sort({ itemName: 1 }).limit(cap).lean();
  const itemIds = items.map((i) => i._id);

  async function sumPiecesByItem(Model, dateFilter, lineMatch) {
    if (!itemIds.length || !dateFilter) return new Map();
    const rows = await Model.aggregate([
      { $match: { companyId: oid(companyId), ...dateFilter } },
      { $unwind: "$items" },
      { $match: { "items.itemId": { $in: itemIds }, ...(lineMatch || {}) } },
      { $group: { _id: "$items.itemId", pcs: { $sum: "$items.totalPieces" } } },
    ]);
    return new Map(rows.map((r) => [String(r._id), r.pcs]));
  }

  // Every figure in this report is derived from `openingStockFreshPcs`, but Sale
  // Return is the one module whose lines don't all land there: its applyOneLine
  // routes each line into the Fresh/Expired/Damaged bucket by its own
  // `condition`, so an Expired or Damaged return never moves the Fresh total.
  // Counting those lines here understated Opening by exactly their pieces (and,
  // once a dateTo was set, Closing too). `$nin` rather than `=== "Fresh"` so a
  // legacy line with no condition stored is treated as Fresh, matching
  // applyOneLine's own fallback. Purchase/Sale/Purchase Return all move the
  // Fresh bucket unconditionally and so need no equivalent filter.
  const freshLinesOnly = { "items.condition": { $nin: ["Expired", "Damaged"] } };

  // `item.openingStockFreshPcs` is NOT a frozen historical baseline — it's the
  // item's CURRENT, continuously-updated total stock (every Purchase/Sale/
  // Return's applyStockDelta increments it in place; see the Multi-Godown Stock
  // section's "flat fields are the source of truth" invariant). It already
  // reflects every purchase/sale/return ever made against this item, including
  // everything before dateFrom. So "Opening as of dateFrom" can't be computed
  // by ADDING pre-dateFrom deltas on top of it (that double-counts them) — it
  // has to be computed by WALKING BACKWARD from the current total, subtracting
  // out everything dated on-or-after dateFrom (with no upper bound — dateTo
  // only scopes the "Purchase"/"Sale" columns shown in the report body, not
  // this baseline). When dateFrom itself is unset, "on or after" is unbounded
  // in both directions too — i.e. all-time — which correctly derives the
  // item's true original baseline (before any transaction ever touched it).
  const fromDate = dateFrom ? new Date(`${dateFrom}T00:00:00.000Z`) : null;
  const onOrAfterFrom = (field) => (fromDate ? { [field]: { $gte: fromDate } } : {});

  const [purchaseFromMap, saleFromMap, pReturnFromMap, sReturnFromMap, purchaseInMap, saleInMap, pReturnInMap, sReturnInMap] =
    await Promise.all([
      sumPiecesByItem(Purchase, onOrAfterFrom("invoiceDate")),
      sumPiecesByItem(Sale, onOrAfterFrom("invoiceDate")),
      sumPiecesByItem(PurchaseReturn, onOrAfterFrom("returnDate")),
      sumPiecesByItem(SaleReturn, onOrAfterFrom("returnDate"), freshLinesOnly),
      sumPiecesByItem(Purchase, dateRangeFilter("invoiceDate", dateFrom, dateTo)),
      sumPiecesByItem(Sale, dateRangeFilter("invoiceDate", dateFrom, dateTo)),
      sumPiecesByItem(PurchaseReturn, dateRangeFilter("returnDate", dateFrom, dateTo)),
      sumPiecesByItem(SaleReturn, dateRangeFilter("returnDate", dateFrom, dateTo), freshLinesOnly),
    ]);

  const rowsRaw = items.map((item) => {
    const id = String(item._id);
    const openingPcs =
      (item.openingStockFreshPcs || 0) -
      (purchaseFromMap.get(id) || 0) +
      (saleFromMap.get(id) || 0) +
      (pReturnFromMap.get(id) || 0) -
      (sReturnFromMap.get(id) || 0);

    const purchasePcs = (purchaseInMap.get(id) || 0) - (pReturnInMap.get(id) || 0);
    const salePcs = (saleInMap.get(id) || 0) - (sReturnInMap.get(id) || 0);
    const closingPcs = openingPcs + purchasePcs - salePcs;

    const packing = item.packing || 1;
    const opening = splitCasePcsTrunc(openingPcs, packing);
    const purchase = splitCasePcsTrunc(purchasePcs, packing);
    const sale = splitCasePcsTrunc(salePcs, packing);
    const closing = splitCasePcsTrunc(closingPcs, packing);

    // `lastCostRate`/`purchaseRate` are on the item's own `purchaseQty` basis
    // (e.g. "cost per Carton of N pieces"), same convention as
    // `purchaseController.computeLine`'s own `pricePerPiece = rate/purchaseQty`
    // — divide down to a per-piece rate before multiplying by a piece count.
    const rate = item.lastCostRate || 0;
    const ratePerPiece = rate / (item.purchaseQty || 1);

    return {
      itemId: item._id,
      groupName: item.supplierId?.name || "Ungrouped",
      itemCode: item.codeBarCode || "",
      hsnCode: item.hsnCode || "",
      itemName: item.itemName,
      unit: item.uqcUnit || "",
      weight: item.weightPerPiece || 0,
      packing,
      openingPcs,
      purchasePcs,
      salePcs,
      closingPcs,
      openingCase: opening.caseQty,
      openingLoosePcs: opening.pcs,
      purchaseCase: purchase.caseQty,
      purchaseLoosePcs: purchase.pcs,
      saleCase: sale.caseQty,
      saleLoosePcs: sale.pcs,
      closingCase: closing.caseQty,
      closingLoosePcs: closing.pcs,
      mrpRate: item.mrp || 0,
      rate,
      value: closingPcs * ratePerPiece,
      // The report already carried a per-piece Weight column but never
      // totalled it anywhere — so the one question a stock report with a
      // Weight column exists to answer ("how much does the stock on hand
      // weigh?") had no answer. Closing weight closes that gap and, unlike
      // Case/Loose, is genuinely additive across items of different packing,
      // so its group/grand totals are meaningful.
      closingWeight: closingPcs * (item.weightPerPiece || 0),
    };
  });

  const groupMap = new Map();
  rowsRaw.forEach((r) => {
    if (!groupMap.has(r.groupName)) groupMap.set(r.groupName, []);
    groupMap.get(r.groupName).push(r);
  });

  function sumRows(rows) {
    const s = {
      openingPcs: 0, purchasePcs: 0, salePcs: 0, closingPcs: 0,
      openingCase: 0, openingLoosePcs: 0, purchaseCase: 0, purchaseLoosePcs: 0,
      saleCase: 0, saleLoosePcs: 0, closingCase: 0, closingLoosePcs: 0,
      value: 0, closingWeight: 0,
    };
    rows.forEach((r) => {
      s.openingPcs += r.openingPcs; s.purchasePcs += r.purchasePcs; s.salePcs += r.salePcs; s.closingPcs += r.closingPcs;
      s.openingCase += r.openingCase; s.openingLoosePcs += r.openingLoosePcs;
      s.purchaseCase += r.purchaseCase; s.purchaseLoosePcs += r.purchaseLoosePcs;
      s.saleCase += r.saleCase; s.saleLoosePcs += r.saleLoosePcs;
      s.closingCase += r.closingCase; s.closingLoosePcs += r.closingLoosePcs;
      s.value += r.value;
      s.closingWeight += r.closingWeight;
    });
    return s;
  }

  const groups = Array.from(groupMap.keys())
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const rows = groupMap.get(name);
      return { groupName: name, rows, total: sumRows(rows) };
    });

  return { groups, grandTotal: sumRows(rowsRaw), itemCount: rowsRaw.length };
}

// GET /api/reports/full-stock?companyId=&dateFrom=&dateTo=&supplierId=&search=
const getFullStockReport = async (req, res) => {
  try {
    const { companyId } = req.query;
    // super_admin calling with no explicit companyId gets `{ $ne: null }` from
    // scopeCompany as its "match any company" sentinel — passing that straight
    // into `new mongoose.Types.ObjectId(...)` throws a raw BSON cast error, a
    // 500. A specific, ObjectId-shaped companyId is required for every report.
    if (!companyId || !isValidObjectId(companyId)) {
      return res.status(400).json({ message: "A specific companyId is required for this report" });
    }
    const result = await buildFullStockReport(req.query);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

// GET /api/reports/full-stock/export?companyId=&dateFrom=&dateTo=&supplierId=&search=
const exportFullStockReport = async (req, res) => {
  try {
    const { companyId } = req.query;
    // super_admin calling with no explicit companyId gets `{ $ne: null }` from
    // scopeCompany as its "match any company" sentinel — passing that straight
    // into `new mongoose.Types.ObjectId(...)` throws a raw BSON cast error, a
    // 500. A specific, ObjectId-shaped companyId is required for every report.
    if (!companyId || !isValidObjectId(companyId)) {
      return res.status(400).json({ message: "A specific companyId is required for this report" });
    }
    const { groups, grandTotal } = await buildFullStockReport(req.query, { cap: EXPORT_ROW_CAP });

    // PDF path. Hand-built like the Excel one rather than going through
    // sendReportFile/drawDataTable, for the same reason the Excel sheet is
    // hand-built: this report has TWO tiers of total row (a GROUP TOTAL after
    // every supplier, then one GRAND TOTAL) and the shared table helper only
    // knows how to append a single trailing total.
    if (String(req.query.format || "").toLowerCase() === "pdf") {
      const company = await loadCompanyLetterhead(req);
      const fsCols = [
        { header: "Item Code", width: 52, accessor: (r) => r.itemCode || "-" },
        { header: "Item", width: 104, accessor: (r) => r.itemName },
        { header: "Unit", width: 32, accessor: (r) => r.unit || "-" },
        { header: "Pack", width: 30, accessor: (r) => r.packing, align: "right" },
        { header: "Opening", width: 58, accessor: (r) => caseLooseText(r.openingCase, r.openingLoosePcs), align: "right" , qtyLegend: true },
        { header: "Purchase", width: 58, accessor: (r) => caseLooseText(r.purchaseCase, r.purchaseLoosePcs), align: "right" , qtyLegend: true },
        { header: "Sale", width: 58, accessor: (r) => caseLooseText(r.saleCase, r.saleLoosePcs), align: "right" , qtyLegend: true },
        { header: "Closing", width: 58, accessor: (r) => caseLooseText(r.closingCase, r.closingLoosePcs), align: "right" , qtyLegend: true },
        { header: "MRP", width: 42, accessor: (r) => (r.mrpRate ? fmtNum(r.mrpRate) : "-"), align: "right" },
        { header: "Rate", width: 48, accessor: (r) => (r.rate ? fmtNum(r.rate) : "-"), align: "right" },
        { header: "Value", width: 60, accessor: (r) => fmtNum(r.value), align: "right" },
        { header: "Clsg Wt", width: 48, accessor: (r) => fmtNum(r.closingWeight, 3), align: "right" },
      ];
      // One flat record list with a marker row after each group, so the
      // shared drawDataTable pagination still applies to the whole thing.
      const flat = [];
      groups.forEach((g) => {
        g.rows.forEach((r) => flat.push(r));
        flat.push({ ...g.total, itemCode: "", itemName: `${g.groupName} — GROUP TOTAL`, unit: "", packing: "", mrpRate: 0, rate: 0, __isTotal: true });
      });
      flat.push({ ...grandTotal, itemCode: "", itemName: "GRAND TOTAL", unit: "", packing: "", mrpRate: 0, rate: 0, __isTotal: true });
      return sendPdfFile(res, "Full Stock Report", fsCols, flat, "Full_Stock_Report.pdf", company);
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Full Stock Report");
    const headers = [
      "Group", "Item Code", "HSN Code", "Item", "Unit", "Weight", "Packing",
      "Opening", "Purchase", "Sale", "Closing",
      "Opng Case", "Opng Pcs", "Purc Case", "Purc Pcs", "Sale Case", "Sale Pcs", "Clsg Case", "Clsg Pcs",
      "MRP Rate", "Rate", "Value", "Closing Weight",
    ];
    sheet.addRow(headers);
    styleHeaderRow(sheet.getRow(1));
    sheet.columns.forEach((col) => { col.width = 13; });
    sheet.getColumn(4).width = 28;

    const rowValues = (r) => [
      r.groupName, r.itemCode, r.hsnCode, r.itemName, r.unit, r.weight, r.packing,
      r.openingPcs, r.purchasePcs, r.salePcs, r.closingPcs,
      r.openingCase, r.openingLoosePcs, r.purchaseCase, r.purchaseLoosePcs,
      r.saleCase, r.saleLoosePcs, r.closingCase, r.closingLoosePcs,
      r.mrpRate, r.rate, Number(r.value.toFixed(2)), Number((r.closingWeight || 0).toFixed(3)),
    ];
    const totalValues = (label, t) => [
      label, "", "", "", "", "", "",
      t.openingPcs, t.purchasePcs, t.salePcs, t.closingPcs,
      t.openingCase, t.openingLoosePcs, t.purchaseCase, t.purchaseLoosePcs,
      t.saleCase, t.saleLoosePcs, t.closingCase, t.closingLoosePcs,
      "", "", Number(t.value.toFixed(2)), Number((t.closingWeight || 0).toFixed(3)),
    ];

    groups.forEach((g) => {
      g.rows.forEach((r) => sheet.addRow(rowValues(r)));
      const totalRow = sheet.addRow(totalValues(`${g.groupName} - GROUP TOTAL`, g.total));
      // Group subtotals use the soft brand tint; the GRAND TOTAL below uses
      // the full brand fill so the two tiers stay visually distinct.
      totalRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: XLSX.bodyText } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XLSX.groupBg } };
      });
    });
    const grandRow = sheet.addRow(totalValues("GRAND TOTAL", grandTotal));
    styleTotalRow(grandRow);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Full_Stock_Report.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    sendExportError(res, error);
  }
};

async function godownNameMap(companyId) {
  const list = await Godown.find({ companyId }).select("name").lean();
  return new Map(list.map((g) => [String(g._id), g.name]));
}

// "12 Case 5 Pcs" with the raw piece total underneath it — the same
// Case+Loose presentation the on-screen Full Report uses, so the PDF and the
// page read identically.
function caseLooseText(caseQty, loosePcs) {
  return `${caseQty}C ${loosePcs}P`;
}

function fmtNum(n, dp = 2) {
  return Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function sendExportError(res, error) {
  console.error(error);
  if (!res.headersSent) res.status(500).json({ message: error.message || "Failed to generate export" });
  else res.end();
}

// GET /api/reports/items/export?companyId=&dateFrom=&dateTo=&search=
const exportItemReport = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo, search = "" } = req.query;
    // super_admin calling with no explicit companyId gets `{ $ne: null }` from
    // scopeCompany as its "match any company" sentinel — passing that straight
    // into `new mongoose.Types.ObjectId(...)` throws a raw BSON cast error, a
    // 500. A specific, ObjectId-shaped companyId is required for every report.
    if (!companyId || !isValidObjectId(companyId)) {
      return res.status(400).json({ message: "A specific companyId is required for this report" });
    }

    const itemQuery = { companyId };
    if (search && search.trim()) itemQuery.itemName = searchRegex(search.trim());
    const items = await Item.find(itemQuery).populate("itemSubGroupId", "name").sort({ itemName: 1 }).limit(EXPORT_ROW_CAP).lean();
    const itemIds = items.map((i) => i._id);

    async function aggregateByItem(Model, dateField) {
      if (!itemIds.length) return new Map();
      const match = { companyId: oid(companyId), ...dateRangeFilter(dateField, dateFrom, dateTo) };
      const rows = await Model.aggregate([
        { $match: match },
        { $unwind: "$items" },
        { $match: { "items.itemId": { $in: itemIds } } },
        { $group: { _id: "$items.itemId", qty: { $sum: "$items.totalPieces" }, amount: { $sum: "$items.netValue" } } },
      ]);
      return new Map(rows.map((r) => [String(r._id), { qty: r.qty, amount: r.amount }]));
    }

    const [purchaseMap, saleMap, purchaseReturnMap, saleReturnMap] = await Promise.all([
      aggregateByItem(Purchase, "invoiceDate"),
      aggregateByItem(Sale, "invoiceDate"),
      aggregateByItem(PurchaseReturn, "returnDate"),
      aggregateByItem(SaleReturn, "returnDate"),
    ]);

    const zero = { qty: 0, amount: 0 };
    const records = items.map((item) => {
      const id = String(item._id);
      return {
        itemName: item.itemName,
        subGroupName: item.itemSubGroupId?.name || "-",
        packing: item.packing || 1,
        purchased: purchaseMap.get(id) || zero,
        sold: saleMap.get(id) || zero,
        purchaseReturned: purchaseReturnMap.get(id) || zero,
        saleReturned: saleReturnMap.get(id) || zero,
        fresh: item.openingStockFreshPcs || 0,
        expired: item.openingStockExpiredPcs || 0,
        damaged: item.openingStockDamagedPcs || 0,
      };
    });

    // Every quantity is exported as total pieces AND its Case/Loose split,
    // keyed off that row's own packing — a distributor reads stock as
    // "Carton + loose pieces", and a bare piece count is unusable on the
    // warehouse floor. `cs`/`ls` mirror the on-screen report exactly.
    const cs = (r, pcs) => splitCasePcsTrunc(pcs, r.packing).caseQty;
    const ls = (r, pcs) => splitCasePcsTrunc(pcs, r.packing).pcs;
    const columns = [
      { header: "Item Name", width: 130, accessor: (r) => r.itemName },
      { header: "Sub Group", width: 100, accessor: (r) => r.subGroupName },
      { header: "Packing", width: 60, accessor: (r) => r.packing, align: "right" },
      { header: "Purchased Qty", width: 80, accessor: (r) => r.purchased.qty, align: "right" },
      { header: "Purchased Case", width: 85, accessor: (r) => cs(r, r.purchased.qty), align: "right" },
      { header: "Purchased Loose Pcs", width: 100, accessor: (r) => ls(r, r.purchased.qty), align: "right" },
      { header: "Purchased Amt", width: 90, accessor: (r) => r.purchased.amount, align: "right", moneyCol: true },
      { header: "Sold Qty", width: 70, accessor: (r) => r.sold.qty, align: "right" },
      { header: "Sold Case", width: 70, accessor: (r) => cs(r, r.sold.qty), align: "right" },
      { header: "Sold Loose Pcs", width: 85, accessor: (r) => ls(r, r.sold.qty), align: "right" },
      { header: "Sold Amt", width: 90, accessor: (r) => r.sold.amount, align: "right", moneyCol: true },
      { header: "Pur. Return Qty", width: 90, accessor: (r) => r.purchaseReturned.qty, align: "right" },
      { header: "Pur. Return Case", width: 95, accessor: (r) => cs(r, r.purchaseReturned.qty), align: "right" },
      { header: "Pur. Return Loose Pcs", width: 105, accessor: (r) => ls(r, r.purchaseReturned.qty), align: "right" },
      { header: "Pur. Return Amt", width: 90, accessor: (r) => r.purchaseReturned.amount, align: "right", moneyCol: true },
      { header: "Sale Return Qty", width: 90, accessor: (r) => r.saleReturned.qty, align: "right" },
      { header: "Sale Return Case", width: 95, accessor: (r) => cs(r, r.saleReturned.qty), align: "right" },
      { header: "Sale Return Loose Pcs", width: 105, accessor: (r) => ls(r, r.saleReturned.qty), align: "right" },
      { header: "Sale Return Amt", width: 90, accessor: (r) => r.saleReturned.amount, align: "right", moneyCol: true },
      { header: "Fresh Stock", width: 70, accessor: (r) => r.fresh, align: "right" },
      { header: "Fresh Case", width: 70, accessor: (r) => cs(r, r.fresh), align: "right" },
      { header: "Fresh Loose Pcs", width: 85, accessor: (r) => ls(r, r.fresh), align: "right" },
      { header: "Expired Stock", width: 80, accessor: (r) => r.expired, align: "right" },
      { header: "Expired Case", width: 75, accessor: (r) => cs(r, r.expired), align: "right" },
      { header: "Expired Loose Pcs", width: 90, accessor: (r) => ls(r, r.expired), align: "right" },
      { header: "Damaged Stock", width: 80, accessor: (r) => r.damaged, align: "right" },
      { header: "Damaged Case", width: 80, accessor: (r) => cs(r, r.damaged), align: "right" },
      { header: "Damaged Loose Pcs", width: 95, accessor: (r) => ls(r, r.damaged), align: "right" },
    ];

    // The PDF collapses each Qty/Case/Loose triple into one readable
    // "N Case M Pcs (T)" cell — 28 separate columns is fine in a spreadsheet
    // but illegible on a printed page.
    const qtyCell = (r, pcs) => {
      const sp = splitCasePcsTrunc(pcs, r.packing);
      return `${sp.caseQty}C ${sp.pcs}P`;
    };
    const pdfColumns = [
      { header: "Item Name", width: 100, accessor: (r) => r.itemName },
      { header: "Sub Group", width: 76, accessor: (r) => r.subGroupName },
      { header: "Pack", width: 28, accessor: (r) => r.packing, align: "right" },
      { header: "Purchased", width: 54, accessor: (r) => qtyCell(r, r.purchased.qty), align: "right" , qtyLegend: true },
      { header: "Purch. Amt", width: 62, accessor: (r) => fmtNum(r.purchased.amount), align: "right" },
      { header: "Sold", width: 54, accessor: (r) => qtyCell(r, r.sold.qty), align: "right" , qtyLegend: true },
      { header: "Sold Amt", width: 62, accessor: (r) => fmtNum(r.sold.amount), align: "right" },
      { header: "Pur. Ret", width: 54, accessor: (r) => qtyCell(r, r.purchaseReturned.qty), align: "right" , qtyLegend: true },
      { header: "Sale Ret", width: 54, accessor: (r) => qtyCell(r, r.saleReturned.qty), align: "right" , qtyLegend: true },
      { header: "Fresh", width: 54, accessor: (r) => qtyCell(r, r.fresh), align: "right" , qtyLegend: true },
      { header: "Expired", width: 54, accessor: (r) => qtyCell(r, r.expired), align: "right" , qtyLegend: true },
      { header: "Damaged", width: 54, accessor: (r) => qtyCell(r, r.damaged), align: "right" , qtyLegend: true },
    ];

    await sendReportFile(res, {
      format: req.query.format,
      company: await loadCompanyLetterhead(req),
      title: "Item Report",
      columns,
      pdfColumns,
      records: records,
      baseFilename: "Item_Report",
    });
  } catch (error) {
    sendExportError(res, error);
  }
};

// GET /api/reports/customers/export?companyId=&dateFrom=&dateTo=&search=
const exportCustomerReport = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo, search = "" } = req.query;
    // super_admin calling with no explicit companyId gets `{ $ne: null }` from
    // scopeCompany as its "match any company" sentinel — passing that straight
    // into `new mongoose.Types.ObjectId(...)` throws a raw BSON cast error, a
    // 500. A specific, ObjectId-shaped companyId is required for every report.
    if (!companyId || !isValidObjectId(companyId)) {
      return res.status(400).json({ message: "A specific companyId is required for this report" });
    }

    const query = { companyId };
    if (search && search.trim()) {
      const r = searchRegex(search.trim());
      query.$or = [{ name: r }, { phone: r }, { email: r }, { city: r }];
    }
    const customers = await Customer.find(query).sort({ name: 1 }).limit(EXPORT_ROW_CAP).lean();
    const customerIds = customers.map((c) => c._id);

    async function aggregateByCustomer(Model, dateField) {
      if (!customerIds.length) return new Map();
      const match = { companyId: oid(companyId), customerId: { $in: customerIds }, ...dateRangeFilter(dateField, dateFrom, dateTo) };
      const rows = await Model.aggregate([
        { $match: match },
        { $group: { _id: "$customerId", count: { $sum: 1 }, netAmount: { $sum: "$netAmount" }, pendingAmount: { $sum: "$pendingAmount" } } },
      ]);
      return new Map(rows.map((r) => [String(r._id), r]));
    }

    const [saleMap, saleReturnMap] = await Promise.all([
      aggregateByCustomer(Sale, "invoiceDate"),
      aggregateByCustomer(SaleReturn, "returnDate"),
    ]);

    const zero = { count: 0, netAmount: 0, pendingAmount: 0 };
    const records = customers.map((c) => {
      const id = String(c._id);
      const sale = saleMap.get(id) || zero;
      const saleReturn = saleReturnMap.get(id) || zero;
      return {
        name: c.name,
        phone: c.phone || "-",
        city: c.city || "-",
        saleCount: sale.count,
        saleAmount: sale.netAmount,
        saleReturnCount: saleReturn.count,
        saleReturnAmount: saleReturn.netAmount,
        netPendingAmount: (sale.pendingAmount || 0) - (saleReturn.pendingAmount || 0),
      };
    });

    const columns = [
      { header: "Customer", width: 130, accessor: (r) => r.name },
      { header: "Phone", width: 80, accessor: (r) => r.phone },
      { header: "City", width: 90, accessor: (r) => r.city },
      { header: "Sales", width: 55, accessor: (r) => r.saleCount, align: "right" },
      { header: "Sale Amount", width: 90, accessor: (r) => r.saleAmount, align: "right", moneyCol: true },
      { header: "Returns", width: 55, accessor: (r) => r.saleReturnCount, align: "right" },
      { header: "Return Amount", width: 90, accessor: (r) => r.saleReturnAmount, align: "right", moneyCol: true },
      { header: "Net Pending", width: 90, accessor: (r) => r.netPendingAmount, align: "right", moneyCol: true },
    ];

    await sendReportFile(res, {
      format: req.query.format,
      company: await loadCompanyLetterhead(req),
      title: "Customer Report",
      columns,
      records: records,
      baseFilename: "Customer_Report",
    });
  } catch (error) {
    sendExportError(res, error);
  }
};

// GET /api/reports/suppliers/export?companyId=&dateFrom=&dateTo=&search=
const exportSupplierReport = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo, search = "" } = req.query;
    // super_admin calling with no explicit companyId gets `{ $ne: null }` from
    // scopeCompany as its "match any company" sentinel — passing that straight
    // into `new mongoose.Types.ObjectId(...)` throws a raw BSON cast error, a
    // 500. A specific, ObjectId-shaped companyId is required for every report.
    if (!companyId || !isValidObjectId(companyId)) {
      return res.status(400).json({ message: "A specific companyId is required for this report" });
    }

    const query = { companyId };
    if (search && search.trim()) {
      const r = searchRegex(search.trim());
      query.$or = [{ name: r }, { phone: r }, { email: r }, { city: r }];
    }
    const suppliers = await Supplier.find(query).sort({ name: 1 }).limit(EXPORT_ROW_CAP).lean();
    const supplierIds = suppliers.map((s) => s._id);

    let purchaseMap = new Map();
    if (supplierIds.length) {
      const rows = await Purchase.aggregate([
        { $match: { companyId: oid(companyId), ...dateRangeFilter("invoiceDate", dateFrom, dateTo) } },
        { $unwind: "$items" },
        { $lookup: { from: "items", localField: "items.itemId", foreignField: "_id", as: "itemDoc" } },
        { $unwind: "$itemDoc" },
        { $match: { "itemDoc.supplierId": { $in: supplierIds } } },
        // Apportioned exactly as getSupplierReport does — see the comment on its
        // own copy of this pipeline for why the header pendingAmount can't just
        // be summed per supplier. Without this the exported "Net Pending"
        // disagreed with the on-screen figure for every multi-supplier invoice.
        { $group: { _id: { purchaseId: "$_id", supplierId: "$itemDoc.supplierId" }, lineAmount: { $sum: "$items.netValue" }, pendingAmount: { $first: "$pendingAmount" }, netAmount: { $first: "$netAmount" } } },
        {
          $project: {
            lineAmount: 1,
            pendingShare: {
              $cond: [
                { $gt: ["$netAmount", 0] },
                { $multiply: ["$pendingAmount", { $divide: ["$lineAmount", "$netAmount"] }] },
                0,
              ],
            },
          },
        },
        { $group: { _id: "$_id.supplierId", count: { $sum: 1 }, amount: { $sum: "$lineAmount" }, pendingAmount: { $sum: "$pendingShare" } } },
      ]);
      purchaseMap = new Map(rows.map((r) => [String(r._id), r]));
    }

    let purchaseReturnMap = new Map();
    if (supplierIds.length) {
      const rows = await PurchaseReturn.aggregate([
        { $match: { companyId: oid(companyId), supplierId: { $in: supplierIds }, ...dateRangeFilter("returnDate", dateFrom, dateTo) } },
        { $group: { _id: "$supplierId", count: { $sum: 1 }, netAmount: { $sum: "$netAmount" }, pendingAmount: { $sum: "$pendingAmount" } } },
      ]);
      purchaseReturnMap = new Map(rows.map((r) => [String(r._id), r]));
    }

    const zero = { count: 0, amount: 0, netAmount: 0, pendingAmount: 0 };
    const records = suppliers.map((s) => {
      const id = String(s._id);
      const purchase = purchaseMap.get(id) || zero;
      const purchaseReturn = purchaseReturnMap.get(id) || zero;
      return {
        name: s.name,
        phone: s.phone || "-",
        city: s.city || "-",
        purchaseCount: purchase.count,
        purchaseAmount: purchase.amount,
        purchaseReturnCount: purchaseReturn.count,
        purchaseReturnAmount: purchaseReturn.netAmount,
        netPendingAmount: (purchase.pendingAmount || 0) - (purchaseReturn.pendingAmount || 0),
      };
    });

    const columns = [
      { header: "Supplier", width: 130, accessor: (r) => r.name },
      { header: "Phone", width: 80, accessor: (r) => r.phone },
      { header: "City", width: 90, accessor: (r) => r.city },
      { header: "Purchases", width: 60, accessor: (r) => r.purchaseCount, align: "right" },
      { header: "Purchase Amount", width: 95, accessor: (r) => r.purchaseAmount, align: "right", moneyCol: true },
      { header: "Returns", width: 55, accessor: (r) => r.purchaseReturnCount, align: "right" },
      { header: "Return Amount", width: 90, accessor: (r) => r.purchaseReturnAmount, align: "right", moneyCol: true },
      { header: "Net Pending", width: 90, accessor: (r) => r.netPendingAmount, align: "right", moneyCol: true },
    ];

    await sendReportFile(res, {
      format: req.query.format,
      company: await loadCompanyLetterhead(req),
      title: "Supplier Report",
      columns,
      records: records,
      baseFilename: "Supplier_Report",
    });
  } catch (error) {
    sendExportError(res, error);
  }
};

// GET /api/reports/purchases/export?companyId=&dateFrom=&dateTo=&itemId=&godownId=&search=
const exportPurchaseReport = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo, itemId, godownId, search = "" } = req.query;
    // super_admin calling with no explicit companyId gets `{ $ne: null }` from
    // scopeCompany as its "match any company" sentinel — passing that straight
    // into `new mongoose.Types.ObjectId(...)` throws a raw BSON cast error, a
    // 500. A specific, ObjectId-shaped companyId is required for every report.
    if (!companyId || !isValidObjectId(companyId)) {
      return res.status(400).json({ message: "A specific companyId is required for this report" });
    }

    const match = { companyId: oid(companyId), ...dateRangeFilter("invoiceDate", dateFrom, dateTo) };
    if (search && search.trim()) match.invoiceNo = searchRegex(search.trim());
    const lineMatch = {};
    if (itemId && isValidObjectId(itemId)) lineMatch["items.itemId"] = oid(itemId);
    if (godownId && isValidObjectId(godownId)) lineMatch["items.godownId"] = oid(godownId);

    const [{ data }, gMap] = await Promise.all([
      buildLineReport({
        Model: Purchase,
        dateField: "invoiceDate",
        noField: "invoiceNo",
        match,
        lineMatch,
        extraProject: { rate: "$items.afterGstRate", amount: "$items.amount" },
        skip: 0,
        limit: EXPORT_ROW_CAP,
      }),
      godownNameMap(companyId),
    ]);

    const columns = [
      { header: "Invoice No", width: 70, accessor: (r) => r.invoiceNo },
      { header: "Date", width: 65, accessor: (r) => fmtDate(r.invoiceDate) },
      { header: "Item", width: 120, accessor: (r) => r.itemName },
      { header: "Sub Group", width: 100, accessor: (r) => r.subGroupName || "-" },
      { header: "Godown", width: 90, accessor: (r) => gMap.get(String(r.godownId)) || "-" },
      { header: "Case", width: 50, accessor: (r) => r.caseQty, align: "right" },
      { header: "Pcs", width: 50, accessor: (r) => r.pcsQty, align: "right" },
      { header: "Total Pcs", width: 65, accessor: (r) => r.totalPieces, align: "right" },
      { header: "Rate", width: 70, accessor: (r) => r.rate, align: "right" },
      { header: "Taxable", width: 85, accessor: (r) => r.taxableValue, align: "right", moneyCol: true },
      { header: "GST", width: 75, accessor: (r) => r.gstAmount, align: "right", moneyCol: true },
      { header: "Net Value", width: 90, accessor: (r) => r.netValue, align: "right", moneyCol: true },
    ];

    await sendReportFile(res, {
      format: req.query.format,
      company: await loadCompanyLetterhead(req),
      title: "Purchase Report",
      columns,
      records: data,
      baseFilename: "Purchase_Report",
    });
  } catch (error) {
    sendExportError(res, error);
  }
};

// GET /api/reports/sales/export?companyId=&dateFrom=&dateTo=&itemId=&godownId=&customerId=&search=
const exportSaleReport = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo, itemId, godownId, customerId, search = "" } = req.query;
    // super_admin calling with no explicit companyId gets `{ $ne: null }` from
    // scopeCompany as its "match any company" sentinel — passing that straight
    // into `new mongoose.Types.ObjectId(...)` throws a raw BSON cast error, a
    // 500. A specific, ObjectId-shaped companyId is required for every report.
    if (!companyId || !isValidObjectId(companyId)) {
      return res.status(400).json({ message: "A specific companyId is required for this report" });
    }

    const match = { companyId: oid(companyId), ...dateRangeFilter("invoiceDate", dateFrom, dateTo) };
    if (search && search.trim()) match.invoiceNo = searchRegex(search.trim());
    if (customerId && isValidObjectId(customerId)) match.customerId = oid(customerId);
    const lineMatch = {};
    if (itemId && isValidObjectId(itemId)) lineMatch["items.itemId"] = oid(itemId);
    if (godownId && isValidObjectId(godownId)) lineMatch["items.godownId"] = oid(godownId);

    const [{ data }, gMap] = await Promise.all([
      buildLineReport({
        Model: Sale,
        dateField: "invoiceDate",
        noField: "invoiceNo",
        match,
        lineMatch,
        lookup: { from: "customers", localField: "customerId", foreignField: "_id", as: "customer" },
        extraProject: { rate: "$items.afterGstRate", amount: "$items.amount", customerName: "$customer.name" },
        skip: 0,
        limit: EXPORT_ROW_CAP,
      }),
      godownNameMap(companyId),
    ]);

    const columns = [
      { header: "Invoice No", width: 70, accessor: (r) => r.invoiceNo },
      { header: "Date", width: 65, accessor: (r) => fmtDate(r.invoiceDate) },
      { header: "Customer", width: 110, accessor: (r) => r.customerName || "-" },
      { header: "Item", width: 120, accessor: (r) => r.itemName },
      { header: "Sub Group", width: 100, accessor: (r) => r.subGroupName || "-" },
      { header: "Godown", width: 90, accessor: (r) => gMap.get(String(r.godownId)) || "-" },
      { header: "Case", width: 50, accessor: (r) => r.caseQty, align: "right" },
      { header: "Pcs", width: 50, accessor: (r) => r.pcsQty, align: "right" },
      { header: "Total Pcs", width: 65, accessor: (r) => r.totalPieces, align: "right" },
      { header: "Rate", width: 70, accessor: (r) => r.rate, align: "right" },
      { header: "Taxable", width: 85, accessor: (r) => r.taxableValue, align: "right", moneyCol: true },
      { header: "GST", width: 75, accessor: (r) => r.gstAmount, align: "right", moneyCol: true },
      { header: "Net Value", width: 90, accessor: (r) => r.netValue, align: "right", moneyCol: true },
    ];

    await sendReportFile(res, {
      format: req.query.format,
      company: await loadCompanyLetterhead(req),
      title: "Sale Report",
      columns,
      records: data,
      baseFilename: "Sale_Report",
    });
  } catch (error) {
    sendExportError(res, error);
  }
};

// GET /api/reports/purchase-returns/export?companyId=&dateFrom=&dateTo=&itemId=&godownId=&supplierId=&condition=&search=
const exportPurchaseReturnReport = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo, itemId, godownId, supplierId, condition, search = "" } = req.query;
    // super_admin calling with no explicit companyId gets `{ $ne: null }` from
    // scopeCompany as its "match any company" sentinel — passing that straight
    // into `new mongoose.Types.ObjectId(...)` throws a raw BSON cast error, a
    // 500. A specific, ObjectId-shaped companyId is required for every report.
    if (!companyId || !isValidObjectId(companyId)) {
      return res.status(400).json({ message: "A specific companyId is required for this report" });
    }

    const match = { companyId: oid(companyId), ...dateRangeFilter("returnDate", dateFrom, dateTo) };
    if (search && search.trim()) match.returnNo = searchRegex(search.trim());
    if (supplierId && isValidObjectId(supplierId)) match.supplierId = oid(supplierId);
    const lineMatch = {};
    if (itemId && isValidObjectId(itemId)) lineMatch["items.itemId"] = oid(itemId);
    if (godownId && isValidObjectId(godownId)) lineMatch["items.godownId"] = oid(godownId);
    if (condition) lineMatch["items.condition"] = condition;

    const [{ data }, gMap] = await Promise.all([
      buildLineReport({
        Model: PurchaseReturn,
        dateField: "returnDate",
        noField: "returnNo",
        match,
        lineMatch,
        lookup: { from: "suppliers", localField: "supplierId", foreignField: "_id", as: "supplier" },
        extraProject: { rate: "$items.afterGstRate", amount: "$items.amount", condition: "$items.condition", supplierName: "$supplier.name" },
        skip: 0,
        limit: EXPORT_ROW_CAP,
      }),
      godownNameMap(companyId),
    ]);

    const columns = [
      { header: "Return No", width: 70, accessor: (r) => r.returnNo },
      { header: "Date", width: 65, accessor: (r) => fmtDate(r.returnDate) },
      { header: "Supplier", width: 110, accessor: (r) => r.supplierName || "-" },
      { header: "Item", width: 120, accessor: (r) => r.itemName },
      { header: "Sub Group", width: 100, accessor: (r) => r.subGroupName || "-" },
      { header: "Godown", width: 90, accessor: (r) => gMap.get(String(r.godownId)) || "-" },
      { header: "Condition", width: 70, accessor: (r) => r.condition },
      { header: "Case", width: 50, accessor: (r) => r.caseQty, align: "right" },
      { header: "Pcs", width: 50, accessor: (r) => r.pcsQty, align: "right" },
      { header: "Total Pcs", width: 65, accessor: (r) => r.totalPieces, align: "right" },
      { header: "Taxable", width: 85, accessor: (r) => r.taxableValue, align: "right", moneyCol: true },
      { header: "GST", width: 75, accessor: (r) => r.gstAmount, align: "right", moneyCol: true },
      { header: "Net Value", width: 90, accessor: (r) => r.netValue, align: "right", moneyCol: true },
    ];

    await sendReportFile(res, {
      format: req.query.format,
      company: await loadCompanyLetterhead(req),
      title: "Purchase Return Report",
      columns,
      records: data,
      baseFilename: "Purchase_Return_Report",
    });
  } catch (error) {
    sendExportError(res, error);
  }
};

// GET /api/reports/sale-returns/export?companyId=&dateFrom=&dateTo=&itemId=&godownId=&customerId=&condition=&search=
const exportSaleReturnReport = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo, itemId, godownId, customerId, condition, search = "" } = req.query;
    // super_admin calling with no explicit companyId gets `{ $ne: null }` from
    // scopeCompany as its "match any company" sentinel — passing that straight
    // into `new mongoose.Types.ObjectId(...)` throws a raw BSON cast error, a
    // 500. A specific, ObjectId-shaped companyId is required for every report.
    if (!companyId || !isValidObjectId(companyId)) {
      return res.status(400).json({ message: "A specific companyId is required for this report" });
    }

    const match = { companyId: oid(companyId), ...dateRangeFilter("returnDate", dateFrom, dateTo) };
    if (search && search.trim()) match.returnNo = searchRegex(search.trim());
    if (customerId && isValidObjectId(customerId)) match.customerId = oid(customerId);
    const lineMatch = {};
    if (itemId && isValidObjectId(itemId)) lineMatch["items.itemId"] = oid(itemId);
    if (godownId && isValidObjectId(godownId)) lineMatch["items.godownId"] = oid(godownId);
    if (condition) lineMatch["items.condition"] = condition;

    const [{ data }, gMap] = await Promise.all([
      buildLineReport({
        Model: SaleReturn,
        dateField: "returnDate",
        noField: "returnNo",
        match,
        lineMatch,
        lookup: { from: "customers", localField: "customerId", foreignField: "_id", as: "customer" },
        extraProject: { rate: "$items.afterGstRate", amount: "$items.amount", condition: "$items.condition", customerName: "$customer.name" },
        skip: 0,
        limit: EXPORT_ROW_CAP,
      }),
      godownNameMap(companyId),
    ]);

    const columns = [
      { header: "Return No", width: 70, accessor: (r) => r.returnNo },
      { header: "Date", width: 65, accessor: (r) => fmtDate(r.returnDate) },
      { header: "Customer", width: 110, accessor: (r) => r.customerName || "-" },
      { header: "Item", width: 120, accessor: (r) => r.itemName },
      { header: "Sub Group", width: 100, accessor: (r) => r.subGroupName || "-" },
      { header: "Godown", width: 90, accessor: (r) => gMap.get(String(r.godownId)) || "-" },
      { header: "Condition", width: 70, accessor: (r) => r.condition },
      { header: "Case", width: 50, accessor: (r) => r.caseQty, align: "right" },
      { header: "Pcs", width: 50, accessor: (r) => r.pcsQty, align: "right" },
      { header: "Total Pcs", width: 65, accessor: (r) => r.totalPieces, align: "right" },
      { header: "Taxable", width: 85, accessor: (r) => r.taxableValue, align: "right", moneyCol: true },
      { header: "GST", width: 75, accessor: (r) => r.gstAmount, align: "right", moneyCol: true },
      { header: "Net Value", width: 90, accessor: (r) => r.netValue, align: "right", moneyCol: true },
    ];

    await sendReportFile(res, {
      format: req.query.format,
      company: await loadCompanyLetterhead(req),
      title: "Sale Return Report",
      columns,
      records: data,
      baseFilename: "Sale_Return_Report",
    });
  } catch (error) {
    sendExportError(res, error);
  }
};

// The same "phone · city · GST: xxx" subtitle line both Ledger pages render
// under the party's name — mirrored here so the PDF's header matches the
// on-screen page exactly, not just the table below it.
function partySubtitle(party) {
  const parts = [];
  if (party.phone) parts.push(party.phone);
  if (party.city) parts.push(party.city);
  if (party.gstNo) parts.push(`GST: ${party.gstNo}`);
  return parts.join(" · ");
}

// Shared Excel shape for both ledgers — an opening-balance row (only when a
// dateFrom filter is active, mirroring the frontend's own display rule)
// followed by every dated entry.
function ledgerExcelColumns() {
  return [
    { header: "Date", width: 70, accessor: (r) => (r.date ? fmtDate(r.date) : "-") },
    { header: "Type", width: 90, accessor: (r) => r.type },
    {
      header: "Bill No",
      width: 75,
      accessor: (r) => {
        if (Array.isArray(r.bills) && r.bills.length > 0) {
          return r.bills.map((b) => b.billNo).join(", ");
        }
        if (r.type === "Purchase" || r.type === "Sale" || r.type === "Opening Balance") {
          return r.ref && r.ref !== "-" ? r.ref : "-";
        }
        return "-";
      },
    },
    { header: "Ref No", width: 70, accessor: (r) => r.ref },
    {
      header: "Narration",
      width: 100,
      accessor: (r) =>
        Array.isArray(r.narrations) && r.narrations.length > 0
          ? r.narrations
              .map((n) => (typeof n === "string" ? n : n.type && n.code ? `${n.type}: ${n.code}` : n.code || n.type || ""))
              .filter(Boolean)
              .join(", ")
          : "-",
    },
    { header: "Debit", width: 85, accessor: (r) => r.debit || 0, align: "right", moneyCol: true },
    { header: "Credit", width: 85, accessor: (r) => r.credit || 0, align: "right", moneyCol: true },
    { header: "Balance", width: 90, accessor: (r) => r.balance, align: "right" },
  ];
}

function ledgerExcelRows(ledger, dateFrom, openingLabelDebit) {
  const openingRow = dateFrom
    ? [
        {
          date: dateFrom,
          type: "Opening Balance",
          ref: "-",
          debit: openingLabelDebit ? Math.max(ledger.openingBalance, 0) : Math.max(-ledger.openingBalance, 0),
          credit: openingLabelDebit ? Math.max(-ledger.openingBalance, 0) : Math.max(ledger.openingBalance, 0),
          balance: ledger.openingBalance,
          narrations: [],
        },
      ]
    : [];
  return [...openingRow, ...ledger.entries];
}

// GET /api/reports/customer-ledger/:customerId/export?companyId=&dateFrom=&dateTo=
const exportCustomerLedger = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo } = req.query;
    const { customerId } = req.params;
    // super_admin calling with no explicit companyId gets `{ $ne: null }` from
    // scopeCompany as its "match any company" sentinel — passing that straight
    // into `new mongoose.Types.ObjectId(...)` throws a raw BSON cast error, a
    // 500. A specific, ObjectId-shaped companyId is required for every report.
    if (!companyId || !isValidObjectId(companyId)) {
      return res.status(400).json({ message: "A specific companyId is required for this report" });
    }
    if (!isValidObjectId(customerId)) return res.status(400).json({ message: "Invalid customer id" });

    const loaded = await loadCustomerLedgerEntries(companyId, customerId);
    if (!loaded) return res.status(404).json({ message: "Customer not found" });

    const ledger = buildLedger(loaded.entries, dateFrom, dateTo);
    const rows = ledgerExcelRows(ledger, dateFrom, true);
    const safeName = loaded.party.name.replace(/[^a-z0-9]+/gi, "_");

    const format = req.query.format || "excel";
    if (format === "pdf") {
      const company = await Company.findById(companyId).lean();
      await sendLedgerPdf(res, {
        company,
        party: loaded.party,
        dateFrom,
        dateTo,
        ledger,
        filename: `${safeName}_Ledger.pdf`,
        isDebtor: true,
      });
    } else {
      await sendExcelFile(res, "Customer Ledger", ledgerExcelColumns(), rows, `${safeName}_Ledger.xlsx`);
    }
  } catch (error) {
    sendExportError(res, error);
  }
};

// GET /api/reports/supplier-ledger/:supplierId/export?companyId=&dateFrom=&dateTo=
const exportSupplierLedger = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo } = req.query;
    const { supplierId } = req.params;
    // super_admin calling with no explicit companyId gets `{ $ne: null }` from
    // scopeCompany as its "match any company" sentinel — passing that straight
    // into `new mongoose.Types.ObjectId(...)` throws a raw BSON cast error, a
    // 500. A specific, ObjectId-shaped companyId is required for every report.
    if (!companyId || !isValidObjectId(companyId)) {
      return res.status(400).json({ message: "A specific companyId is required for this report" });
    }
    if (!isValidObjectId(supplierId)) return res.status(400).json({ message: "Invalid supplier id" });

    const loaded = await loadSupplierLedgerEntries(companyId, supplierId);
    if (!loaded) return res.status(404).json({ message: "Supplier not found" });

    const ledger = buildLedger(loaded.entries, dateFrom, dateTo, { debitIncreases: false });
    const rows = ledgerExcelRows(ledger, dateFrom, false);
    const safeName = loaded.party.name.replace(/[^a-z0-9]+/gi, "_");

    const format = req.query.format || "excel";
    if (format === "pdf") {
      const company = await Company.findById(companyId).lean();
      await sendLedgerPdf(res, {
        company,
        party: loaded.party,
        dateFrom,
        dateTo,
        ledger,
        filename: `${safeName}_Ledger.pdf`,
        isDebtor: false,
      });
    } else {
      await sendExcelFile(res, "Supplier Ledger", ledgerExcelColumns(), rows, `${safeName}_Ledger.xlsx`);
    }
  } catch (error) {
    sendExportError(res, error);
  }
};

module.exports = {
  getItemReport,
  getCustomerReport,
  getSupplierReport,
  getPurchaseReport,
  getSaleReport,
  getPurchaseReturnReport,
  getSaleReturnReport,
  getFullStockReport,
  getCustomerLedger,
  getSupplierLedger,
  exportItemReport,
  exportCustomerReport,
  exportSupplierReport,
  exportPurchaseReport,
  exportSaleReport,
  exportPurchaseReturnReport,
  exportSaleReturnReport,
  exportFullStockReport,
  exportCustomerLedger,
  exportSupplierLedger,
};
