const PDFDocument = require("pdfkit");

// Shared Tally-style "Ledger Account" PDF renderer.
//
// Extracted verbatim out of reportController.js so EVERY statement in the app
// prints on the same letterhead with the same table, not just the Customer /
// Supplier ledgers it was originally written for: Bank Account statements,
// chart-of-accounts Account statements, Expenses and Payments all render
// through this one function now. Keeping a single renderer is the whole point
// — the layout was tuned against a real Tally printout, and a second copy
// would inevitably drift away from it.
//
// `company` is the letterhead block (name / address / phone / GSTIN) and is
// now maintained per-company from the Settings page
// (PUT /api/companies/my-company), so it is real data rather than a constant.
//
// `isDebtor` flips which side an opening balance lands on: true for a debtor
// (Customer — debit increases what they owe), false for a creditor
// (Supplier / Bank / Account). Same meaning as buildLedger's `debitIncreases`.

function fmtTallyDate(d) {
  if (!d) return "-";
  const date = new Date(d);
  if (isNaN(date.getTime())) return "-";
  const day = date.getDate();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mon = months[date.getMonth()];
  const yy = String(date.getFullYear()).slice(-2);
  return `${day}-${mon}-${yy}`;
}

function fmtIndianNumber(num) {
  if (num === null || num === undefined || isNaN(num) || Number(num) === 0) return "";
  return Number(num).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtIndianTotal(num) {
  return Number(num || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Tally-style authentic Ledger Account PDF generator matching standard Indian accounting printouts:
// Centered Company details, Centered Party name (bold, underlined), "Ledger Account",
// Centered Party address, Date range, Page indicator,
// Table with Date (with Dr/Cr indicator), Particulars, Vch Type, Vch No., Debit, Credit,
// Subtotals, Closing Balance balancing row, and matched Grand Totals with double bottom rules.
async function sendLedgerPdf(res, { company, party, dateFrom, dateTo, ledger, filename, isDebtor = false }) {
  const doc = new PDFDocument({ margin: 36, size: "A4", layout: "portrait" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  doc.pipe(res);

  let pageNum = 1;
  const tableWidth = 523;
  const startX = 36;
  const endX = startX + tableWidth;

  function renderHeader(isFirstPage) {
    let y = 36;
    if (isFirstPage) {
      // Company name (Centered, uppercase, bold)
      const compName = (company?.name || "ARIHANT ENTERPRISE").toUpperCase();
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#000").text(compName, startX, y, { width: tableWidth, align: "center" });
      y = doc.y + 2;

      // Company address lines (Centered)
      if (company?.address) {
        doc.font("Helvetica").fontSize(8.5).fillColor("#333").text(company.address.toUpperCase(), startX, y, { width: tableWidth, align: "center" });
        y = doc.y + 1;
      }
      const compSub = [];
      if (company?.phone) compSub.push(`PH: ${company.phone}`);
      if (company?.gstNo) compSub.push(`GSTIN: ${company.gstNo}`);
      if (compSub.length > 0) {
        doc.font("Helvetica").fontSize(8).fillColor("#444").text(compSub.join("  |  "), startX, y, { width: tableWidth, align: "center" });
        y = doc.y + 1;
      }

      y += 8;

      // Party Name (Centered, uppercase, bold, underlined)
      const partyName = (party?.name || "PARTY").toUpperCase();
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#000").text(partyName, startX, y, { width: tableWidth, align: "center", underline: true });
      y = doc.y + 3;

      doc.font("Helvetica").fontSize(9).fillColor("#333").text("Ledger Account", startX, y, { width: tableWidth, align: "center" });
      y = doc.y + 2;

      // Party address lines (Centered)
      const partyAddrParts = [];
      if (party?.address) partyAddrParts.push(party.address.toUpperCase());
      if (party?.city) partyAddrParts.push(party.city.toUpperCase());
      if (party?.state) partyAddrParts.push(party.state.toUpperCase());
      if (party?.pincode) partyAddrParts.push(party.pincode);
      if (partyAddrParts.length > 0) {
        doc.font("Helvetica").fontSize(8).fillColor("#444").text(partyAddrParts.join(", "), startX, y, { width: tableWidth, align: "center" });
        y = doc.y + 1;
      }
      if (party?.gstNo) {
        doc.font("Helvetica").fontSize(8).fillColor("#444").text(`GSTIN: ${party.gstNo}`, startX, y, { width: tableWidth, align: "center" });
        y = doc.y + 1;
      }

      y += 8;

      // Date Range (Centered)
      const fromStr = dateFrom ? fmtTallyDate(dateFrom) : (ledger.entries?.[0]?.date ? fmtTallyDate(ledger.entries[0].date) : "1-Apr-26");
      const toStr = dateTo ? fmtTallyDate(dateTo) : (ledger.entries?.length ? fmtTallyDate(ledger.entries[ledger.entries.length - 1].date) : fmtTallyDate(new Date()));
      doc.font("Helvetica").fontSize(8.5).fillColor("#000").text(`${fromStr} to ${toStr}`, startX, y, { width: tableWidth, align: "center" });
      y = doc.y + 4;
    } else {
      // Subsequent pages header
      const partyName = (party?.name || "PARTY").toUpperCase();
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#000").text(`${partyName} — Ledger Account (Contd.)`, startX, y, { width: tableWidth, align: "center" });
      y = doc.y + 6;
    }

    // Right-aligned Page Number
    doc.font("Helvetica").fontSize(8).fillColor("#333").text(`Page ${pageNum}`, startX, y, { width: tableWidth, align: "right" });
    y = doc.y + 4;

    // Table Header horizontal top line
    doc.moveTo(startX, y).lineTo(endX, y).lineWidth(0.5).strokeColor("#000").stroke();
    y += 3;

    // Header column names
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#000");
    doc.text("Date", 36, y, { width: 74 });
    doc.text("Particulars", 112, y, { width: 200 });
    doc.text("Vch Type", 314, y, { width: 66 });
    doc.text("Vch No.", 382, y, { width: 44 });
    doc.text("Debit", 428, y, { width: 64, align: "right" });
    doc.text("Credit", 494, y, { width: 65, align: "right" });

    y += 12;
    // Table Header horizontal bottom line
    doc.moveTo(startX, y).lineTo(endX, y).lineWidth(0.5).strokeColor("#000").stroke();
    y += 4;

    return y;
  }

  let y = renderHeader(true);
  const bottomMargin = 45;

  function checkPageBreak(neededHeight = 16) {
    if (y + neededHeight > doc.page.height - bottomMargin) {
      doc.addPage();
      pageNum++;
      y = renderHeader(false);
    }
  }

  // Opening balance row
  const openBal = ledger.openingBalance || 0;
  let openDebit = 0;
  let openCredit = 0;
  if (isDebtor) {
    openDebit = openBal > 0 ? openBal : 0;
    openCredit = openBal < 0 ? Math.abs(openBal) : 0;
  } else {
    openDebit = openBal < 0 ? Math.abs(openBal) : 0;
    openCredit = openBal > 0 ? openBal : 0;
  }

  const openDateStr = dateFrom ? fmtTallyDate(dateFrom) : (ledger.entries?.[0]?.date ? fmtTallyDate(ledger.entries[0].date) : "1-Apr-26");
  const openTag = openCredit > 0 ? "Dr" : (openDebit > 0 ? "Cr" : "Dr");

  if (openBal !== 0 || dateFrom) {
    checkPageBreak(14);
    doc.font("Helvetica").fontSize(8).fillColor("#000");
    doc.text(`${openDateStr}  ${openTag}`, 36, y, { width: 74 });
    doc.font("Helvetica-Bold").text("Opening Balance", 112, y, { width: 200 });
    doc.font("Helvetica");
    if (openDebit > 0) doc.text(fmtIndianNumber(openDebit), 428, y, { width: 64, align: "right" });
    if (openCredit > 0) doc.text(fmtIndianNumber(openCredit), 494, y, { width: 65, align: "right" });
    y += 13;
  }

  let totalDebit = openDebit;
  let totalCredit = openCredit;

  // Transaction rows
  for (const entry of (ledger.entries || [])) {
    const dVal = Number(entry.debit || 0);
    const cVal = Number(entry.credit || 0);
    totalDebit += dVal;
    totalCredit += cVal;

    checkPageBreak(14);

    const tag = entry.opposingDrCr || (cVal > 0 ? "Dr" : "Cr");
    const dateStr = `${fmtTallyDate(entry.date)}  ${tag}`;
    const particularText = entry.particulars || entry.type || "-";
    const vchType = entry.vchType || (entry.type && entry.type.includes("Payment") ? "Payment" : entry.type || "-");
    const vchNo = entry.vchNo || entry.ref || "-";

    doc.font("Helvetica").fontSize(8).fillColor("#000");
    doc.text(dateStr, 36, y, { width: 74 });
    doc.text(particularText, 112, y, { width: 200, ellipsis: true });
    doc.text(vchType, 314, y, { width: 66, ellipsis: true });
    doc.text(String(vchNo), 382, y, { width: 44, ellipsis: true });
    if (dVal > 0) doc.text(fmtIndianNumber(dVal), 428, y, { width: 64, align: "right" });
    if (cVal > 0) doc.text(fmtIndianNumber(cVal), 494, y, { width: 65, align: "right" });

    y += 13;
  }

  // Totals & Balancing Section (requires ~45pt)
  checkPageBreak(45);

  // Subtotal top line
  doc.moveTo(startX, y).lineTo(endX, y).lineWidth(0.5).strokeColor("#000").stroke();
  y += 3;

  // Subtotal amounts
  doc.font("Helvetica").fontSize(8).fillColor("#000");
  doc.text(fmtIndianTotal(totalDebit), 428, y, { width: 64, align: "right" });
  doc.text(fmtIndianTotal(totalCredit), 494, y, { width: 65, align: "right" });
  y += 12;

  // Closing Balance row
  const diff = Math.abs(totalCredit - totalDebit);
  const roundedDiff = Math.round(diff * 100) / 100;
  if (roundedDiff > 0.001) {
    const isCreditGreater = totalCredit > totalDebit;
    const closeTag = isCreditGreater ? "Cr" : "Dr";
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#000");
    doc.text(`${closeTag}   Closing Balance`, 76, y, { width: 236 });
    doc.font("Helvetica");
    if (isCreditGreater) {
      // Put in Debit column to balance
      doc.text(fmtIndianTotal(diff), 428, y, { width: 64, align: "right" });
    } else {
      // Put in Credit column to balance
      doc.text(fmtIndianTotal(diff), 494, y, { width: 65, align: "right" });
    }
    y += 12;
  }

  // Grand Total top line
  doc.moveTo(startX, y).lineTo(endX, y).lineWidth(0.5).strokeColor("#000").stroke();
  y += 3;

  // Grand Total amounts (Identical on both sides!)
  const maxTotal = Math.max(totalDebit, totalCredit);
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#000");
  doc.text(fmtIndianTotal(maxTotal), 428, y, { width: 64, align: "right" });
  doc.text(fmtIndianTotal(maxTotal), 494, y, { width: 65, align: "right" });
  y += 12;

  // Double bottom line
  doc.moveTo(startX, y).lineTo(endX, y).lineWidth(0.5).strokeColor("#000").stroke();
  doc.moveTo(startX, y + 2.5).lineTo(endX, y + 2.5).lineWidth(0.5).strokeColor("#000").stroke();

  doc.end();
}

module.exports = { sendLedgerPdf, fmtTallyDate, fmtIndianNumber, fmtIndianTotal };
