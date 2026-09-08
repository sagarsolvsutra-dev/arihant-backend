const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const Godown = require("../models/Godown");
const Purchase = require("../models/Purchase");
const Sale = require("../models/Sale");
const PurchaseReturn = require("../models/PurchaseReturn");
const SaleReturn = require("../models/SaleReturn");

// One entry per exportable transaction type — mirrors the four History tabs on
// godowns/stock/[id]/page.tsx exactly, so "download what I'm looking at" behaves
// the way a user expects. Object insertion order is also the order sections/sheets
// are emitted in for a combined "all types" export, below.
const TYPE_CONFIG = {
  purchase: {
    label: "Purchase History",
    model: Purchase,
    dateField: "invoiceDate",
    noField: "invoiceNo",
    noHeader: "Invoice No",
    rateField: "beforeGstRate",
  },
  sale: {
    label: "Sale History",
    model: Sale,
    dateField: "invoiceDate",
    noField: "invoiceNo",
    noHeader: "Invoice No",
    rateField: "afterGstRate",
    populatePath: "customerId",
    partyLabel: "Customer",
  },
  purchaseReturn: {
    label: "Purchase Return History",
    model: PurchaseReturn,
    dateField: "returnDate",
    noField: "returnNo",
    noHeader: "Return No",
    rateField: "beforeGstRate",
    populatePath: "supplierId",
    partyLabel: "Supplier",
    hasCondition: true,
  },
  saleReturn: {
    label: "Sale Return History",
    model: SaleReturn,
    dateField: "returnDate",
    noField: "returnNo",
    noHeader: "Return No",
    rateField: "afterGstRate",
    populatePath: "customerId",
    partyLabel: "Customer",
    hasCondition: true,
  },
};

function fmtDate(d) {
  if (!d) return "-";
  const date = new Date(d);
  if (isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-IN");
}

// godownId === "all" (the sentinel the frontend sends when nothing is picked —
// never a real value, since Mongo ObjectIds can't be the literal string "all")
// means "every godown in this company". Godown is now per-LINE, not per-document
// (a single invoice can span several godowns), so filtering happens per-line below
// rather than as a Mongo-level document filter, and godownName is resolved per-line too.
async function buildRows(type, companyId, godownId, godownNameMap) {
  const config = TYPE_CONFIG[type];
  const isAllGodowns = !godownId || godownId === "all";
  let query = config.model.find({ companyId });
  if (config.populatePath) query = query.populate(config.populatePath, "name");
  const records = await query.sort({ [config.dateField]: -1 }).lean();

  const rows = [];
  records.forEach((rec) => {
    const partyName = config.populatePath ? rec[config.populatePath]?.name || "-" : undefined;
    (rec.items || []).forEach((line) => {
      if (!isAllGodowns && String(line.godownId) !== String(godownId)) return;
      rows.push({
        no: rec[config.noField],
        date: fmtDate(rec[config.dateField]),
        godownName: isAllGodowns ? godownNameMap.get(String(line.godownId)) || "-" : undefined,
        party: partyName,
        itemName: line.itemName,
        caseQty: line.caseQty || 0,
        pcsQty: line.pcsQty || 0,
        // condition is now stored directly as one of the 3 real display values
        // (Fresh/Expired/Damaged) — no remapping needed.
        condition: config.hasCondition ? line.condition || "Fresh" : undefined,
        rate: line[config.rateField] || 0,
        netValue: line.netValue || 0,
      });
    });
  });
  return rows;
}

function columnsFor(config, isAllGodowns) {
  const cols = [
    { key: "no", header: config.noHeader, width: 70 },
    { key: "date", header: "Date", width: 65 },
  ];
  if (isAllGodowns) cols.push({ key: "godownName", header: "Godown", width: 85 });
  if (config.partyLabel) cols.push({ key: "party", header: config.partyLabel, width: 95 });
  cols.push({ key: "itemName", header: "Item", width: 110 });
  cols.push({ key: "caseQty", header: "Case", width: 45, align: "right" });
  cols.push({ key: "pcsQty", header: "Pcs", width: 45, align: "right" });
  if (config.hasCondition) cols.push({ key: "condition", header: "Condition", width: 65 });
  cols.push({ key: "rate", header: "Rate", width: 65, align: "right", money: true });
  cols.push({ key: "netValue", header: "Net Value", width: 75, align: "right", money: true });
  return cols;
}

function addExcelSheet(workbook, sheetName, columns, rows) {
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: Math.max(12, Math.round(c.width / 6)) }));
  rows.forEach((r) => sheet.addRow(r));
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111111" } };
  });
  const totalNetValue = rows.reduce((s, r) => s + (r.netValue || 0), 0);
  const totalRow = sheet.addRow({ [columns[0].key]: "TOTAL", [columns[columns.length - 1].key]: totalNetValue });
  totalRow.font = { bold: true };
  return totalNetValue;
}

// Draws one section (title + header row + data rows + TOTAL row) into an
// already-open pdfkit document. Returns the y position to continue from.
// forceNewPage starts the section on a fresh page even if there's room left —
// used for every section after the first in a combined "all types" export, so
// a short Purchase table doesn't run straight into Sale's header with no
// visual break; the first section instead continues right under the report's
// title on the same page.
function drawPdfSection(doc, y, sectionTitle, columns, rows, totalWidth, forceNewPage) {
  const startX = doc.page.margins.left;
  const rowHeight = 20;
  const totalNetValue = rows.reduce((s, r) => s + (r.netValue || 0), 0);

  if (forceNewPage) {
    doc.addPage();
    y = doc.page.margins.top;
  }

  doc.fontSize(13).fillColor("#000").text(sectionTitle, startX, y);
  y = doc.y + 6;

  function drawHeaderRow() {
    let x = startX;
    doc.rect(startX, y, totalWidth, rowHeight).fill("#111111");
    doc.fillColor("#fff").fontSize(9);
    columns.forEach((c) => {
      doc.text(c.header, x + 4, y + 6, { width: c.width - 8, align: c.align || "left" });
      x += c.width;
    });
    y += rowHeight;
  }

  drawHeaderRow();

  if (rows.length === 0) {
    doc.fillColor("#888").fontSize(8.5).text("No records.", startX + 4, y + 4);
    y += rowHeight;
  }

  rows.forEach((r, idx) => {
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
      let val = r[c.key];
      if (c.money) val = `Rs.${(val || 0).toFixed(2)}`;
      doc.text(String(val ?? "-"), x + 4, y + 6, { width: c.width - 8, align: c.align || "left" });
      x += c.width;
    });
    y += rowHeight;
  });

  if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  doc.rect(startX, y, totalWidth, rowHeight).fill("#e5e5e5");
  doc.fillColor("#000").fontSize(9);
  doc.text("TOTAL", startX + 4, y + 6, { width: columns[0].width - 8 });
  const lastCol = columns[columns.length - 1];
  const lastColX = startX + totalWidth - lastCol.width;
  doc.text(`Rs.${totalNetValue.toFixed(2)}`, lastColX + 4, y + 6, { width: lastCol.width - 8, align: "right" });
  y += rowHeight + 20;

  return y;
}

// GET /api/godowns/:id/export?companyId=&type=purchase|sale|purchaseReturn|saleReturn|all&format=pdf|excel
const exportGodownTransactions = async (req, res) => {
  try {
    const { companyId, type, format } = req.query;
    const godownId = req.params.id;
    if (!companyId || !godownId) {
      return res.status(400).json({ message: "companyId and godown id are required" });
    }
    const isAllTypes = type === "all";
    const types = isAllTypes ? Object.keys(TYPE_CONFIG) : [type];
    // Object.prototype.hasOwnProperty guards against `type` being an inherited key
    // name (e.g. "constructor", "toString") — a plain `!TYPE_CONFIG[type]` truthiness
    // check would let those through as if they were a real, configured type.
    if (!isAllTypes && !Object.prototype.hasOwnProperty.call(TYPE_CONFIG, type)) {
      return res.status(400).json({ message: "Invalid type — must be purchase, sale, purchaseReturn, saleReturn, or all" });
    }
    if (format !== "pdf" && format !== "excel") {
      return res.status(400).json({ message: "Invalid format — must be pdf or excel" });
    }

    const isAllGodowns = godownId === "all";
    let godownName = "All Godowns";
    let godownNameMap = new Map();
    if (isAllGodowns) {
      const allGodowns = await Godown.find({ companyId }).lean();
      godownNameMap = new Map(allGodowns.map((g) => [String(g._id), g.name]));
    } else {
      const godown = await Godown.findById(godownId).lean();
      godownName = godown?.name || "Godown";
    }

    // One {config, rows, columns} bundle per type — a single type in the normal
    // case, all four (in TYPE_CONFIG's declared order) for a combined export.
    const sections = await Promise.all(
      types.map(async (t) => {
        const config = TYPE_CONFIG[t];
        const rows = await buildRows(t, companyId, godownId, godownNameMap);
        const columns = columnsFor(config, isAllGodowns);
        return { config, rows, columns };
      })
    );

    const reportLabel = isAllTypes ? "All Transactions" : sections[0].config.label;
    const safeName = `${godownName}-${reportLabel}`.replace(/[^a-z0-9]+/gi, "_");

    if (format === "excel") {
      const workbook = new ExcelJS.Workbook();
      sections.forEach(({ config, rows, columns }) => {
        addExcelSheet(workbook, config.label, columns, rows);
      });
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}.xlsx"`);
      await workbook.xlsx.write(res);
      return res.end();
    }

    // PDF — landscape the moment any section's columns would overflow a portrait
    // page, so a combined export doesn't end up with some sections cramped.
    const maxWidth = Math.max(...sections.map(({ columns }) => columns.reduce((s, c) => s + c.width, 0)));
    const doc = new PDFDocument({ margin: 40, size: "A4", layout: maxWidth > 480 ? "landscape" : "portrait" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.pdf"`);
    doc.pipe(res);

    doc.fontSize(16).fillColor("#000").text(`${godownName} - ${reportLabel}`);
    doc.fontSize(9).fillColor("#666").text(`Generated ${new Date().toLocaleString("en-IN")}`);
    let y = doc.y + 16;

    sections.forEach(({ config, rows, columns }, idx) => {
      const totalWidth = columns.reduce((s, c) => s + c.width, 0);
      y = drawPdfSection(doc, y, config.label, columns, rows, totalWidth, idx > 0);
    });

    doc.end();
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.status(500).json({ message: error.message || "Failed to generate export" });
    } else {
      res.end();
    }
  }
};

module.exports = { exportGodownTransactions };
