/**
 * EXPORT THEME — single source of truth for colours in generated files.
 *
 * Mirrors the frontend's design tokens in `globals.css` (Indigo brand +
 * Light Lavender lines + Indigo-950 ink). Every Excel sheet and PDF the
 * backend produces must pull its colours from here, so a re-skin changes
 * one file instead of hunting hex literals across three controllers.
 *
 * Two formats, because the two libraries want different things:
 *   - `XLSX.*`  ARGB strings ("FF" + RRGGBB) for exceljs fills/fonts
 *   - `PDF.*`   plain "#rrggbb" strings for pdfkit fill/stroke
 */

// Raw brand palette (matches globals.css exactly)
const BRAND_600 = "4F46E5"; // primary — header bands
const BRAND_700 = "4338CA"; // deeper brand — total rows
const BRAND_100 = "E0E7FF"; // soft brand — grouping/subtotal rows
const BRAND_50 = "EEF2FF"; // lightest brand — zebra striping
const LINE = "E5E7F0"; // Light Lavender Gray — borders
const INK = "1E1B4B"; // Indigo 950 — body text
const INK_MUTED = "6B7280"; // Gray 500 — captions
const WHITE = "FFFFFF";

const XLSX = {
  headerBg: `FF${BRAND_600}`,
  headerText: `FF${WHITE}`,
  zebraBg: `FF${BRAND_50}`,
  groupBg: `FF${BRAND_100}`,
  totalBg: `FF${BRAND_700}`,
  totalText: `FF${WHITE}`,
  border: `FF${LINE}`,
  bodyText: `FF${INK}`,
  mutedText: `FF${INK_MUTED}`,
};

const PDF = {
  headerBg: `#${BRAND_600}`,
  headerText: `#${WHITE}`,
  zebraBg: `#${BRAND_50}`,
  groupBg: `#${BRAND_100}`,
  totalBg: `#${BRAND_100}`,
  totalText: `#${BRAND_700}`,
  border: `#${LINE}`,
  bodyText: `#${INK}`,
  mutedText: `#${INK_MUTED}`,
  accent: `#${BRAND_600}`,
};

/**
 * Standard thin border for an exceljs cell, in the theme's line colour.
 * exceljs wants this repeated per cell, so it's built fresh each call —
 * sharing one frozen object across cells is a known exceljs footgun.
 */
function xlsxBorder() {
  const side = { style: "thin", color: { argb: XLSX.border } };
  return { top: side, left: side, bottom: side, right: side };
}

/** Applies the themed header-row styling to an exceljs row. */
function styleHeaderRow(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: XLSX.headerText }, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XLSX.headerBg } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = xlsxBorder();
  });
  row.height = 22;
}

/** Applies the themed total-row styling to an exceljs row. */
function styleTotalRow(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: XLSX.totalText }, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XLSX.totalBg } };
    cell.border = xlsxBorder();
  });
  row.height = 20;
}

/** Zebra-stripes a data row (even rows get the lightest brand tint). */
function styleDataRow(row, index) {
  row.eachCell((cell) => {
    cell.font = { color: { argb: XLSX.bodyText }, size: 10 };
    cell.border = xlsxBorder();
    if (index % 2 === 0) {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XLSX.zebraBg } };
    }
  });
}

module.exports = { XLSX, PDF, xlsxBorder, styleHeaderRow, styleTotalRow, styleDataRow };
