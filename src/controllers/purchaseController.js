const Purchase = require("../models/Purchase");
const Item = require("../models/Item");
const Godown = require("../models/Godown");
const { searchRegex, clampLimit, clampPage } = require("../utils/queryHelpers");

// Finds which of the item's mrpEntries the client is purchasing against, by
// matching on MRP (guaranteed unique per item) — never trusts client-supplied
// packing/purchaseQty directly, only uses them to look up the server's own record.
function findMatchedRateEntry(raw, item) {
  const rawMrp = raw.mrp !== undefined ? parseFloat(raw.mrp) : undefined;
  if (rawMrp === undefined || !Array.isArray(item.mrpEntries)) return null;
  return item.mrpEntries.find((e) => parseFloat(e.mrp) === rawMrp) || null;
}

// Recomputes every derived value for a single purchase line from the raw
// entry fields — the client's computed numbers are never trusted directly.
function computeLine(raw, item) {
  const matchedEntry = findMatchedRateEntry(raw, item);
  const packing = parseFloat(matchedEntry?.packing ?? item.packing) || 1;
  const purchaseQty = parseFloat(matchedEntry?.purchaseQty ?? item.purchaseQty) || 1;

  const caseQty = parseFloat(raw.caseQty) || 0;
  const pcsQty = parseFloat(raw.pcsQty) || 0;
  const freeQty = parseFloat(raw.freeQty) || 0;
  const beforeGstRate = parseFloat(raw.beforeGstRate) || 0;
  const lessPercent = parseFloat(raw.lessPercent) || 0;
  const lessRs = parseFloat(raw.lessRs) || 0;
  const cdPercent = parseFloat(raw.cdPercent) || 0;
  const cdRs = parseFloat(raw.cdRs) || 0;
  const gstPercent = parseFloat(raw.gstPercent ?? item.gstPercentage) || 0;

  // Never trust the client to have blocked negative input — a negative quantity or
  // rate here would silently corrupt Item stock via applyStockDelta. gstPercent was
  // previously missing from this list — every other numeric field on the line was
  // checked, but a negative gstPercent could drive netValue below taxableValue,
  // bypassing the lessAmt+cdAmt discount-cap check a few lines below (which only
  // guards against the discount fields doing the same thing).
  if (
    caseQty < 0 || pcsQty < 0 || freeQty < 0 || beforeGstRate < 0 || lessRs < 0 || cdRs < 0 ||
    lessPercent < 0 || cdPercent < 0 || gstPercent < 0 || gstPercent > 100
  ) {
    throw new Error(`Quantities and rates cannot be negative (item: ${item.itemName})`);
  }
  if (caseQty === 0 && pcsQty === 0) {
    throw new Error(`Enter a Case or Pcs quantity greater than 0 (item: ${item.itemName})`);
  }
  // Each line now owns its own godown — required so applyStockDelta/assertSufficientStock
  // know which per-godown stock bucket this line's quantity affects.
  if (!raw.godownId) {
    throw new Error(`Godown is required for each item line (item: ${item.itemName})`);
  }

  const billedPieces = caseQty * packing + pcsQty;
  const totalPieces = billedPieces + freeQty;
  const pricePerPiece = purchaseQty > 0 ? beforeGstRate / purchaseQty : 0;

  const amount = pricePerPiece * billedPieces;
  const lessAmt = (amount * lessPercent) / 100 + lessRs;
  const cdAmt = (amount * cdPercent) / 100 + cdRs;
  // Discounts can never exceed the line's own amount — otherwise taxableValue/netValue
  // go negative with no error anywhere, silently corrupting the invoice total.
  if (lessAmt + cdAmt > amount + 1e-6) {
    throw new Error(`Discounts cannot exceed the line amount (item: ${item.itemName})`);
  }
  const taxableValue = amount - lessAmt - cdAmt;
  const gstAmount = (taxableValue * gstPercent) / 100;
  const netValue = taxableValue + gstAmount;

  // Express the discounted/after-GST rate on the same basis as beforeGstRate (per
  // purchaseQty units) by scaling taxableValue back up from its billedPieces basis —
  // this folds in flat-Rs discounts (lessRs/cdRs) the same way percent discounts are,
  // which the old formula (recomputing straight from beforeGstRate) silently ignored.
  const discountedRate =
    billedPieces > 0
      ? (taxableValue / billedPieces) * purchaseQty
      : beforeGstRate - (beforeGstRate * (lessPercent + cdPercent)) / 100;
  const afterGstRate = discountedRate + (discountedRate * gstPercent) / 100;

  return {
    itemId: item._id,
    itemName: item.itemName,
    packing,
    purchaseQty,
    mrp: raw.mrp !== undefined ? parseFloat(raw.mrp) || 0 : parseFloat(item.mrp) || 0,
    godownId: raw.godownId,
    caseQty,
    pcsQty,
    freeQty,
    totalPieces,
    beforeGstRate,
    lessPercent,
    lessRs,
    cdPercent,
    cdRs,
    afterGstRate,
    amount,
    taxableValue,
    gstPercent,
    gstAmount,
    netValue,
  };
}

function computeTotals(lines) {
  return lines.reduce(
    (acc, l) => {
      acc.totalItems += 1;
      acc.totalCase += l.caseQty;
      acc.totalPcs += l.pcsQty;
      acc.totalQty += l.totalPieces;
      acc.totalTaxableValue += l.taxableValue;
      acc.totalGstAmount += l.gstAmount;
      acc.totalAmount += l.amount;
      acc.netAmount += l.netValue;
      return acc;
    },
    {
      totalItems: 0,
      totalCase: 0,
      totalPcs: 0,
      totalQty: 0,
      totalTaxableValue: 0,
      totalGstAmount: 0,
      totalAmount: 0,
      netAmount: 0,
    }
  );
}

// Builds validated + recomputed lines from raw client input, keyed against the real
// Item documents (rate/gst/packing snapshots come from the DB, not the client). Both
// Items and Godowns are scoped to `companyId` — without this, a line whose
// itemId/godownId belongs to a DIFFERENT company would still resolve successfully
// and applyStockDelta would silently mutate that other company's live stock.
async function buildLines(rawItems, companyId) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error("At least one item is required");
  }

  const itemIds = rawItems.map((r) => r.itemId);
  const items = await Item.find({ _id: { $in: itemIds }, companyId });
  const itemMap = new Map(items.map((i) => [String(i._id), i]));

  const godownIds = [...new Set(rawItems.map((r) => r.godownId).filter(Boolean))];
  const godowns = await Godown.find({ _id: { $in: godownIds }, companyId });
  const allowedGodownIds = new Set(godowns.map((g) => String(g._id)));

  return rawItems.map((raw) => {
    const item = itemMap.get(String(raw.itemId));
    if (!item) {
      throw new Error(`Item not found: ${raw.itemId}`);
    }
    if (raw.godownId && !allowedGodownIds.has(String(raw.godownId))) {
      throw new Error(`Godown not found: ${raw.godownId}`);
    }
    return computeLine(raw, item);
  });
}

// sign = +1 to apply a purchase's stock effect, -1 to reverse it. Each line carries
// its own godownId, identifying which physical warehouse bucket that line's stock
// moves in/out of — a single purchase can span several godowns across its lines.
// `companyId` scopes the Item lookup so a line can never mutate a different
// company's Item document.
//
// Item/MRP-entry flat opening-stock fields are incremented directly (never recomputed
// as a sum of godownStock buckets) — Items add/edit lets a user set opening stock
// without picking a godown at all, so those buckets don't necessarily cover the whole
// flat total. godownStock[] is purely a Purchase-driven, godown-scoped view alongside
// the flat total, not its source of truth.
async function applyOneLine(line, sign, companyId) {
  const item = await Item.findOne({ _id: line.itemId, companyId });
  if (!item) return;

  const packing = parseFloat(item.packing) || 1;

  const matchedEntry = findMatchedRateEntry(line, item);
  if (matchedEntry) {
    const entryPacking = parseFloat(matchedEntry.packing) || 1;
    const entryNewPcs = (parseFloat(matchedEntry.openingStockFreshPcs) || 0) + sign * line.totalPieces;
    matchedEntry.openingStockFreshPcs = entryNewPcs;
    matchedEntry.openingStockFreshCase = entryPacking > 0 ? entryNewPcs / entryPacking : entryNewPcs;

    if (!Array.isArray(matchedEntry.godownStock)) matchedEntry.godownStock = [];
    let bucket = matchedEntry.godownStock.find((g) => String(g.godownId) === String(line.godownId));
    if (!bucket) {
      bucket = {
        godownId: line.godownId,
        openingStockFreshCase: 0,
        openingStockFreshPcs: 0,
        openingStockExpiredCase: 0,
        openingStockExpiredPcs: 0,
        openingStockDamagedCase: 0,
        openingStockDamagedPcs: 0,
      };
      matchedEntry.godownStock.push(bucket);
      bucket = matchedEntry.godownStock[matchedEntry.godownStock.length - 1];
    }
    const bucketNewPcs = (parseFloat(bucket.openingStockFreshPcs) || 0) + sign * line.totalPieces;
    bucket.openingStockFreshPcs = bucketNewPcs;
    bucket.openingStockFreshCase = entryPacking > 0 ? bucketNewPcs / entryPacking : bucketNewPcs;

    if (sign > 0) {
      matchedEntry.netCostSelfPerPiece = line.afterGstRate / entryPacking;
    }
    item.markModified("mrpEntries");
  }

  const newPcs = (parseFloat(item.openingStockFreshPcs) || 0) + sign * line.totalPieces;
  item.openingStockFreshPcs = newPcs;
  item.openingStockFreshCase = packing > 0 ? newPcs / packing : newPcs;

  if (sign > 0) {
    item.lastCostRate = line.afterGstRate;
    item.purchaseRate = line.beforeGstRate;
  }

  await item.save();
}

// Self-healing against a partial mid-loop failure: if line N of a multi-line
// invoice throws (a transient write error, not a validation error — those
// are all caught earlier in computeLine/buildLines before this ever runs),
// lines 1..N-1 already committed their stock delta with no way to undo them
// on their own. Track what actually succeeded and reverse exactly that
// before re-throwing, so a caller never has to reason about "how far did it
// get" — a failed applyStockDelta call is guaranteed to leave stock exactly
// as it found it. This is what makes createX's "delete the doc on stock-
// apply failure" compensating action actually sufficient (nothing else is
// left to reverse), and what makes updateX's initial "reverse the old
// lines" call safe to run outside its own try/catch — a failure there now
// can't leave a half-reversed invoice with no way back.
async function applyStockDelta(lines, sign, companyId) {
  const applied = [];
  try {
    for (const line of lines) {
      await applyOneLine(line, sign, companyId);
      applied.push(line);
    }
  } catch (err) {
    for (let i = applied.length - 1; i >= 0; i--) {
      try {
        await applyOneLine(applied[i], -sign, companyId);
      } catch (rollbackErr) {
        console.error("applyStockDelta: failed to roll back a partially-applied line — stock may be desynced", rollbackErr);
      }
    }
    throw err;
  }
}

// Purchase only ever ADDS stock when created, so createPurchase never needed a
// sufficiency check — but deleting or reducing a purchase REMOVES stock that may
// have already been consumed by a downstream Sale or Purchase Return. Mirrors
// saleController.assertSufficientStock exactly; used only by delete/update below,
// checked against CURRENT stock before the removal is allowed to proceed.
// `companyId` scopes the Item lookup to prevent cross-tenant reads.
async function assertSufficientStock(lines, companyId) {
  const neededByKey = new Map();
  const nameByKey = new Map();
  for (const line of lines) {
    const key = `${line.itemId}|${line.mrp}|${String(line.godownId)}`;
    neededByKey.set(key, (neededByKey.get(key) || 0) + line.totalPieces);
    nameByKey.set(key, line.itemName);
  }

  for (const [key, needed] of neededByKey.entries()) {
    const [itemId, mrpStr, godownIdStr] = key.split("|");
    const mrp = parseFloat(mrpStr);
    const item = await Item.findOne({ _id: itemId, companyId });
    if (!item) continue;
    const matchedEntry = Array.isArray(item.mrpEntries)
      ? item.mrpEntries.find((e) => parseFloat(e.mrp) === mrp)
      : null;
    // A line whose MRP never matched any real mrpEntries tier (e.g. a typo'd MRP)
    // never touched a godownStock bucket in the first place when it was applied —
    // applyStockDelta only writes flat fields for it. Reversing such a line only
    // ever undoes that same unconditional flat-field delta, which is always safe;
    // there is no bucket to be insufficient against, so skip the check for it.
    if (!matchedEntry) continue;
    const bucket = matchedEntry.godownStock?.find((g) => String(g.godownId) === godownIdStr);
    const available = parseFloat(bucket?.openingStockFreshPcs) || 0;
    if (available < needed) {
      throw new Error(
        `Cannot remove this purchase — "${nameByKey.get(key)}" only has ${available} pcs left in the selected godown, but removing this purchase would need to take back ${needed} pcs (the rest has already been sold or returned elsewhere)`
      );
    }
  }
}

const getPurchases = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, search = "", dateFrom, dateTo } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const query = { companyId };
    if (search) query.invoiceNo = searchRegex(search);
    if (dateFrom || dateTo) {
      query.invoiceDate = {};
      if (dateFrom) query.invoiceDate.$gte = new Date(`${dateFrom}T00:00:00.000Z`);
      if (dateTo) query.invoiceDate.$lte = new Date(`${dateTo}T23:59:59.999Z`);
    }

    const parsedPage = clampPage(page);
    const parsedLimit = clampLimit(limit);
    const skip = (parsedPage - 1) * parsedLimit;

    const [purchases, total] = await Promise.all([
      Purchase.find(query)
        .sort({ invoiceDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit)
        .lean(),
      Purchase.countDocuments(query),
    ]);

    res.status(200).json({
      data: purchases,
      pagination: {
        total,
        page: parsedPage,
        limit: parsedLimit,
        totalPages: Math.ceil(total / parsedLimit),
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const getPurchaseById = async (req, res) => {
  try {
    const purchase = await Purchase.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!purchase) {
      return res.status(404).json({ message: "Purchase not found" });
    }
    res.status(200).json(purchase);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const createPurchase = async (req, res) => {
  let purchase;
  try {
    const { companyId, invoiceNo, invoiceDate, receivingDate, ewayBillNo, notes, items, paidAmount, dueDate } = req.body;

    if (!companyId || !invoiceNo || !invoiceDate) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const exists = await Purchase.findOne({ companyId, invoiceNo: invoiceNo.trim() });
    if (exists) {
      return res.status(400).json({ message: "This invoice number already exists" });
    }

    const lines = await buildLines(items, companyId);
    const totals = computeTotals(lines);
    const paid = parseFloat(paidAmount) || 0;

    purchase = await Purchase.create({
      companyId,
      invoiceNo: invoiceNo.trim(),
      invoiceDate,
      receivingDate: receivingDate || null,
      ewayBillNo: ewayBillNo || "",
      notes: notes || "",
      items: lines,
      ...totals,
      paidAmount: paid,
      pendingAmount: totals.netAmount - paid,
      dueDate: dueDate || null,
    });

    try {
      await applyStockDelta(lines, 1, companyId);
    } catch (stockErr) {
      // The document already committed but its stock effect failed partway through —
      // delete it rather than leave a Purchase on the books with no matching stock change.
      await Purchase.deleteOne({ _id: purchase._id });
      throw stockErr;
    }

    res.status(201).json(purchase);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const updatePurchase = async (req, res) => {
  try {
    const purchase = await Purchase.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!purchase) {
      return res.status(404).json({ message: "Purchase not found" });
    }
    const companyId = purchase.companyId;
    // Captured before any mutation — `purchase.items` is reassigned below, so the
    // rollback path (if buildLines/`.save()`/the reapply throws) must reverse using
    // this original snapshot, not whatever `purchase.items` has since become.
    const oldItems = purchase.items;

    const { invoiceNo, invoiceDate, receivingDate, ewayBillNo, notes, items, paidAmount, dueDate } = req.body;

    if (invoiceNo && invoiceNo.trim() !== purchase.invoiceNo) {
      const exists = await Purchase.findOne({
        companyId: purchase.companyId,
        invoiceNo: invoiceNo.trim(),
        _id: { $ne: purchase._id },
      });
      if (exists) {
        return res.status(400).json({ message: "This invoice number already exists" });
      }
    }

    // Reversing this purchase's OLD stock effect can only proceed if that stock is
    // still actually there — some of it may have already moved out via a downstream
    // Sale or Purchase Return. Check BEFORE touching anything. Each old line already
    // carries its own godownId, so this reverses each line against its own godown —
    // no shared "old godown" concept needed even though lines can span several.
    await assertSufficientStock(oldItems, companyId);
    await applyStockDelta(oldItems, -1, companyId);

    try {
      const lines = await buildLines(items || oldItems, companyId);
      const totals = computeTotals(lines);

      if (invoiceNo) purchase.invoiceNo = invoiceNo.trim();
      if (invoiceDate) purchase.invoiceDate = invoiceDate;
      if (receivingDate !== undefined) purchase.receivingDate = receivingDate || null;
      if (ewayBillNo !== undefined) purchase.ewayBillNo = ewayBillNo;
      if (notes !== undefined) purchase.notes = notes;
      purchase.items = lines;
      Object.assign(purchase, totals);

      const paid = paidAmount !== undefined ? parseFloat(paidAmount) || 0 : purchase.paidAmount;
      purchase.paidAmount = paid;
      purchase.pendingAmount = totals.netAmount - paid;
      if (dueDate !== undefined) purchase.dueDate = dueDate || null;

      // The field mutation + save + reapply must all succeed together, or the
      // reversal above must be undone — otherwise a validation/cast error thrown by
      // `.save()` itself (not caught by buildLines, which never touches Mongoose
      // validation) leaves the document unchanged in the DB while its stock has
      // already been taken back, and a retry of the same bad request removes it again.
      await purchase.save();
      await applyStockDelta(lines, 1, companyId);
    } catch (err) {
      await applyStockDelta(oldItems, 1, companyId);
      throw err;
    }

    res.status(200).json(purchase);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const deletePurchase = async (req, res) => {
  try {
    const purchase = await Purchase.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!purchase) {
      return res.status(404).json({ message: "Purchase not found" });
    }

    await assertSufficientStock(purchase.items, purchase.companyId);
    await applyStockDelta(purchase.items, -1, purchase.companyId);
    await purchase.deleteOne();

    res.status(200).json({ message: "Purchase deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getPurchases,
  getPurchaseById,
  createPurchase,
  updatePurchase,
  deletePurchase,
};
