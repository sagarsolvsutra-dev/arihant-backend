const SaleReturn = require("../models/SaleReturn");
const Sale = require("../models/Sale");
const Item = require("../models/Item");
const Godown = require("../models/Godown");
const { searchRegex, clampLimit, clampPage } = require("../utils/queryHelpers");

// Identical to saleController.findMatchedRateEntry — MRP is the identity key.
function findMatchedRateEntry(raw, item) {
  const rawMrp = raw.mrp !== undefined ? parseFloat(raw.mrp) : undefined;
  if (rawMrp === undefined || !Array.isArray(item.mrpEntries)) return null;
  return item.mrpEntries.find((e) => parseFloat(e.mrp) === rawMrp) || null;
}

// Identical to saleController.computeLine — a Sale Return is entered the same way a
// Sale is (GST-inclusive afterGstRate); only the stock direction differs.
function computeLine(raw, item) {
  const matchedEntry = findMatchedRateEntry(raw, item);
  const packing = parseFloat(matchedEntry?.packing ?? item.packing) || 1;
  const salesQty = parseFloat(matchedEntry?.salesQty ?? item.salesQty) || 1;

  const caseQty = parseFloat(raw.caseQty) || 0;
  const pcsQty = parseFloat(raw.pcsQty) || 0;
  const freeQty = parseFloat(raw.freeQty) || 0;
  const afterGstRate = parseFloat(raw.afterGstRate) || 0;
  const lessPercent = parseFloat(raw.lessPercent) || 0;
  const lessRs = parseFloat(raw.lessRs) || 0;
  const cdPercent = parseFloat(raw.cdPercent) || 0;
  const cdRs = parseFloat(raw.cdRs) || 0;
  const gstPercent = parseFloat(raw.gstPercent ?? item.gstPercentage) || 0;

  if (
    caseQty < 0 || pcsQty < 0 || freeQty < 0 || afterGstRate < 0 || lessRs < 0 || cdRs < 0 ||
    lessPercent < 0 || cdPercent < 0 || gstPercent < 0 || gstPercent > 100
  ) {
    throw new Error(`Quantities and rates cannot be negative (item: ${item.itemName})`);
  }
  if (caseQty === 0 && pcsQty === 0) {
    throw new Error(`Enter a Case or Pcs quantity greater than 0 (item: ${item.itemName})`);
  }
  // Each line now owns its own godown — required so applyStockDelta knows which
  // per-godown stock bucket this line's quantity affects.
  if (!raw.godownId) {
    throw new Error(`Godown is required for each item line (item: ${item.itemName})`);
  }

  const billedPieces = caseQty * packing + pcsQty;
  const totalPieces = billedPieces + freeQty;
  const pricePerPiece = salesQty > 0 ? afterGstRate / salesQty : 0;

  const amount = pricePerPiece * billedPieces;
  const lessAmt = (amount * lessPercent) / 100 + lessRs;
  const cdAmt = (amount * cdPercent) / 100 + cdRs;
  // Discounts can never exceed the line's own amount — otherwise taxableValue/netValue
  // go negative with no error anywhere, silently corrupting the return total.
  if (lessAmt + cdAmt > amount + 1e-6) {
    throw new Error(`Discounts cannot exceed the line amount (item: ${item.itemName})`);
  }
  const netValue = amount - lessAmt - cdAmt;
  const taxableValue = gstPercent > 0 ? netValue / (1 + gstPercent / 100) : netValue;
  const gstAmount = netValue - taxableValue;

  const beforeGstRate =
    billedPieces > 0
      ? (taxableValue / billedPieces) * salesQty
      : (afterGstRate / (1 + gstPercent / 100)) -
        ((afterGstRate / (1 + gstPercent / 100)) * (lessPercent + cdPercent)) / 100;

  return {
    itemId: item._id,
    itemName: item.itemName,
    packing,
    salesQty,
    mrp: raw.mrp !== undefined ? parseFloat(raw.mrp) || 0 : parseFloat(item.mrp) || 0,
    godownId: raw.godownId,
    caseQty,
    pcsQty,
    freeQty,
    totalPieces,
    afterGstRate,
    lessPercent,
    lessRs,
    cdPercent,
    cdRs,
    beforeGstRate,
    amount,
    taxableValue,
    gstPercent,
    gstAmount,
    netValue,
    condition: ["Fresh", "Expired", "Damaged"].includes(raw.condition) ? raw.condition : "Fresh",
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

// If the return is linked to an original Sale invoice, each return line can't return
// more than that invoice billed for the matching item+MRP. Not cumulative across
// multiple return invoices against the same original — a known, documented scope cut.
function validateAgainstOriginal(lines, originalItems) {
  if (!Array.isArray(originalItems) || originalItems.length === 0) return;

  const billedByKey = new Map();
  for (const orig of originalItems) {
    const key = `${orig.itemId}|${orig.mrp}`;
    const billed = (orig.caseQty || 0) * (orig.packing || 1) + (orig.pcsQty || 0);
    billedByKey.set(key, (billedByKey.get(key) || 0) + billed);
  }

  const returningByKey = new Map();
  for (const line of lines) {
    const key = `${line.itemId}|${line.mrp}`;
    const billed = line.caseQty * line.packing + line.pcsQty;
    returningByKey.set(key, (returningByKey.get(key) || 0) + billed);
  }

  for (const [key, returning] of returningByKey.entries()) {
    const originallyBilled = billedByKey.get(key) || 0;
    if (returning > originallyBilled) {
      const line = lines.find((l) => `${l.itemId}|${l.mrp}` === key);
      throw new Error(
        `Cannot return more than was originally sold for "${line?.itemName}" (originally billed: ${originallyBilled} pcs, returning: ${returning} pcs)`
      );
    }
  }
}

// A REDUCTION of a Sale Return (editing it down, or deleting it) removes stock that
// must actually still be present in the condition-specific bucket it was originally
// added to — some of it may have already moved out via a downstream Sale/Transfer.
// Mirrors purchaseController.assertSufficientStock, but keyed by condition too, since
// Sale Return routes into Fresh/Expired/Damaged buckets independently (see
// applyStockDelta below). Only used before a decrementing (`sign=-1`) call.
async function assertSufficientStock(lines, companyId) {
  const neededByKey = new Map();
  const nameByKey = new Map();
  for (const line of lines) {
    const cond = ["Fresh", "Expired", "Damaged"].includes(line.condition) ? line.condition : "Fresh";
    const key = `${line.itemId}|${line.mrp}|${String(line.godownId)}|${cond}`;
    neededByKey.set(key, (neededByKey.get(key) || 0) + line.totalPieces);
    nameByKey.set(key, line.itemName);
  }

  for (const [key, needed] of neededByKey.entries()) {
    const [itemId, mrpStr, godownIdStr, cond] = key.split("|");
    const mrp = parseFloat(mrpStr);
    const item = await Item.findOne({ _id: itemId, companyId });
    if (!item) continue;
    const matchedEntry = Array.isArray(item.mrpEntries)
      ? item.mrpEntries.find((e) => parseFloat(e.mrp) === mrp)
      : null;
    if (!matchedEntry) continue;
    const bucket = matchedEntry.godownStock?.find((g) => String(g.godownId) === godownIdStr);
    const pcsField = `openingStock${cond}Pcs`;
    const available = parseFloat(bucket?.[pcsField]) || 0;
    if (available < needed) {
      throw new Error(
        `Cannot remove this sale return — "${nameByKey.get(key)}" only has ${available} pcs left (${cond}) in the selected godown, but removing this return would need to take back ${needed} pcs (the rest has already been sold or moved elsewhere)`
      );
    }
  }
}

// sign = +1 to apply a sale return's stock effect (increment — goods coming back),
// -1 to reverse it. Same non-destructive per-godown-bucket upsert as Purchase/Sale's
// applyStockDelta, but deliberately does NOT touch lastCostRate/purchaseRate.
// Routes into the Fresh, Expired, or Damaged bucket per line.condition — an
// Expired/Damaged return is recorded (visible in those figures everywhere stock is
// shown) but never touches the Fresh bucket, so it is NOT counted as sellable
// inventory anywhere that reads openingStockFreshPcs (Sale's assertSufficientStock,
// Item Reference panels, etc.). `companyId` scopes the Item lookup so a line can
// never mutate a different company's Item document.
async function applyOneLine(line, sign, companyId) {
  const item = await Item.findOne({ _id: line.itemId, companyId });
  if (!item) return;

  const cond = ["Fresh", "Expired", "Damaged"].includes(line.condition) ? line.condition : "Fresh";
  const pcsField = `openingStock${cond}Pcs`;
  const caseField = `openingStock${cond}Case`;

  const packing = parseFloat(item.packing) || 1;

  const matchedEntry = findMatchedRateEntry(line, item);
  if (matchedEntry) {
    const entryPacking = parseFloat(matchedEntry.packing) || 1;
    const entryNewPcs = (parseFloat(matchedEntry[pcsField]) || 0) + sign * line.totalPieces;
    matchedEntry[pcsField] = entryNewPcs;
    matchedEntry[caseField] = entryPacking > 0 ? entryNewPcs / entryPacking : entryNewPcs;

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
    const bucketNewPcs = (parseFloat(bucket[pcsField]) || 0) + sign * line.totalPieces;
    bucket[pcsField] = bucketNewPcs;
    bucket[caseField] = entryPacking > 0 ? bucketNewPcs / entryPacking : bucketNewPcs;

    item.markModified("mrpEntries");
  }

  const newPcs = (parseFloat(item[pcsField]) || 0) + sign * line.totalPieces;
  item[pcsField] = newPcs;
  item[caseField] = packing > 0 ? newPcs / packing : newPcs;

  await item.save();
}

// Self-healing against a partial mid-loop failure — see purchaseController's
// identical helper for the full rationale. Reversing a line uses the SAME
// line object (same condition, same everything) with the opposite sign, so
// it correctly unwinds whichever condition-specific bucket applyOneLine
// actually touched.
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

const getSaleReturns = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, search = "", dateFrom, dateTo } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const query = { companyId };
    if (search) query.returnNo = searchRegex(search);
    if (dateFrom || dateTo) {
      query.returnDate = {};
      if (dateFrom) query.returnDate.$gte = new Date(`${dateFrom}T00:00:00.000Z`);
      if (dateTo) query.returnDate.$lte = new Date(`${dateTo}T23:59:59.999Z`);
    }

    const parsedPage = clampPage(page);
    const parsedLimit = clampLimit(limit);
    const skip = (parsedPage - 1) * parsedLimit;

    const [saleReturns, total] = await Promise.all([
      SaleReturn.find(query)
        .populate("customerId", "name")
        .sort({ returnDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit)
        .lean(),
      SaleReturn.countDocuments(query),
    ]);

    res.status(200).json({
      data: saleReturns,
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

const getSaleReturnById = async (req, res) => {
  try {
    const saleReturn = await SaleReturn.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId }).populate("customerId", "name");
    if (!saleReturn) {
      return res.status(404).json({ message: "Sale Return not found" });
    }
    res.status(200).json(saleReturn);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

// GET /api/sale-returns/lookup-invoice?companyId=&invoiceNo= — resolves the original
// Sale invoice so the frontend can auto-fill customer + godown + item lines.
const lookupOriginalInvoice = async (req, res) => {
  try {
    const { companyId, invoiceNo } = req.query;
    if (!companyId || !invoiceNo) {
      return res.status(400).json({ message: "companyId and invoiceNo are required" });
    }

    const sale = await Sale.findOne({ companyId, invoiceNo: invoiceNo.trim() });
    if (!sale) {
      return res.status(404).json({ message: "No sale invoice found with that number" });
    }

    res.status(200).json(sale);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const createSaleReturn = async (req, res) => {
  let saleReturn;
  try {
    const {
      companyId,
      returnNo,
      returnDate,
      customerId,
      originalInvoiceNo,
      originalSaleId,
      notes,
      items,
      refundAmount,
      dueDate,
    } = req.body;

    if (!companyId || !returnNo || !returnDate || !customerId) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const exists = await SaleReturn.findOne({ companyId, returnNo: returnNo.trim() });
    if (exists) {
      return res.status(400).json({ message: "This return number already exists" });
    }

    const lines = await buildLines(items, companyId);

    if (originalSaleId) {
      const original = await Sale.findOne({ _id: originalSaleId, companyId });
      if (original) validateAgainstOriginal(lines, original.items);
    }

    const totals = computeTotals(lines);
    const refund = parseFloat(refundAmount) || 0;

    saleReturn = await SaleReturn.create({
      companyId,
      returnNo: returnNo.trim(),
      returnDate,
      customerId,
      originalInvoiceNo: originalInvoiceNo || "",
      originalSaleId: originalSaleId || null,
      notes: notes || "",
      items: lines,
      ...totals,
      refundAmount: refund,
      pendingAmount: totals.netAmount - refund,
      dueDate: dueDate || null,
    });

    try {
      await applyStockDelta(lines, 1, companyId);
    } catch (stockErr) {
      await SaleReturn.deleteOne({ _id: saleReturn._id });
      throw stockErr;
    }

    res.status(201).json(saleReturn);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const updateSaleReturn = async (req, res) => {
  try {
    const saleReturn = await SaleReturn.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!saleReturn) {
      return res.status(404).json({ message: "Sale Return not found" });
    }
    const companyId = saleReturn.companyId;
    // Captured before any mutation — see saleController.updateSale for why the
    // rollback path must use this snapshot, not `saleReturn.items` (reassigned below).
    const oldItems = saleReturn.items;

    const {
      returnNo,
      returnDate,
      customerId,
      originalInvoiceNo,
      originalSaleId,
      notes,
      items,
      refundAmount,
      dueDate,
    } = req.body;

    if (returnNo && returnNo.trim() !== saleReturn.returnNo) {
      const exists = await SaleReturn.findOne({
        companyId: saleReturn.companyId,
        returnNo: returnNo.trim(),
        _id: { $ne: saleReturn._id },
      });
      if (exists) {
        return res.status(400).json({ message: "This return number already exists" });
      }
    }

    // Reversing this return's OLD stock effect (decrementing whichever bucket it
    // added to) can only proceed if that stock is still actually there — some of it
    // may have already moved out via a downstream Sale/Transfer. Check BEFORE
    // touching anything, same pattern as Purchase's update path.
    await assertSufficientStock(oldItems, companyId);
    // Reverse the old stock impact before validating/applying the new one, rolling
    // the reversal back if anything downstream fails — same safety pattern as
    // Sale's update path. Each old line already carries its own godownId, so this
    // reverses each line against its own godown.
    await applyStockDelta(oldItems, -1, companyId);

    try {
      const lines = await buildLines(items || oldItems, companyId);
      const resolvedOriginalId = originalSaleId !== undefined ? originalSaleId : saleReturn.originalSaleId;
      if (resolvedOriginalId) {
        const original = await Sale.findOne({ _id: resolvedOriginalId, companyId });
        if (original) validateAgainstOriginal(lines, original.items);
      }
      const totals = computeTotals(lines);

      if (returnNo) saleReturn.returnNo = returnNo.trim();
      if (returnDate) saleReturn.returnDate = returnDate;
      if (customerId) saleReturn.customerId = customerId;
      if (originalInvoiceNo !== undefined) saleReturn.originalInvoiceNo = originalInvoiceNo;
      if (originalSaleId !== undefined) saleReturn.originalSaleId = originalSaleId || null;
      if (notes !== undefined) saleReturn.notes = notes;
      saleReturn.items = lines;
      Object.assign(saleReturn, totals);

      const refund = refundAmount !== undefined ? parseFloat(refundAmount) || 0 : saleReturn.refundAmount;
      saleReturn.refundAmount = refund;
      saleReturn.pendingAmount = totals.netAmount - refund;
      if (dueDate !== undefined) saleReturn.dueDate = dueDate || null;

      // Field mutation + save + reapply must all succeed together, or the reversal
      // above must be undone — see saleController.updateSale for the failure mode
      // this closes (a `.save()`-time validation error leaving stock desynced).
      await saleReturn.save();
      await applyStockDelta(lines, 1, companyId);
    } catch (err) {
      await applyStockDelta(oldItems, 1, companyId);
      throw err;
    }

    res.status(200).json(saleReturn);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const deleteSaleReturn = async (req, res) => {
  try {
    const saleReturn = await SaleReturn.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!saleReturn) {
      return res.status(404).json({ message: "Sale Return not found" });
    }

    await assertSufficientStock(saleReturn.items, saleReturn.companyId);
    await applyStockDelta(saleReturn.items, -1, saleReturn.companyId);
    await saleReturn.deleteOne();

    res.status(200).json({ message: "Sale Return deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getSaleReturns,
  getSaleReturnById,
  lookupOriginalInvoice,
  createSaleReturn,
  updateSaleReturn,
  deleteSaleReturn,
};
