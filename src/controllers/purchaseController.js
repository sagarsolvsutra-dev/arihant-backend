const Purchase = require("../models/Purchase");
const Item = require("../models/Item");

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
  // rate here would silently corrupt Item stock via applyStockDelta.
  if (caseQty < 0 || pcsQty < 0 || freeQty < 0 || beforeGstRate < 0 || lessRs < 0 || cdRs < 0) {
    throw new Error(`Quantities and rates cannot be negative (item: ${item.itemName})`);
  }

  const billedPieces = caseQty * packing + pcsQty;
  const totalPieces = billedPieces + freeQty;
  const pricePerPiece = purchaseQty > 0 ? beforeGstRate / purchaseQty : 0;

  const amount = pricePerPiece * billedPieces;
  const lessAmt = (amount * lessPercent) / 100 + lessRs;
  const cdAmt = (amount * cdPercent) / 100 + cdRs;
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

// Builds validated + recomputed lines from raw client input, keyed against
// the real Item documents (rate/gst/packing snapshots come from the DB, not the client).
async function buildLines(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error("At least one item is required");
  }

  const itemIds = rawItems.map((r) => r.itemId);
  const items = await Item.find({ _id: { $in: itemIds } });
  const itemMap = new Map(items.map((i) => [String(i._id), i]));

  return rawItems.map((raw) => {
    const item = itemMap.get(String(raw.itemId));
    if (!item) {
      throw new Error(`Item not found: ${raw.itemId}`);
    }
    return computeLine(raw, item);
  });
}

// sign = +1 to apply a purchase's stock effect, -1 to reverse it. godownId identifies
// which physical warehouse bucket the stock moves in/out of.
//
// Item/MRP-entry flat opening-stock fields are incremented directly (never recomputed
// as a sum of godownStock buckets) — Items add/edit lets a user set opening stock
// without picking a godown at all, so those buckets don't necessarily cover the whole
// flat total. godownStock[] is purely a Purchase-driven, godown-scoped view alongside
// the flat total, not its source of truth.
async function applyStockDelta(lines, sign, godownId) {
  for (const line of lines) {
    const item = await Item.findById(line.itemId);
    if (!item) continue;

    const packing = parseFloat(item.packing) || 1;

    const matchedEntry = findMatchedRateEntry(line, item);
    if (matchedEntry) {
      const entryPacking = parseFloat(matchedEntry.packing) || 1;
      const entryNewPcs = (parseFloat(matchedEntry.openingStockFreshPcs) || 0) + sign * line.totalPieces;
      matchedEntry.openingStockFreshPcs = entryNewPcs;
      matchedEntry.openingStockFreshCase = entryPacking > 0 ? entryNewPcs / entryPacking : entryNewPcs;

      if (!Array.isArray(matchedEntry.godownStock)) matchedEntry.godownStock = [];
      let bucket = matchedEntry.godownStock.find((g) => String(g.godownId) === String(godownId));
      if (!bucket) {
        bucket = { godownId, openingStockFreshCase: 0, openingStockFreshPcs: 0, openingStockDamagedCase: 0, openingStockDamagedPcs: 0 };
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
}

// Purchase only ever ADDS stock when created, so createPurchase never needed a
// sufficiency check — but deleting or reducing a purchase REMOVES stock that may
// have already been consumed by a downstream Sale or Purchase Return. Mirrors
// saleController.assertSufficientStock exactly; used only by delete/update below,
// checked against CURRENT stock before the removal is allowed to proceed.
async function assertSufficientStock(lines, godownId) {
  const neededByKey = new Map();
  const nameByKey = new Map();
  for (const line of lines) {
    const key = `${line.itemId}|${line.mrp}`;
    neededByKey.set(key, (neededByKey.get(key) || 0) + line.totalPieces);
    nameByKey.set(key, line.itemName);
  }

  for (const [key, needed] of neededByKey.entries()) {
    const [itemId, mrpStr] = key.split("|");
    const mrp = parseFloat(mrpStr);
    const item = await Item.findById(itemId);
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
    const bucket = matchedEntry.godownStock?.find((g) => String(g.godownId) === String(godownId));
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
    const { companyId, page = 1, limit = 10, search = "" } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const query = { companyId };
    if (search) query.invoiceNo = { $regex: search, $options: "i" };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const parsedLimit = parseInt(limit);

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
        page: parseInt(page),
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
    const purchase = await Purchase.findById(req.params.id);
    if (!purchase) {
      return res.status(404).json({ message: "Purchase not found" });
    }
    res.status(200).json(purchase);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const createPurchase = async (req, res) => {
  try {
    const { companyId, invoiceNo, invoiceDate, receivingDate, godownId, notes, items, paidAmount, dueDate } = req.body;

    if (!companyId || !invoiceNo || !invoiceDate || !godownId) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const exists = await Purchase.findOne({ companyId, invoiceNo: invoiceNo.trim() });
    if (exists) {
      return res.status(400).json({ message: "This invoice number already exists" });
    }

    const lines = await buildLines(items);
    const totals = computeTotals(lines);
    const paid = parseFloat(paidAmount) || 0;

    const purchase = await Purchase.create({
      companyId,
      invoiceNo: invoiceNo.trim(),
      invoiceDate,
      receivingDate: receivingDate || null,
      godownId,
      notes: notes || "",
      items: lines,
      ...totals,
      paidAmount: paid,
      pendingAmount: totals.netAmount - paid,
      dueDate: dueDate || null,
    });

    await applyStockDelta(lines, 1, godownId);

    res.status(201).json(purchase);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const updatePurchase = async (req, res) => {
  try {
    const purchase = await Purchase.findById(req.params.id);
    if (!purchase) {
      return res.status(404).json({ message: "Purchase not found" });
    }

    const { invoiceNo, invoiceDate, receivingDate, godownId, notes, items, paidAmount, dueDate } = req.body;

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
    // Sale or Purchase Return. Check BEFORE touching anything.
    const oldGodownId = purchase.godownId;
    await assertSufficientStock(purchase.items, oldGodownId);
    await applyStockDelta(purchase.items, -1, oldGodownId);

    let lines, totals;
    try {
      lines = await buildLines(items || purchase.items);
      totals = computeTotals(lines);
    } catch (err) {
      await applyStockDelta(purchase.items, 1, oldGodownId);
      throw err;
    }

    if (invoiceNo) purchase.invoiceNo = invoiceNo.trim();
    if (invoiceDate) purchase.invoiceDate = invoiceDate;
    if (receivingDate !== undefined) purchase.receivingDate = receivingDate || null;
    if (godownId) purchase.godownId = godownId;
    if (notes !== undefined) purchase.notes = notes;
    purchase.items = lines;
    Object.assign(purchase, totals);

    const paid = paidAmount !== undefined ? parseFloat(paidAmount) || 0 : purchase.paidAmount;
    purchase.paidAmount = paid;
    purchase.pendingAmount = totals.netAmount - paid;
    if (dueDate !== undefined) purchase.dueDate = dueDate || null;

    await purchase.save();
    await applyStockDelta(lines, 1, purchase.godownId);

    res.status(200).json(purchase);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const deletePurchase = async (req, res) => {
  try {
    const purchase = await Purchase.findById(req.params.id);
    if (!purchase) {
      return res.status(404).json({ message: "Purchase not found" });
    }

    await assertSufficientStock(purchase.items, purchase.godownId);
    await applyStockDelta(purchase.items, -1, purchase.godownId);
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
