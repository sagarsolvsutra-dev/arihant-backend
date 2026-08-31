const SaleReturn = require("../models/SaleReturn");
const Sale = require("../models/Sale");
const Item = require("../models/Item");

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

  if (caseQty < 0 || pcsQty < 0 || freeQty < 0 || afterGstRate < 0 || lessRs < 0 || cdRs < 0) {
    throw new Error(`Quantities and rates cannot be negative (item: ${item.itemName})`);
  }

  const billedPieces = caseQty * packing + pcsQty;
  const totalPieces = billedPieces + freeQty;
  const pricePerPiece = salesQty > 0 ? afterGstRate / salesQty : 0;

  const amount = pricePerPiece * billedPieces;
  const lessAmt = (amount * lessPercent) / 100 + lessRs;
  const cdAmt = (amount * cdPercent) / 100 + cdRs;
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
    condition: raw.condition === "Damaged" ? "Damaged" : "Fresh",
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

// sign = +1 to apply a sale return's stock effect (increment — goods coming back),
// -1 to reverse it. Same non-destructive per-godown-bucket upsert as Purchase/Sale's
// applyStockDelta, but deliberately does NOT touch lastCostRate/purchaseRate.
// Routes into the Fresh or Damaged bucket per line.condition — a Damaged return is
// recorded (visible in the Damaged figures everywhere stock is shown) but never
// touches the Fresh bucket, so it is NOT counted as sellable inventory anywhere
// that reads openingStockFreshPcs (Sale's assertSufficientStock, Item Reference
// panels, etc.).
async function applyStockDelta(lines, sign, godownId) {
  for (const line of lines) {
    const item = await Item.findById(line.itemId);
    if (!item) continue;

    const cond = line.condition === "Damaged" ? "Damaged" : "Fresh";
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
      let bucket = matchedEntry.godownStock.find((g) => String(g.godownId) === String(godownId));
      if (!bucket) {
        bucket = { godownId, openingStockFreshCase: 0, openingStockFreshPcs: 0, openingStockDamagedCase: 0, openingStockDamagedPcs: 0 };
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
}

const getSaleReturns = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, search = "" } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const query = { companyId };
    if (search) query.returnNo = { $regex: search, $options: "i" };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const parsedLimit = parseInt(limit);

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
        page: parseInt(page),
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
    const saleReturn = await SaleReturn.findById(req.params.id).populate("customerId", "name");
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
  try {
    const {
      companyId,
      returnNo,
      returnDate,
      godownId,
      customerId,
      originalInvoiceNo,
      originalSaleId,
      notes,
      items,
      refundAmount,
      dueDate,
    } = req.body;

    if (!companyId || !returnNo || !returnDate || !godownId || !customerId) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const exists = await SaleReturn.findOne({ companyId, returnNo: returnNo.trim() });
    if (exists) {
      return res.status(400).json({ message: "This return number already exists" });
    }

    const lines = await buildLines(items);

    if (originalSaleId) {
      const original = await Sale.findById(originalSaleId);
      if (original) validateAgainstOriginal(lines, original.items);
    }

    const totals = computeTotals(lines);
    const refund = parseFloat(refundAmount) || 0;

    const saleReturn = await SaleReturn.create({
      companyId,
      returnNo: returnNo.trim(),
      returnDate,
      godownId,
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

    await applyStockDelta(lines, 1, godownId);

    res.status(201).json(saleReturn);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const updateSaleReturn = async (req, res) => {
  try {
    const saleReturn = await SaleReturn.findById(req.params.id);
    if (!saleReturn) {
      return res.status(404).json({ message: "Sale Return not found" });
    }

    const {
      returnNo,
      returnDate,
      godownId,
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

    // Reverse the old stock impact (against the OLD godown) before validating/applying
    // the new one, rolling the reversal back if the new lines fail to build/validate —
    // same safety pattern as Sale's update path.
    const oldGodownId = saleReturn.godownId;
    await applyStockDelta(saleReturn.items, -1, oldGodownId);

    let lines, totals;
    try {
      lines = await buildLines(items || saleReturn.items);
      const resolvedOriginalId = originalSaleId !== undefined ? originalSaleId : saleReturn.originalSaleId;
      if (resolvedOriginalId) {
        const original = await Sale.findById(resolvedOriginalId);
        if (original) validateAgainstOriginal(lines, original.items);
      }
      totals = computeTotals(lines);
    } catch (err) {
      await applyStockDelta(saleReturn.items, 1, oldGodownId);
      throw err;
    }

    if (returnNo) saleReturn.returnNo = returnNo.trim();
    if (returnDate) saleReturn.returnDate = returnDate;
    if (godownId) saleReturn.godownId = godownId;
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

    await saleReturn.save();
    await applyStockDelta(lines, 1, saleReturn.godownId);

    res.status(200).json(saleReturn);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const deleteSaleReturn = async (req, res) => {
  try {
    const saleReturn = await SaleReturn.findById(req.params.id);
    if (!saleReturn) {
      return res.status(404).json({ message: "Sale Return not found" });
    }

    await applyStockDelta(saleReturn.items, -1, saleReturn.godownId);
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
