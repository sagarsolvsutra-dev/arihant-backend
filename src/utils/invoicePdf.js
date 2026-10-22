const PDFDocument = require("pdfkit");

// ---------------------------------------------------------------------------
// GST Tax-Invoice PDF renderer.
//
// Reproduces the printed invoice layout the business already uses (a reference
// PDF from their previous software was supplied and matched field-for-field):
//
//   ┌ company letterhead ─┬ doc type / no / date ─┬ "Ship To" party block ───┐
//   ├ line table: Sr | Product | HSN | MRP | Case | PCs | FQ | Rate | Amount |
//   │             Discount | Taxable | GST% | CGST | SGST | Net Value        │
//   ├ TOTAL row                                                              │
//   ├ *** GST Summary *** ─┬ jurisdiction / cheque note / bank ─┬ Add        │
//   │  (one row per slab)  │ "For <COMPANY>"                    │ Extra Less │
//   │                      │                                    │ Round Off  │
//   │                      │                                    │ Net Amount │
//   └ Bill Amt. in words ──────────────────────────────────────────────────┘
//
// EVERY value is real data. The letterhead comes from the Company record the
// company_admin maintains on the Settings page, and the bank block comes from
// whichever BankAccount the transaction itself selected for payment (falling
// back to the company's default bank) — nothing here is hardcoded.
// ---------------------------------------------------------------------------

const GST_SLABS = [0, 5, 12, 18, 28];

function money(n, dp = 2) {
  return Number(n || 0).toFixed(dp);
}

function moneyIndian(n) {
  return Number(n || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtInvoiceDate(d) {
  if (!d) return "-";
  const date = new Date(d);
  if (isNaN(date.getTime())) return "-";
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yy = String(date.getFullYear()).slice(-2);
  return `${dd}-${mm}-${yy}`;
}

// Indian-English number-to-words, used for the "Bill Amt. : Rupees ... Only."
// line. Uses the Indian grouping (crore / lakh / thousand), not the short
// scale — "Rupees Twenty Two Thousand Two Hundred Forty Six Only." in the
// reference invoice is exactly this format.
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return TENS[t] + (o ? ` ${ONES[o]}` : "");
}

function threeDigits(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  let out = "";
  if (h) out += `${ONES[h]} Hundred`;
  if (rest) out += `${out ? " " : ""}${twoDigits(rest)}`;
  return out;
}

function numberToWordsIndian(num) {
  const n = Math.floor(Math.abs(Number(num) || 0));
  if (n === 0) return "Zero";
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;
  const parts = [];
  if (crore) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${threeDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${threeDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));
  return parts.join(" ");
}

function amountInWords(total) {
  const n = Number(total) || 0;
  const rupees = Math.floor(Math.abs(n));
  const paise = Math.round((Math.abs(n) - rupees) * 100);
  let out = `Rupees ${numberToWordsIndian(rupees)}`;
  if (paise > 0) out += ` and ${numberToWordsIndian(paise)} Paise`;
  return `${out} Only.`;
}

// Clamp a string to a pixel width using the font metrics actually in effect.
// The table draws fixed-height rows, so a cell must occupy exactly one line —
// the same reason utils/tallyPdf.js and reportController.js measure-and-cut
// rather than relying on pdfkit's own ellipsis option.
function fit(doc, str, maxWidth) {
  let t = String(str ?? "");
  if (!t) return "";
  // EPS guards a floating-point round-trip, not a layout fudge: a column is
  // measured as `textWidth + padding` and then drawn into `colWidth - padding`,
  // and (x + 8) - 8 can land a few ulps BELOW x. Without the epsilon a value
  // that fits its column exactly gets an ellipsis — this really happened, with
  // "120.00" printing as "120." in the M.R.P. column.
  const EPS = 0.05;
  if (doc.widthOfString(t) <= maxWidth + EPS) return t;
  while (t.length > 1 && doc.widthOfString(`${t}…`) > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}


// ---------------------------------------------------------------------------
// Bill To / Ship To.
//
// A party has one billing address and an OPTIONAL delivery ("Ship To")
// address. The invoice shows:
//   - ONE block  — when no delivery address is set, or it is the same place
//   - TWO blocks — "Bill To" and "Ship To" — when they genuinely differ
//
// The comparison is normalised, not raw string equality: the same address
// typed as "Plot 12, Ward 5/A" and "PLOT 12 WARD 5-A" is the same place, and
// printing it twice would be noise on the document.
// ---------------------------------------------------------------------------
function normAddr(...parts) {
  return parts
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")   // punctuation and case carry no meaning here
    .trim();
}

/** Address lines for one block, in print order. */
function addrLines(a) {
  return [
    ...[a.address, a.city].filter(Boolean).map((t) => String(t).toUpperCase()),
    a.state ? "STATE : " + String(a.state).toUpperCase() : "",
    a.pincode ? String(a.pincode) : "",
  ].filter(Boolean);
}

/**
 * Resolves a party into the block(s) the invoice should print.
 * Exported so the behaviour is unit-checkable without rendering a PDF.
 */
function resolveAddressBlocks(party, partyGstLabel) {
  const p = party || {};
  const billing = { address: p.address, city: p.city, state: p.state, pincode: p.pincode };
  const shipping = {
    address: p.shippingAddress,
    city: p.shippingCity,
    state: p.shippingState,
    pincode: p.shippingPincode,
  };

  const hasShipping = Boolean(
    shipping.address || shipping.city || shipping.state || shipping.pincode
  );
  const same =
    !hasShipping ||
    normAddr(billing.address, billing.city, billing.state, billing.pincode) ===
      normAddr(shipping.address, shipping.city, shipping.state, shipping.pincode);

  // Contact details belong to the party, not to either address, so they are
  // printed once — on the LAST block, where a reader looks for them.
  const contact = [
    p.phone ? "Ph.: " + p.phone : "",
    p.gstNo ? partyGstLabel + " : " + p.gstNo : "",
  ].filter(Boolean);

  if (same) {
    return [{ label: "Ship To", name: p.name, lines: [...addrLines(billing), ...contact] }];
  }
  return [
    { label: "Bill To", name: p.name, lines: addrLines(billing) },
    { label: "Ship To", name: p.name, lines: [...addrLines(shipping), ...contact] },
  ];
}

// ---------------------------------------------------------------------------
// Page sizes.
//
// The reference invoice this layout reproduces is **A5 landscape**
// (595.28 x 419.53pt = 210 x 148mm) — the usual Indian invoice stationery,
// and exactly what came back from measuring the supplied PDF's MediaBox. Note
// its width is identical to A4 PORTRAIT; only the height is halved. The
// renderer starts there and grows the page only when the real content will
// not fit (see fitLayout below), so a normal invoice prints on the stationery
// the business already uses.
// ---------------------------------------------------------------------------
const PAGE = {
  width: 595.28,          // A5 landscape width (== A4 portrait width)
  minHeight: 419.53,      // A5 landscape height
  maxHeight: 1190.0,      // A3 portrait height — hard ceiling before paginating
  maxWidth: 1190.0,       // A3 landscape width — hard ceiling for very wide tables
  margin: 24,
};

// Font sizes are a RANGE, not constants. fitLayout picks the largest size at
// which the real data still fits, so a small invoice prints comfortably large
// and a dense one shrinks instead of colliding or being truncated.
const FONT = {
  rowMax: 9.5,      // ceiling for the line-table body
  // Comfort floor. fitLayout will WIDEN THE PAGE before shrinking the table
  // text below this, because unreadable-but-on-A5 is the wrong trade. Only if
  // the page also hits PAGE.maxWidth does it shrink further, down to hardMin.
  // 7pt is the measured threshold at which a realistic 6-product invoice
  // (full product names, 5-digit amounts) still fits A5-landscape width —
  // which is exactly why the reference invoice uses 7pt. Holding the floor
  // here keeps normal invoices on the business's existing stationery; above
  // it fitLayout still uses the largest size that fits, so a short invoice
  // prints at up to rowMax.
  rowComfort: 7,
  hardMin: 5.6,
  step: 0.25,
};

// Fixed sizes for everything outside the line table, measured off the
// reference invoice (its raw Tf values x its 0.75 cm scale):
//   company name 15.96 | doc type & party name 9.96 | invoice no/date 9
//   address 8.04 | GST summary 6 | Net Amount 11.04
// These do NOT scale with the table font — the header should stay legible on
// a dense invoice, which is exactly when the table font gets squeezed.
const TYPE = {
  companyName: 16,
  docType: 10,
  docSub: 9.5,
  docMeta: 9,
  partyName: 10,
  body: 8,
  gstSummary: 6.2,
  footerLabel: 8,
  netAmount: 11,
  words: 7,
};

// Column definitions. \`weight\` only breaks ties when there is SPARE width to
// hand out; the actual widths come from measuring the real cell contents.
const COLS = [
  { key: "sr", label: "Sr.", align: "left", weight: 0 },
  { key: "product", label: "Name of Product", align: "left", weight: 10 },
  { key: "hsn", label: "HSN\nCode", align: "left", weight: 1 },
  { key: "mrp", label: "M.R.P.\nRs.", align: "right", weight: 0 },
  { key: "caseQty", label: "Case", align: "right", weight: 0 },
  { key: "pcsQty", label: "PCs", align: "right", weight: 0 },
  { key: "freeQty", label: "FQ", align: "right", weight: 0 },
  { key: "rate", label: "Rate\nRs.", align: "right", weight: 1 },
  { key: "amount", label: "Amount\nRs.", align: "right", weight: 1 },
  { key: "discount", label: "Discount\nRs.", align: "right", weight: 1 },
  { key: "taxable", label: "Taxable\nRs.", align: "right", weight: 1 },
  { key: "gstPct", label: "GST %", align: "right", weight: 0 },
  { key: "cgst", label: "CGST\nRs.", align: "right", weight: 1 },
  { key: "sgst", label: "SGST\nRs.", align: "right", weight: 1 },
  { key: "netValue", label: "Net\nValue Rs.", align: "right", weight: 1 },
];

// 15 columns means every point of per-cell padding costs 30pt of page width.
// 4pt a side pushed a realistic 6-product invoice off A5; the reference packs
// its columns noticeably tighter than that.
const CELL_PAD = 2.5;

// The printed string for one cell. Shared by the measuring pass and the
// drawing pass so they can never disagree about how wide something is —
// measuring one string and then printing a different one is exactly how a
// table silently overflows.
function cellText(col, l) {
  switch (col.key) {
    case "sr": return String(l.sr);
    case "product": return l.product || "";
    case "hsn": return l.hsn || "";
    case "mrp": return l.mrp ? money(l.mrp) : "";
    case "caseQty": return l.caseQty ? String(l.caseQty) : "";
    case "pcsQty": return l.pcsQty ? String(l.pcsQty) : "";
    case "freeQty": return l.freeQty ? String(l.freeQty) : "";
    case "rate": return money(l.rate);
    case "amount": return money(l.amount);
    case "discount": return money(l.discount);
    case "taxable": return money(l.taxable);
    case "gstPct": return money(l.gstPct) + "%";
    case "cgst": return money(l.cgst);
    case "sgst": return money(l.sgst);
    case "netValue": return money(l.netValue);
    default: return "";
  }
}

function totalText(col, t) {
  switch (col.key) {
    case "product": return "TOTAL :";
    case "caseQty": return t.caseQty ? String(t.caseQty) : "";
    case "pcsQty": return t.pcsQty ? String(t.pcsQty) : "";
    case "freeQty": return t.freeQty ? String(t.freeQty) : "";
    case "amount": return money(t.amount);
    case "discount": return money(t.discount);
    case "taxable": return money(t.taxable);
    case "cgst": return money(t.cgst);
    case "sgst": return money(t.sgst);
    case "netValue": return money(t.netValue);
    default: return "";
  }
}

/**
 * Decides the page size, font size and per-column widths from the ACTUAL data.
 *
 * Measuring beats guessing: a 7-figure amount or a long product name makes a
 * fixed-width column overflow into its neighbour, which is precisely the class
 * of bug that put the GST summary on top of the bank details. Here every
 * column is measured at the candidate font size and the largest size that
 * still fits is used; only if even the smallest size does not fit does the
 * page itself grow.
 */
function fitLayout(probe, m) {
  const avail0 = PAGE.width - PAGE.margin * 2;

  function measure(size) {
    probe.fontSize(size);
    const widths = COLS.map((c) => {
      probe.font("Helvetica-Bold");
      // headers are two physical lines; each must fit on its own
      const head = Math.max(...c.label.split("\n").map((s) => probe.widthOfString(s)));
      probe.font("Helvetica");
      let body = 0;
      for (const l of m.lines) body = Math.max(body, probe.widthOfString(cellText(c, l)));
      probe.font("Helvetica-Bold");
      body = Math.max(body, probe.widthOfString(totalText(c, m.totals)));
      return Math.max(head, body) + CELL_PAD * 2 + 0.5;
    });
    return { widths, total: widths.reduce((a, b) => a + b, 0) };
  }

  // Largest font that fits the base page width, but never shrink below the
  // comfort floor just to stay on A5 — widen the page for that instead.
  let size = FONT.rowMax;
  let best = measure(size);
  while (best.total > avail0 && size - FONT.step >= FONT.rowComfort) {
    size = +(size - FONT.step).toFixed(2);
    best = measure(size);
  }

  let pageWidth = PAGE.width;
  if (best.total > avail0) {
    // Doesn't fit at the comfort floor. Prefer a wider page over smaller text.
    pageWidth = Math.min(PAGE.maxWidth, best.total + PAGE.margin * 2);
    // Only if the page is already as wide as it may go do we shrink further.
    while (best.total > pageWidth - PAGE.margin * 2 && size - FONT.step >= FONT.hardMin) {
      size = +(size - FONT.step).toFixed(2);
      best = measure(size);
    }
  }

  const avail = pageWidth - PAGE.margin * 2;
  const widths = best.widths.slice();
  const slack = avail - best.total;
  if (slack > 0) {
    // Hand spare width to the columns that benefit from it (product name
    // first), rather than leaving a ragged right edge.
    const wsum = COLS.reduce((a, c) => a + c.weight, 0) || 1;
    COLS.forEach((c, i) => { widths[i] += (slack * c.weight) / wsum; });
  }
  return { size, widths, pageWidth };
}

function drawInvoice(doc, m, layout) {
  const L = doc.page.margins.left;
  const R = doc.page.width - doc.page.margins.right;
  const W = R - L;
  const FS = layout.size;

  // ---- Header: three columns -------------------------------------------
  const colB = L + W * 0.46;
  const colC = L + W * 0.70;
  const headTop = doc.y;
  const hs = TYPE.body;                 // fixed, reference-matched

  doc.font("Helvetica-Bold").fontSize(TYPE.companyName).fillColor("#000")
    .text(String(m.company?.name || "").toUpperCase(), L, headTop, { width: W * 0.45 });
  let y = doc.y + 2;
  doc.font("Helvetica").fontSize(hs).fillColor("#000");
  const compLines = [
    ...String(m.company?.address || "").split("\n").map((s) => s.trim()).filter(Boolean).map((s) => s.toUpperCase()),
    m.company?.state ? "State : " + m.company.state : "",
    [m.company?.phone, m.company?.mobile2].filter(Boolean).map((x) => "Mobile : " + x).join("  "),
    m.company?.email ? "email : " + m.company.email : "",
    m.company?.gstNo ? "GSTIN : " + m.company.gstNo : "",
  ].filter(Boolean);
  compLines.forEach((t) => { doc.text(t, L, y, { width: W * 0.45 }); y = doc.y; });
  const leftBottom = y;

  let yb = headTop;
  doc.font("Helvetica-Bold").fontSize(TYPE.docType).text(m.titles.main, colB, yb, { width: W * 0.23 });
  yb = doc.y + 2;
  // "Original" is bold on the reference too, not a light sub-label.
  doc.font("Helvetica-Bold").fontSize(TYPE.docSub).text(m.titles.copy || "Original", colB, yb, { width: W * 0.23 });
  yb = doc.y + 2;
  if (m.titles.sub) {
    doc.font("Helvetica-Bold").fontSize(TYPE.docSub).text(m.titles.sub, colB, yb, { width: W * 0.23 });
    yb = doc.y + 3;
  }
  const titleRuleY = yb - 2;
  doc.font("Helvetica-Bold").fontSize(TYPE.docMeta);
  doc.text(m.titles.noLabel + " :  " + m.no, colB, yb, { width: W * 0.23 });
  yb = doc.y + 1;
  doc.text(m.titles.dateLabel + " : " + fmtInvoiceDate(m.date), colB, yb, { width: W * 0.23 });
  const midBottom = doc.y;

  let yc = headTop;
  const blocks = resolveAddressBlocks(m.party, m.titles.partyGstLabel);
  doc.font("Helvetica-Bold").fontSize(hs)
    .text(blocks[0].label, colC, yc, { width: W * 0.30 });
  yc = doc.y + 3;
  blocks.forEach((b, bi) => {
    if (bi > 0) {
      // Separator + label for the second block, so "Bill To" and "Ship To"
      // never read as one run-on address.
      yc += 3;
      doc.lineWidth(0.4).strokeColor("#000")
        .moveTo(colC, yc).lineTo(colC + W * 0.29, yc).stroke();
      yc += 3;
      doc.font("Helvetica-Bold").fontSize(hs).fillColor("#000")
        .text(b.label, colC, yc, { width: W * 0.30 });
      yc = doc.y + 2;
    }
    doc.font("Helvetica-Bold").fontSize(TYPE.partyName)
      .text(String(b.name || "-").toUpperCase(), colC, yc, { width: W * 0.30 });
    yc = doc.y + 1;
    doc.font("Helvetica").fontSize(hs);
    b.lines.forEach((t) => { doc.text(t, colC, yc, { width: W * 0.30 }); yc = doc.y; });
  });

  const headBottom = Math.max(leftBottom, midBottom, yc) + 4;
  // Vertical dividers between the three header columns, and a rule under the
  // doc-type title block — both present in the reference invoice.
  doc.lineWidth(0.5).strokeColor("#000");
  doc.moveTo(colB - 6, headTop - 2).lineTo(colB - 6, headBottom).stroke();
  doc.moveTo(colC - 6, headTop - 2).lineTo(colC - 6, headBottom).stroke();
  doc.moveTo(colB - 6, titleRuleY).lineTo(colC - 6, titleRuleY).stroke();
  y = headBottom + 4;

  // ---- Line table ------------------------------------------------------
  const colX = [];
  let cx = L;
  layout.widths.forEach((w) => { colX.push({ x: cx, w }); cx += w; });

  const headLineH = FS + 1.5;
  const ROW_H = FS + 3.5;

  function rule(yy, lw) {
    doc.moveTo(L, yy).lineTo(R, yy).lineWidth(lw || 0.8).strokeColor("#000").stroke();
  }

  function drawTableHead() {
    rule(y);
    y += 2.5;
    doc.font("Helvetica-Bold").fontSize(Math.max(6, FS - 0.3)).fillColor("#000");
    const parts = COLS.map((c) => c.label.split("\n"));
    const rowCount = Math.max(...parts.map((a) => a.length));
    parts.forEach((ps, i) => ps.forEach((p, li) =>
      doc.text(fit(doc, p, colX[i].w - CELL_PAD * 2), colX[i].x + CELL_PAD, y + li * headLineH, {
        width: colX[i].w - CELL_PAD * 2, align: COLS[i].align, lineBreak: false,
      })));
    y += rowCount * headLineH + 2.5;
    rule(y);
    y += 2.5;
  }

  drawTableHead();

  const footerH = 172 + FS * 2;             // totals row + the three boxes
  const bottomLimit = doc.page.height - doc.page.margins.bottom - footerH;

  doc.font("Helvetica").fontSize(FS).fillColor("#000");
  m.lines.forEach((l) => {
    if (y + ROW_H > bottomLimit) {
      doc.addPage();
      y = doc.page.margins.top;
      drawTableHead();
      doc.font("Helvetica").fontSize(FS).fillColor("#000");
    }
    COLS.forEach((c, i) => {
      doc.text(fit(doc, cellText(c, l), colX[i].w - CELL_PAD * 2), colX[i].x + CELL_PAD, y, {
        width: colX[i].w - CELL_PAD * 2, align: c.align, lineBreak: false,
      });
    });
    y += ROW_H;
  });

  // ---- Footer: pinned to the BOTTOM of the page ------------------------
  // The reference invoice lets the item rows stop wherever they stop, leaves a
  // blank band, then prints the TOTAL row and the three boxes hard against the
  // bottom edge. Drawing them straight under the last row instead puts all the
  // dead space BELOW the footer, which is what made this look wrong.
  const b1 = L, b1w = W * 0.42;
  const b2 = b1 + b1w, b2w = W * 0.31;
  const b3 = b2 + b2w, b3w = W - b1w - b2w;
  const gRows = m.gstSummary.length;
  const gLineH = TYPE.gstSummary + 2.2;
  const rowsRightH = (TYPE.footerLabel + 4.5) * 3;
  const boxH = Math.max(118, 34 + gRows * gLineH + 16, TYPE.netAmount + TYPE.words + rowsRightH + 30);

  const totalBandH = FS + 11;                       // rule + TOTAL row + rule
  let boxTop = doc.page.height - doc.page.margins.bottom - boxH;
  let totalY = boxTop - totalBandH;

  // If the rows ran long enough to reach the reserved footer band, start a
  // fresh page so the footer is never printed over a data row.
  if (y > totalY - 2) {
    doc.addPage();
    y = doc.page.margins.top;
    drawTableHead();
    boxTop = doc.page.height - doc.page.margins.bottom - boxH;
    totalY = boxTop - totalBandH;
  }

  rule(totalY);
  doc.font("Helvetica-Bold").fontSize(FS);
  COLS.forEach((c, i) => {
    const v = totalText(c, m.totals);
    if (!v) return;
    doc.text(fit(doc, v, colX[i].w - CELL_PAD * 2), colX[i].x + CELL_PAD, totalY + 3.5, {
      width: colX[i].w - CELL_PAD * 2,
      align: c.key === "product" ? "right" : c.align,
      lineBreak: false,
    });
  });
  rule(boxTop);

  doc.lineWidth(0.6).strokeColor("#000");
  doc.rect(b1, boxTop, b1w, boxH).stroke();
  doc.rect(b2, boxTop, b2w, boxH).stroke();
  doc.rect(b3, boxTop, b3w, boxH).stroke();

  // (1) GST summary — widths proportional to the box, never fixed offsets.
  const gfs = TYPE.gstSummary;
  doc.font("Helvetica-Bold").fontSize(TYPE.footerLabel)
    .text("*** GST Summary ***", b1, boxTop + 3.5, { width: b1w, align: "center" });
  let gy = boxTop + TYPE.footerLabel + 7;
  const gPad = 5, gInner = b1w - gPad * 2;
  const gWeights = [0.13, 0.21, 0.14, 0.18, 0.14, 0.2];
  const gLabels = ["GST%", "TAXABLE", "CGST%", "CGST Rs.", "SGST%", "SGST Rs."];
  const gcols = [];
  let gx = b1 + gPad;
  gWeights.forEach((wt, i) => {
    const w = gInner * wt;
    gcols.push({ label: gLabels[i], x: gx, w, align: i === 0 ? "left" : "right" });
    gx += w;
  });
  doc.font("Helvetica-Bold").fontSize(gfs);
  gcols.forEach((c) => doc.text(fit(doc, c.label, c.w), c.x, gy, { width: c.w, align: c.align, lineBreak: false }));
  gy += gLineH;
  doc.font("Helvetica").fontSize(gfs);
  m.gstSummary.forEach((row) => {
    const vals = [money(row.slab) + "%", money(row.taxable), money(row.slab / 2) + "%", money(row.cgst), money(row.slab / 2) + "%", money(row.sgst)];
    gcols.forEach((c, i) => doc.text(fit(doc, vals[i], c.w), c.x, gy, { width: c.w, align: c.align, lineBreak: false }));
    gy += gLineH;
  });
  doc.moveTo(b1 + gPad, gy).lineTo(b1 + b1w - gPad, gy).lineWidth(0.5).stroke();
  gy += 2;
  doc.font("Helvetica-Bold").fontSize(gfs);
  ["TOTAL :", money(m.totals.taxable), "", money(m.totals.cgst), "", money(m.totals.sgst)].forEach((v, i) => {
    if (!v) return;
    doc.text(fit(doc, v, gcols[i].w), gcols[i].x, gy, { width: gcols[i].w, align: gcols[i].align, lineBreak: false });
  });

  // (2) jurisdiction / cheque note / bank / signature
  const mfs = TYPE.body - 1;
  let my = boxTop + 4;
  doc.font("Helvetica").fontSize(mfs).fillColor("#000");
  // Each block is separated by a rule across the box, matching the reference.
  function midRule(yy) {
    doc.moveTo(b2, yy).lineTo(b2 + b2w, yy).lineWidth(0.5).strokeColor("#000").stroke();
  }
  const midBlocks = [];
  if (m.company?.jurisdiction) {
    midBlocks.push(["Subject to " + m.company.jurisdiction + " Jurisdiction, E.& O.E."]);
  }
  if (Number(m.company?.chequeReturnCharges) > 0) {
    midBlocks.push(["Cheque Return Charges Rs." + money(m.company.chequeReturnCharges, 0) + "/-."]);
  }
  if (m.bank) {
    midBlocks.push([
      "Bank : " + (m.bank.bankName || ""),
      m.bank.ifscCode ? "IFSC : " + m.bank.ifscCode : "",
      m.bank.accountNumber ? "A/C No. : " + m.bank.accountNumber : "",
    ].filter(Boolean));
  }
  midBlocks.forEach((block, bi) => {
    block.forEach((t) => {
      doc.text(fit(doc, t, b2w - 8), b2 + 4, my, { width: b2w - 8, lineBreak: false });
      my = doc.y + 1;
    });
    my += 2;
    if (bi < midBlocks.length - 1) { midRule(my); my += 3; }
  });
  // Rule above the signature line.
  midRule(boxTop + boxH - (FS + 12));
  doc.font("Helvetica-Bold").fontSize(Math.max(7, FS))
    .text("For " + String(m.company?.name || "").toUpperCase(), b2 + 4, boxTop + boxH - (FS + 8), {
      width: b2w - 8, align: "center",
    });

  // (3) Add / Extra Less / Round Off / Net Amount
  const rfs = TYPE.footerLabel;
  let ry = boxTop + 5;
  doc.font("Helvetica-Bold").fontSize(rfs);
  [["Add", money(0)], ["Extra Less", money(0)], ["Round Off", money(m.roundOff)]].forEach(([k, v]) => {
    doc.text(k + "  :", b3 + 5, ry, { width: b3w * 0.5, lineBreak: false });
    doc.text(v, b3 + b3w * 0.5, ry, { width: b3w * 0.5 - 6, align: "right", lineBreak: false });
    ry += rfs + 4.5;
  });
  doc.moveTo(b3, ry).lineTo(b3 + b3w, ry).lineWidth(0.5).stroke();
  ry += 3.5;
  const nfs = TYPE.netAmount;
  doc.font("Helvetica-Bold").fontSize(nfs);
  doc.text("Net Amount :", b3 + 5, ry, { width: b3w * 0.52, lineBreak: false });
  doc.text(fit(doc, moneyIndian(m.rounded), b3w * 0.5 - 6), b3 + b3w * 0.5, ry, {
    width: b3w * 0.5 - 6, align: "right", lineBreak: false,
  });
  ry += nfs + 4;
  doc.moveTo(b3, ry).lineTo(b3 + b3w, ry).lineWidth(0.5).stroke();
  ry += 3;
  doc.font("Helvetica-Bold").fontSize(TYPE.words);
  doc.text("Bill Amt. : " + amountInWords(m.rounded), b3 + 5, ry, { width: b3w - 10 });
}

/**
 * Streams the invoice PDF to \`res\`.
 *
 * Two passes: a throwaway document measures the real content to choose the
 * page size and font, then the real document is created at that size. pdfkit
 * fixes a page's dimensions at creation time, so the size has to be known
 * before the first page exists.
 */
async function sendInvoicePdf(res, { doc: tx, company, party, bank, titles, filename, gstInclusive = false }) {
  const model = buildInvoiceModel({ doc: tx, company, party, bank, titles, gstInclusive });

  const probe = new PDFDocument({ size: [PAGE.width, PAGE.minHeight], margin: PAGE.margin });
  const layout = fitLayout(probe, model);

  // Grow the page height so a modest invoice still prints on one sheet;
  // beyond maxHeight drawInvoice paginates instead.
  // Taller now the letterhead is 16pt, and taller again when the party has a
  // separate Ship To address (two stacked blocks instead of one).
  const twoAddresses = resolveAddressBlocks(model.party, model.titles?.partyGstLabel).length > 1;
  const headerH = twoAddresses ? 196 : 128;
  const footerH = 172 + layout.size * 2;
  const rowsH = model.lines.length * (layout.size + 3.5) + 40;
  const pageHeight = Math.max(
    PAGE.minHeight,
    Math.min(PAGE.maxHeight, headerH + rowsH + footerH + PAGE.margin * 2)
  );

  const pdf = new PDFDocument({
    size: [layout.pageWidth, pageHeight],
    margin: PAGE.margin,
    layout: "portrait",
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="' + filename + '"');
  pdf.pipe(res);
  drawInvoice(pdf, model, layout);
  pdf.end();
}


function buildInvoiceModel({ doc: tx, company, party, bank, titles, gstInclusive = false }) {
  const items = Array.isArray(tx.items) ? tx.items : [];

  const lines = items.map((l, i) => {
    const taxable = Number(l.taxableValue || 0);
    const gstAmt = Number(l.gstAmount || 0);
    const gstPct = Number(l.gstPercent || 0);
    // Intra-state split. The app stores one combined gstAmount per line; a GST
    // invoice must show CGST and SGST separately, each at half the rate and
    // half the amount. (Inter-state IGST is not modelled anywhere in this app,
    // so there is nothing to branch on here.)
    const half = gstAmt / 2;
    // The printed invoice shows ONE "Discount Rs." column (not the four
    // Less%/CD%/lessRs/cdRs fields), and the reference layout balances as
    // Amount - Discount = Taxable, with Amount on an EX-GST basis.
    //
    // Purchase/Purchase Return store `amount` ex-GST already, so the
    // difference is purely discount. Sale/Sale Return store it GST-INCLUSIVE
    // (see CLAUDE.md quirk #24) — subtracting `taxable` straight from it
    // would report discount PLUS the whole GST as "discount", which is simply
    // a wrong number on a tax document. Convert to the ex-GST basis first.
    const rawAmount = Number(l.amount || 0);
    const amountExGst = gstInclusive ? rawAmount / (1 + gstPct / 100) : rawAmount;
    const discount = Math.max(0, amountExGst - taxable);
    return {
      sr: i + 1,
      product: l.itemName || "-",
      hsn: l.hsnCode || "",
      mrp: Number(l.mrp || 0),
      caseQty: Number(l.caseQty || 0),
      pcsQty: Number(l.pcsQty || 0),
      freeQty: Number(l.freeQty || 0),
      rate: Number(l.beforeGstRate || l.afterGstRate || 0),
      amount: amountExGst,
      discount,
      taxable,
      gstPct,
      cgst: half,
      sgst: half,
      netValue: Number(l.netValue || 0),
    };
  });

  const totals = lines.reduce(
    (a, l) => ({
      caseQty: a.caseQty + l.caseQty,
      pcsQty: a.pcsQty + l.pcsQty,
      freeQty: a.freeQty + l.freeQty,
      amount: a.amount + l.amount,
      discount: a.discount + l.discount,
      taxable: a.taxable + l.taxable,
      cgst: a.cgst + l.cgst,
      sgst: a.sgst + l.sgst,
      netValue: a.netValue + l.netValue,
    }),
    { caseQty: 0, pcsQty: 0, freeQty: 0, amount: 0, discount: 0, taxable: 0, cgst: 0, sgst: 0, netValue: 0 }
  );

  // One row per standard slab, so the summary box always has the same shape as
  // the reference invoice even when a slab is unused.
  const gstSummary = GST_SLABS.map((slab) => {
    const matching = lines.filter((l) => Math.abs(l.gstPct - slab) < 0.001);
    return {
      slab,
      taxable: matching.reduce((s, l) => s + l.taxable, 0),
      cgst: matching.reduce((s, l) => s + l.cgst, 0),
      sgst: matching.reduce((s, l) => s + l.sgst, 0),
    };
  });

  const netAmount = Number(tx.netAmount || totals.netValue);
  const rounded = Math.round(netAmount);
  const roundOff = rounded - netAmount;

  return {
    company,
    party,
    bank,
    titles,
    no: tx.invoiceNo || tx.returnNo || "-",
    date: tx.invoiceDate || tx.returnDate,
    lines,
    totals,
    gstSummary,
    netAmount,
    rounded,
    roundOff,
  };
}



module.exports = { sendInvoicePdf, buildInvoiceModel, amountInWords, numberToWordsIndian, resolveAddressBlocks };

// ---------------------------------------------------------------------------
// Shared context loader used by all four invoice endpoints.
//
// Lives here rather than being copy-pasted into each of the four controllers
// (which is this codebase's usual habit for transactional logic) because it
// is pure read-only assembly with no stock/payment side effects — the reason
// that duplication convention exists does not apply.
// ---------------------------------------------------------------------------
const Company = require("../models/Company");
const BankAccount = require("../models/BankAccount");
const Item = require("../models/Item");

/**
 * HSN lives on the Item master, not on the stored invoice line, so it has to
 * be joined per line. Scoped by companyId — never resolve an item reference
 * across tenants.
 */
async function attachHsnCodes(items, companyId) {
  const ids = [...new Set((items || []).map((l) => String(l.itemId)).filter(Boolean))];
  if (!ids.length) return items || [];
  const docs = await Item.find({ _id: { $in: ids }, companyId }).select("hsnCode").lean();
  const map = new Map(docs.map((d) => [String(d._id), d.hsnCode || ""]));
  return (items || []).map((l) => ({
    ...(typeof l.toObject === "function" ? l.toObject() : l),
    hsnCode: map.get(String(l.itemId)) || "",
  }));
}

/**
 * The bank block printed on the invoice. The transaction's OWN selected
 * payment bank always wins — that is what the user asked for ("whichever bank
 * is selected, its details come"). The company default is only a fallback so
 * a Cash transaction still prints usable remittance details.
 */
async function resolveInvoiceBank(tx, company) {
  const id = tx?.bankAccountId || company?.defaultBankAccountId;
  if (!id) return null;
  return BankAccount.findOne({ _id: id, companyId: company._id })
    .select("bankName accountNumber branch ifscCode")
    .lean();
}

async function loadCompanyForInvoice(companyId) {
  return Company.findById(companyId)
    .select("name address phone mobile2 email gstNo state jurisdiction chequeReturnCharges defaultBankAccountId")
    .lean();
}

module.exports.attachHsnCodes = attachHsnCodes;
module.exports.resolveInvoiceBank = resolveInvoiceBank;
module.exports.loadCompanyForInvoice = loadCompanyForInvoice;

