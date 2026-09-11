const mongoose = require("mongoose");
const ExcelJS = require("exceljs");
const Item = require("../models/Item");
const Customer = require("../models/Customer");
const Supplier = require("../models/Supplier");
const Godown = require("../models/Godown");
const Purchase = require("../models/Purchase");
const Sale = require("../models/Sale");
const PurchaseReturn = require("../models/PurchaseReturn");
const SaleReturn = require("../models/SaleReturn");
const OpeningBill = require("../models/OpeningBill");
const { searchRegex, clampLimit, clampPage, isValidObjectId } = require("../utils/queryHelpers");

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

async function sendExcelFile(res, sheetName, columns, records, filename) {
  const workbook = new ExcelJS.Workbook();
  addExcelSheet(workbook, sheetName, columns, records);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}

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
    if (!companyId) return res.status(400).json({ message: "companyId is required" });

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
      return {
        itemId: item._id,
        itemName: item.itemName,
        subGroupName: item.itemSubGroupId?.name || null,
        packing: item.packing || 1,
        currentStockFreshPcs: item.openingStockFreshPcs || 0,
        currentStockExpiredPcs: item.openingStockExpiredPcs || 0,
        currentStockDamagedPcs: item.openingStockDamagedPcs || 0,
        purchasedQty: purchased.qty,
        purchasedAmount: purchased.amount,
        soldQty: sold.qty,
        soldAmount: sold.amount,
        purchaseReturnedQty: purchaseReturned.qty,
        purchaseReturnedAmount: purchaseReturned.amount,
        saleReturnedQty: saleReturned.qty,
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
    if (!companyId) return res.status(400).json({ message: "companyId is required" });

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
    if (!companyId) return res.status(400).json({ message: "companyId is required" });

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
            pendingAmount: { $first: "$pendingAmount" },
          },
        },
        {
          $group: {
            _id: "$_id.supplierId",
            count: { $sum: 1 },
            amount: { $sum: "$lineAmount" },
            pendingAmount: { $sum: "$pendingAmount" },
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
  pipeline.push({ $unwind: "$items" });
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
  pipeline.push({ $sort: { [dateField]: -1, _id: -1 } });
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
  const totalsRow = result?.totals?.[0] || { count: 0, taxableValue: 0, gstAmount: 0, netValue: 0 };
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
    if (!companyId) return res.status(400).json({ message: "companyId is required" });

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
      totals: { taxableValue: totalsRow.taxableValue, gstAmount: totalsRow.gstAmount, netValue: totalsRow.netValue },
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
    if (!companyId) return res.status(400).json({ message: "companyId is required" });

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
      totals: { taxableValue: totalsRow.taxableValue, gstAmount: totalsRow.gstAmount, netValue: totalsRow.netValue },
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
    if (!companyId) return res.status(400).json({ message: "companyId is required" });

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
      totals: { taxableValue: totalsRow.taxableValue, gstAmount: totalsRow.gstAmount, netValue: totalsRow.netValue },
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
    if (!companyId) return res.status(400).json({ message: "companyId is required" });

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
      totals: { taxableValue: totalsRow.taxableValue, gstAmount: totalsRow.gstAmount, netValue: totalsRow.netValue },
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

  let running = openingBalance;
  const rows = inRange.map((e) => {
    running += delta(e);
    return { ...e, balance: running };
  });

  return { openingBalance, closingBalance: running, entries: rows };
}

// Shared by getCustomerLedger and exportCustomerLedger — fetches the party and
// every raw (unfiltered-by-date) entry; date filtering happens in buildLedger.
async function loadCustomerLedgerEntries(companyId, customerId) {
  const customer = await Customer.findOne({ _id: customerId, companyId }).lean();
  if (!customer) return null;

  const [sales, saleReturns, openingBills] = await Promise.all([
    Sale.find({ companyId, customerId }).select("invoiceNo invoiceDate netAmount pendingAmount").lean(),
    SaleReturn.find({ companyId, customerId }).select("returnNo returnDate netAmount pendingAmount").lean(),
    OpeningBill.find({ companyId, type: "sale", customerId }).select("billNo billDate totalAmount pendingAmount").lean(),
  ]);

  const entries = [
    ...openingBills.map((b) => ({ date: b.billDate, type: "Opening Balance", ref: b.billNo, id: b._id, debit: b.totalAmount, credit: 0, pendingAmount: b.pendingAmount })),
    ...sales.map((s) => ({ date: s.invoiceDate, type: "Sale", ref: s.invoiceNo, id: s._id, debit: s.netAmount, credit: 0, pendingAmount: s.pendingAmount })),
    ...saleReturns.map((r) => ({ date: r.returnDate, type: "Sale Return", ref: r.returnNo, id: r._id, debit: 0, credit: r.netAmount, pendingAmount: r.pendingAmount })),
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
    if (!companyId) return res.status(400).json({ message: "companyId is required" });
    if (!isValidObjectId(customerId)) return res.status(400).json({ message: "Invalid customer id" });

    const loaded = await loadCustomerLedgerEntries(companyId, customerId);
    if (!loaded) return res.status(404).json({ message: "Customer not found" });

    const ledger = buildLedger(loaded.entries, dateFrom, dateTo);
    const customer = loaded.party;

    res.status(200).json({
      party: { id: customer._id, name: customer.name, phone: customer.phone, gstNo: customer.gstNo, city: customer.city },
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
          },
        },
      ])
    : [];

  const [purchaseReturns, openingBills] = await Promise.all([
    PurchaseReturn.find({ companyId, supplierId }).select("returnNo returnDate netAmount pendingAmount").lean(),
    OpeningBill.find({ companyId, type: "purchase", supplierId }).select("billNo billDate totalAmount pendingAmount").lean(),
  ]);

  const entries = [
    ...openingBills.map((b) => ({ date: b.billDate, type: "Opening Balance", ref: b.billNo, id: b._id, debit: 0, credit: b.totalAmount, pendingAmount: b.pendingAmount })),
    ...purchaseRows.map((p) => ({ date: p.invoiceDate, type: "Purchase", ref: p.invoiceNo, id: p._id, debit: 0, credit: p.amount, pendingAmount: null })),
    ...purchaseReturns.map((r) => ({ date: r.returnDate, type: "Purchase Return", ref: r.returnNo, id: r._id, debit: r.netAmount, credit: 0, pendingAmount: r.pendingAmount })),
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
    if (!companyId) return res.status(400).json({ message: "companyId is required" });
    if (!isValidObjectId(supplierId)) return res.status(400).json({ message: "Invalid supplier id" });

    const loaded = await loadSupplierLedgerEntries(companyId, supplierId);
    if (!loaded) return res.status(404).json({ message: "Supplier not found" });

    const ledger = buildLedger(loaded.entries, dateFrom, dateTo, { debitIncreases: false });
    const supplier = loaded.party;

    res.status(200).json({
      party: { id: supplier._id, name: supplier.name, phone: supplier.phone, gstNo: supplier.gstNo, city: supplier.city },
      ...ledger,
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

async function godownNameMap(companyId) {
  const list = await Godown.find({ companyId }).select("name").lean();
  return new Map(list.map((g) => [String(g._id), g.name]));
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
    if (!companyId) return res.status(400).json({ message: "companyId is required" });

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

    const columns = [
      { header: "Item Name", width: 130, accessor: (r) => r.itemName },
      { header: "Sub Group", width: 100, accessor: (r) => r.subGroupName },
      { header: "Packing", width: 60, accessor: (r) => r.packing, align: "right" },
      { header: "Purchased Qty", width: 80, accessor: (r) => r.purchased.qty, align: "right" },
      { header: "Purchased Amt", width: 90, accessor: (r) => r.purchased.amount, align: "right", moneyCol: true },
      { header: "Sold Qty", width: 70, accessor: (r) => r.sold.qty, align: "right" },
      { header: "Sold Amt", width: 90, accessor: (r) => r.sold.amount, align: "right", moneyCol: true },
      { header: "Pur. Return Qty", width: 90, accessor: (r) => r.purchaseReturned.qty, align: "right" },
      { header: "Pur. Return Amt", width: 90, accessor: (r) => r.purchaseReturned.amount, align: "right", moneyCol: true },
      { header: "Sale Return Qty", width: 90, accessor: (r) => r.saleReturned.qty, align: "right" },
      { header: "Sale Return Amt", width: 90, accessor: (r) => r.saleReturned.amount, align: "right", moneyCol: true },
      { header: "Fresh Stock", width: 70, accessor: (r) => r.fresh, align: "right" },
      { header: "Expired Stock", width: 80, accessor: (r) => r.expired, align: "right" },
      { header: "Damaged Stock", width: 80, accessor: (r) => r.damaged, align: "right" },
    ];

    await sendExcelFile(res, "Item Report", columns, records, "Item_Report.xlsx");
  } catch (error) {
    sendExportError(res, error);
  }
};

// GET /api/reports/customers/export?companyId=&dateFrom=&dateTo=&search=
const exportCustomerReport = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo, search = "" } = req.query;
    if (!companyId) return res.status(400).json({ message: "companyId is required" });

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

    await sendExcelFile(res, "Customer Report", columns, records, "Customer_Report.xlsx");
  } catch (error) {
    sendExportError(res, error);
  }
};

// GET /api/reports/suppliers/export?companyId=&dateFrom=&dateTo=&search=
const exportSupplierReport = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo, search = "" } = req.query;
    if (!companyId) return res.status(400).json({ message: "companyId is required" });

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
        { $group: { _id: { purchaseId: "$_id", supplierId: "$itemDoc.supplierId" }, lineAmount: { $sum: "$items.netValue" }, pendingAmount: { $first: "$pendingAmount" } } },
        { $group: { _id: "$_id.supplierId", count: { $sum: 1 }, amount: { $sum: "$lineAmount" }, pendingAmount: { $sum: "$pendingAmount" } } },
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

    await sendExcelFile(res, "Supplier Report", columns, records, "Supplier_Report.xlsx");
  } catch (error) {
    sendExportError(res, error);
  }
};

// GET /api/reports/purchases/export?companyId=&dateFrom=&dateTo=&itemId=&godownId=&search=
const exportPurchaseReport = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo, itemId, godownId, search = "" } = req.query;
    if (!companyId) return res.status(400).json({ message: "companyId is required" });

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
      { header: "Rate", width: 70, accessor: (r) => r.rate, align: "right" },
      { header: "Taxable", width: 85, accessor: (r) => r.taxableValue, align: "right", moneyCol: true },
      { header: "GST", width: 75, accessor: (r) => r.gstAmount, align: "right", moneyCol: true },
      { header: "Net Value", width: 90, accessor: (r) => r.netValue, align: "right", moneyCol: true },
    ];

    await sendExcelFile(res, "Purchase Report", columns, data, "Purchase_Report.xlsx");
  } catch (error) {
    sendExportError(res, error);
  }
};

// GET /api/reports/sales/export?companyId=&dateFrom=&dateTo=&itemId=&godownId=&customerId=&search=
const exportSaleReport = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo, itemId, godownId, customerId, search = "" } = req.query;
    if (!companyId) return res.status(400).json({ message: "companyId is required" });

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
      { header: "Rate", width: 70, accessor: (r) => r.rate, align: "right" },
      { header: "Taxable", width: 85, accessor: (r) => r.taxableValue, align: "right", moneyCol: true },
      { header: "GST", width: 75, accessor: (r) => r.gstAmount, align: "right", moneyCol: true },
      { header: "Net Value", width: 90, accessor: (r) => r.netValue, align: "right", moneyCol: true },
    ];

    await sendExcelFile(res, "Sale Report", columns, data, "Sale_Report.xlsx");
  } catch (error) {
    sendExportError(res, error);
  }
};

// GET /api/reports/purchase-returns/export?companyId=&dateFrom=&dateTo=&itemId=&godownId=&supplierId=&condition=&search=
const exportPurchaseReturnReport = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo, itemId, godownId, supplierId, condition, search = "" } = req.query;
    if (!companyId) return res.status(400).json({ message: "companyId is required" });

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
      { header: "Taxable", width: 85, accessor: (r) => r.taxableValue, align: "right", moneyCol: true },
      { header: "GST", width: 75, accessor: (r) => r.gstAmount, align: "right", moneyCol: true },
      { header: "Net Value", width: 90, accessor: (r) => r.netValue, align: "right", moneyCol: true },
    ];

    await sendExcelFile(res, "Purchase Return Report", columns, data, "Purchase_Return_Report.xlsx");
  } catch (error) {
    sendExportError(res, error);
  }
};

// GET /api/reports/sale-returns/export?companyId=&dateFrom=&dateTo=&itemId=&godownId=&customerId=&condition=&search=
const exportSaleReturnReport = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo, itemId, godownId, customerId, condition, search = "" } = req.query;
    if (!companyId) return res.status(400).json({ message: "companyId is required" });

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
      { header: "Taxable", width: 85, accessor: (r) => r.taxableValue, align: "right", moneyCol: true },
      { header: "GST", width: 75, accessor: (r) => r.gstAmount, align: "right", moneyCol: true },
      { header: "Net Value", width: 90, accessor: (r) => r.netValue, align: "right", moneyCol: true },
    ];

    await sendExcelFile(res, "Sale Return Report", columns, data, "Sale_Return_Report.xlsx");
  } catch (error) {
    sendExportError(res, error);
  }
};

// Shared Excel shape for both ledgers — an opening-balance row (only when a
// dateFrom filter is active, mirroring the frontend's own display rule)
// followed by every dated entry.
function ledgerExcelColumns() {
  return [
    { header: "Date", width: 70, accessor: (r) => (r.date ? fmtDate(r.date) : "-") },
    { header: "Type", width: 90, accessor: (r) => r.type },
    { header: "Ref No", width: 70, accessor: (r) => r.ref },
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
    if (!companyId) return res.status(400).json({ message: "companyId is required" });
    if (!isValidObjectId(customerId)) return res.status(400).json({ message: "Invalid customer id" });

    const loaded = await loadCustomerLedgerEntries(companyId, customerId);
    if (!loaded) return res.status(404).json({ message: "Customer not found" });

    const ledger = buildLedger(loaded.entries, dateFrom, dateTo);
    const rows = ledgerExcelRows(ledger, dateFrom, true);
    const safeName = loaded.party.name.replace(/[^a-z0-9]+/gi, "_");

    await sendExcelFile(res, "Customer Ledger", ledgerExcelColumns(), rows, `${safeName}_Ledger.xlsx`);
  } catch (error) {
    sendExportError(res, error);
  }
};

// GET /api/reports/supplier-ledger/:supplierId/export?companyId=&dateFrom=&dateTo=
const exportSupplierLedger = async (req, res) => {
  try {
    const { companyId, dateFrom, dateTo } = req.query;
    const { supplierId } = req.params;
    if (!companyId) return res.status(400).json({ message: "companyId is required" });
    if (!isValidObjectId(supplierId)) return res.status(400).json({ message: "Invalid supplier id" });

    const loaded = await loadSupplierLedgerEntries(companyId, supplierId);
    if (!loaded) return res.status(404).json({ message: "Supplier not found" });

    const ledger = buildLedger(loaded.entries, dateFrom, dateTo, { debitIncreases: false });
    const rows = ledgerExcelRows(ledger, dateFrom, false);
    const safeName = loaded.party.name.replace(/[^a-z0-9]+/gi, "_");

    await sendExcelFile(res, "Supplier Ledger", ledgerExcelColumns(), rows, `${safeName}_Ledger.xlsx`);
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
  getCustomerLedger,
  getSupplierLedger,
  exportItemReport,
  exportCustomerReport,
  exportSupplierReport,
  exportPurchaseReport,
  exportSaleReport,
  exportPurchaseReturnReport,
  exportSaleReturnReport,
  exportCustomerLedger,
  exportSupplierLedger,
};
