// Generic PDF text-collision detector.
//
// Decodes every text-showing operator out of a generated PDF (position, font,
// size), re-measures each string with pdfkit's own font metrics, and reports
// any two strings on the same baseline whose boxes physically overlap — i.e.
// text printed on top of other text.
//
// Written after a real bug: the invoice's GST Summary column ran past its box
// and printed over the bank details. Eyeballing a PDF does not catch that, and
// `pdftotext -layout` has misread this codebase's PDFs three separate times.
//
//   node tools/pdf-overlap-check.js <file.pdf> [...]
const zlib = require("zlib");
const fs = require("fs");
const PDFDocument = require("pdfkit");

const FONTS = { F1: "Helvetica", F2: "Helvetica-Bold", F3: "Helvetica-Oblique" };

function extract(file) {
  const buf = fs.readFileSync(file);
  const out = [];
  let i = 0, page = 0;
  while (true) {
    const s = buf.indexOf("stream", i);
    if (s < 0) break;
    let st = s + 6;
    if (buf[st] === 13) st++;
    if (buf[st] === 10) st++;
    const e = buf.indexOf("endstream", st);
    if (e < 0) break;
    try {
      const txt = zlib.inflateSync(buf.slice(st, e)).toString("latin1");
      if (txt.includes("TJ") || txt.includes("Tj")) {
        page++;
        const re = /1 0 0 1 ([\d.-]+) ([\d.-]+) Tm\s*\/(F\d+) ([\d.]+) Tf\s*\[([\s\S]*?)\]\s*TJ/g;
        let m;
        while ((m = re.exec(txt))) {
          const str = [...m[5].matchAll(/<([0-9a-fA-F]+)>/g)]
            .map((h) => Buffer.from(h[1], "hex").toString("latin1")).join("");
          if (str.trim()) out.push({ page, x: +m[1], y: +m[2], font: m[3], size: +m[4], t: str });
        }
      }
    } catch (_) { /* not a flate text stream */ }
    i = e + 9;
  }
  return out;
}

function check(file) {
  const probe = new PDFDocument();
  let items;
  try { items = extract(file); } catch (e) { return { file, error: e.message }; }
  if (!items.length) return { file, error: "no decodable text" };

  items.forEach((o) => {
    probe.font(FONTS[o.font] || "Helvetica").fontSize(o.size);
    o.w = probe.widthOfString(o.t);
    o.right = o.x + o.w;
  });

  // group by page + baseline (rounded, so near-identical baselines compare)
  const rows = new Map();
  items.forEach((o) => {
    const k = `${o.page}|${Math.round(o.y * 2) / 2}`;
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k).push(o);
  });

  const hits = [];
  for (const [k, group] of rows) {
    const g = group.slice().sort((a, b) => a.x - b.x);
    for (let i = 1; i < g.length; i++) {
      const prev = g[i - 1], cur = g[i];
      const gap = cur.x - prev.right;
      if (gap < -0.5) {
        hits.push({ row: k, a: prev.t, b: cur.t, overlap: (-gap).toFixed(1) });
      }
    }
  }
  return { file, strings: items.length, pages: Math.max(...items.map((o) => o.page)), hits };
}

const files = process.argv.slice(2);
let bad = 0;
for (const f of files) {
  const r = check(f);
  const name = f.split(/[\/]/).pop();
  if (r.error) { console.log(`  ?  ${name.padEnd(34)} ${r.error}`); continue; }
  if (r.hits.length) {
    bad++;
    console.log(`  ✗  ${name.padEnd(34)} ${r.hits.length} collision(s), ${r.pages}p`);
    r.hits.slice(0, 4).forEach((h) =>
      console.log(`        "${h.a.slice(0, 26)}" over "${h.b.slice(0, 26)}"  (${h.overlap}pt)`));
  } else {
    console.log(`  ok ${name.padEnd(34)} ${r.strings} strings, ${r.pages}p — no collisions`);
  }
}
process.exit(bad ? 1 : 0);
