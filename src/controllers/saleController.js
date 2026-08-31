const Sale = require("../models/Sale");
const Item = require("../models/Item");

// Finds which of the item's mrpEntries the client is selling against, by
// matching on MRP (guaranteed unique per item) — same lookup Purchase uses.
function findMatchedRateEntry(raw, item) {
  const rawMrp = raw.mrp !== undefined ? parseFloat(raw.mrp) : undefined;
  if (rawMrp === undefined || !Array.isArray(item.mrpEntries)) return null;
  return item.mrpEntries.find((e) => parseFloat(e.mrp) === rawMrp) || null;
}

// Recomputes every derived value for a single sale line from the raw entry fields —
// the client's computed numbers are never trusted directly. Unlike Purchase (where
// the entered rate is ex-GST), here the entered rate (afterGstRate) is GST-inclusive
// — what the customer is actually billed per piece — and beforeGstRate (taxable) is
// derived by backing GST out after discounts are applied to the inclusive amount.
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

  // Never trust the client to have blocked negative input — a negative quantity or
  // rate here would silently corrupt Item stock via applyStockDelta.
  if (caseQty < 0 || pcsQty < 0 || freeQty < 0 || afterGstRate < 0 || lessRs < 0 || cdRs < 0) {
    throw new Error(`Quantities and rates cannot be negative (item: ${item.itemName})`);
  }

  const billedPieces = caseQty * packing + pcsQty;
  const totalPieces = billedPieces + freeQty;
  const pricePerPiece = salesQty > 0 ? afterGstRate / salesQty : 0;

  const amount = pricePerPiece * billedPieces; // GST-inclusive, pre-discount
  const lessAmt = (amount * lessPercent) / 100 + lessRs;
  const cdAmt = (amount * cdPercent) / 100 + cdRs;
  const netValue = amount - lessAmt - cdAmt; // GST-inclusive, discounted — what the customer pays
  const taxableValue = gstPercent > 0 ? netValue / (1 + gstPercent / 100) : netValue;
  const gstAmount = netValue - taxableValue;

  // Express the derived ex-GST rate on the same basis as afterGstRate (per salesQty
  // units) by scaling taxableValue back up from its billedPieces basis — mirrors
  // Purchase's afterGstRate derivation, just for the opposite (ex-GST) side.
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

// A sale can only draw down stock that actually exists in the selected godown's
// bucket for the matched MRP tier — checked as one pass over all lines BEFORE any
// stock is mutated, so a failed sale never leaves stock partially decremented.
// Aggregates by (itemId, mrp) first since the same item/rate could appear on more
// than one line.
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
    const bucket = matchedEntry?.godownStock?.find((g) => String(g.godownId) === String(godownId));
    const available = parseFloat(bucket?.openingStockFreshPcs) || 0;
    if (available < needed) {
      throw new Error(
        `Insufficient stock for "${nameByKey.get(key)}" in the selected godown (available: ${available} pcs, needed: ${needed} pcs)`
      );
    }
  }
}

// sign = -1 to apply a sale's stock effect (decrement), +1 to reverse it (increment).
// Mirrors purchaseController.applyStockDelta exactly, with the sign convention
// flipped — a sale draws stock down instead of building it up. Same non-destructive
// per-godown-bucket upsert, same "flat fields are the source of truth, godownStock is
// a Purchase/Sale-driven supplementary view" invariant.
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

      item.markModified("mrpEntries");
    }

    const newPcs = (parseFloat(item.openingStockFreshPcs) || 0) + sign * line.totalPieces;
    item.openingStockFreshPcs = newPcs;
    item.openingStockFreshCase = packing > 0 ? newPcs / packing : newPcs;

    await item.save();
  }
}

const getSales = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, search = "" } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const query = { companyId };
    if (search) query.invoiceNo = { $regex: search, $options: "i" };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const parsedLimit = parseInt(limit);

    const [sales, total] = await Promise.all([
      Sale.find(query)
        .populate("customerId", "name")
        .sort({ invoiceDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit)
        .lean(),
      Sale.countDocuments(query),
    ]);

    res.status(200).json({
      data: sales,
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

const getSaleById = async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.id).populate("customerId", "name customerType");
    if (!sale) {
      return res.status(404).json({ message: "Sale not found" });
    }
    res.status(200).json(sale);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const createSale = async (req, res) => {
  try {
    const { companyId, invoiceType, paymentType, invoiceNo, invoiceDate, deliveryDate, godownId, customerId, notes, items, receivedAmount, dueDate } = req.body;

    if (!companyId || !invoiceNo || !invoiceDate || !godownId || !customerId) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const exists = await Sale.findOne({ companyId, invoiceNo: invoiceNo.trim() });
    if (exists) {
      return res.status(400).json({ message: "This invoice number already exists" });
    }

    const lines = await buildLines(items);
    await assertSufficientStock(lines, godownId);
    const totals = computeTotals(lines);
    const received = parseFloat(receivedAmount) || 0;

    const sale = await Sale.create({
      companyId,
      invoiceType: invoiceType || "Tax Invoice",
      paymentType: paymentType || "Credit",
      invoiceNo: invoiceNo.trim(),
      invoiceDate,
      deliveryDate: deliveryDate || null,
      godownId,
      customerId,
      notes: notes || "",
      items: lines,
      ...totals,
      receivedAmount: received,
      pendingAmount: totals.netAmount - received,
      dueDate: dueDate || null,
    });

    await applyStockDelta(lines, -1, godownId);

    res.status(201).json(sale);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const updateSale = async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.id);
    if (!sale) {
      return res.status(404).json({ message: "Sale not found" });
    }

    const { invoiceType, paymentType, invoiceNo, invoiceDate, deliveryDate, godownId, customerId, notes, items, receivedAmount, dueDate } = req.body;

    if (invoiceNo && invoiceNo.trim() !== sale.invoiceNo) {
      const exists = await Sale.findOne({
        companyId: sale.companyId,
        invoiceNo: invoiceNo.trim(),
        _id: { $ne: sale._id },
      });
      if (exists) {
        return res.status(400).json({ message: "This invoice number already exists" });
      }
    }

    // Reverse the old stock impact (against the OLD godown) before checking/applying
    // the new one — if the new lines turn out insufficient, roll the reversal back
    // before propagating the error so stock never ends up partially mutated.
    const oldGodownId = sale.godownId;
    await applyStockDelta(sale.items, 1, oldGodownId);

    let lines, totals, newGodownId;
    try {
      lines = await buildLines(items || sale.items);
      newGodownId = godownId || sale.godownId;
      await assertSufficientStock(lines, newGodownId);
      totals = computeTotals(lines);
    } catch (err) {
      await applyStockDelta(sale.items, -1, oldGodownId);
      throw err;
    }

    if (invoiceType) sale.invoiceType = invoiceType;
    if (paymentType) sale.paymentType = paymentType;
    if (invoiceNo) sale.invoiceNo = invoiceNo.trim();
    if (invoiceDate) sale.invoiceDate = invoiceDate;
    if (deliveryDate !== undefined) sale.deliveryDate = deliveryDate || null;
    if (godownId) sale.godownId = godownId;
    if (customerId) sale.customerId = customerId;
    if (notes !== undefined) sale.notes = notes;
    sale.items = lines;
    Object.assign(sale, totals);

    const received = receivedAmount !== undefined ? parseFloat(receivedAmount) || 0 : sale.receivedAmount;
    sale.receivedAmount = received;
    sale.pendingAmount = totals.netAmount - received;
    if (dueDate !== undefined) sale.dueDate = dueDate || null;

    await sale.save();
    await applyStockDelta(lines, -1, sale.godownId);

    res.status(200).json(sale);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const deleteSale = async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.id);
    if (!sale) {
      return res.status(404).json({ message: "Sale not found" });
    }

    await applyStockDelta(sale.items, 1, sale.godownId);
    await sale.deleteOne();

    res.status(200).json({ message: "Sale deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getSales,
  getSaleById,
  createSale,
  updateSale,
  deleteSale,
};
