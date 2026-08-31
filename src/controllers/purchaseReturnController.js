const PurchaseReturn = require("../models/PurchaseReturn");
const Purchase = require("../models/Purchase");
const Item = require("../models/Item");

// Identical to purchaseController.findMatchedRateEntry — MRP is the identity key.
function findMatchedRateEntry(raw, item) {
  const rawMrp = raw.mrp !== undefined ? parseFloat(raw.mrp) : undefined;
  if (rawMrp === undefined || !Array.isArray(item.mrpEntries)) return null;
  return item.mrpEntries.find((e) => parseFloat(e.mrp) === rawMrp) || null;
}

// Identical to purchaseController.computeLine — a Purchase Return is entered the same
// way a Purchase is (ex-GST beforeGstRate); only the stock direction differs.
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

// If the return is linked to an original Purchase invoice, each return line can't
// return more than that invoice billed for the matching item+MRP (summed, since the
// same item+MRP could appear on more than one original line). Not cumulative across
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
        `Cannot return more than was originally purchased for "${line?.itemName}" (originally billed: ${originallyBilled} pcs, returning: ${returning} pcs)`
      );
    }
  }
}

// A Purchase Return removes stock that must actually be present in the selected
// godown's bucket — mirrors saleController.assertSufficientStock exactly.
//
// Deliberately NOT condition-aware, unlike Sale Return: a Purchase Return sends
// back physical stock that's actually sitting in the Fresh bucket (the Damaged
// bucket is essentially never populated in real usage — only a Sale Return with
// condition=Damaged puts anything there). "Condition" on a Purchase Return line is
// just a descriptive reason for the return (recorded on the line, shown in the
// grid) — it does NOT change which bucket is checked/decremented. An earlier
// version of this function keyed by itemId|mrp|condition and required Damaged-
// condition lines to have that much stock already sitting in the Damaged bucket,
// which broke the real, common case: "I have 5 case of this item (Fresh, as
// always), 3 of them turned out damaged, I'm returning those 3 to the supplier" —
// it wrongly demanded 3 case already be in the Damaged bucket (which is always 0
// in that scenario) instead of checking the Fresh bucket where the physical stock
// actually is.
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
        `Insufficient stock for "${nameByKey.get(key)}" in the selected godown to return (available: ${available} pcs, needed: ${needed} pcs)`
      );
    }
  }
}

// sign = -1 to apply a purchase return's stock effect (decrement), +1 to reverse it.
// Same non-destructive per-godown-bucket upsert as Purchase/Sale's applyStockDelta,
// but deliberately does NOT touch lastCostRate/purchaseRate — those are purchase-
// history fields, not meaningful for a return. Always moves the Fresh bucket,
// regardless of line.condition — see assertSufficientStock above for why.
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

const getPurchaseReturns = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, search = "" } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const query = { companyId };
    if (search) query.returnNo = { $regex: search, $options: "i" };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const parsedLimit = parseInt(limit);

    const [purchaseReturns, total] = await Promise.all([
      PurchaseReturn.find(query)
        .populate("supplierId", "name")
        .sort({ returnDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit)
        .lean(),
      PurchaseReturn.countDocuments(query),
    ]);

    res.status(200).json({
      data: purchaseReturns,
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

const getPurchaseReturnById = async (req, res) => {
  try {
    const purchaseReturn = await PurchaseReturn.findById(req.params.id).populate("supplierId", "name");
    if (!purchaseReturn) {
      return res.status(404).json({ message: "Purchase Return not found" });
    }
    res.status(200).json(purchaseReturn);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

// GET /api/purchase-returns/lookup-invoice?companyId=&invoiceNo= — resolves the
// original Purchase invoice so the frontend can auto-fill godown + item lines.
const lookupOriginalInvoice = async (req, res) => {
  try {
    const { companyId, invoiceNo } = req.query;
    if (!companyId || !invoiceNo) {
      return res.status(400).json({ message: "companyId and invoiceNo are required" });
    }

    const purchase = await Purchase.findOne({ companyId, invoiceNo: invoiceNo.trim() });
    if (!purchase) {
      return res.status(404).json({ message: "No purchase invoice found with that number" });
    }

    res.status(200).json(purchase);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const createPurchaseReturn = async (req, res) => {
  try {
    const {
      companyId,
      returnNo,
      returnDate,
      godownId,
      supplierId,
      originalInvoiceNo,
      originalPurchaseId,
      notes,
      items,
      refundAmount,
      dueDate,
    } = req.body;

    if (!companyId || !returnNo || !returnDate || !godownId || !supplierId) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const exists = await PurchaseReturn.findOne({ companyId, returnNo: returnNo.trim() });
    if (exists) {
      return res.status(400).json({ message: "This return number already exists" });
    }

    const lines = await buildLines(items);

    if (originalPurchaseId) {
      const original = await Purchase.findById(originalPurchaseId);
      if (original) validateAgainstOriginal(lines, original.items);
    }

    await assertSufficientStock(lines, godownId);
    const totals = computeTotals(lines);
    const refund = parseFloat(refundAmount) || 0;

    const purchaseReturn = await PurchaseReturn.create({
      companyId,
      returnNo: returnNo.trim(),
      returnDate,
      godownId,
      supplierId,
      originalInvoiceNo: originalInvoiceNo || "",
      originalPurchaseId: originalPurchaseId || null,
      notes: notes || "",
      items: lines,
      ...totals,
      refundAmount: refund,
      pendingAmount: totals.netAmount - refund,
      dueDate: dueDate || null,
    });

    await applyStockDelta(lines, -1, godownId);

    res.status(201).json(purchaseReturn);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const updatePurchaseReturn = async (req, res) => {
  try {
    const purchaseReturn = await PurchaseReturn.findById(req.params.id);
    if (!purchaseReturn) {
      return res.status(404).json({ message: "Purchase Return not found" });
    }

    const {
      returnNo,
      returnDate,
      godownId,
      supplierId,
      originalInvoiceNo,
      originalPurchaseId,
      notes,
      items,
      refundAmount,
      dueDate,
    } = req.body;

    if (returnNo && returnNo.trim() !== purchaseReturn.returnNo) {
      const exists = await PurchaseReturn.findOne({
        companyId: purchaseReturn.companyId,
        returnNo: returnNo.trim(),
        _id: { $ne: purchaseReturn._id },
      });
      if (exists) {
        return res.status(400).json({ message: "This return number already exists" });
      }
    }

    // Reverse the old stock impact (against the OLD godown) before checking/applying
    // the new one — if the new lines don't validate, roll the reversal back before
    // propagating the error so stock never ends up partially mutated.
    const oldGodownId = purchaseReturn.godownId;
    await applyStockDelta(purchaseReturn.items, 1, oldGodownId);

    let lines, totals, newGodownId;
    try {
      lines = await buildLines(items || purchaseReturn.items);
      const resolvedOriginalId = originalPurchaseId !== undefined ? originalPurchaseId : purchaseReturn.originalPurchaseId;
      if (resolvedOriginalId) {
        const original = await Purchase.findById(resolvedOriginalId);
        if (original) validateAgainstOriginal(lines, original.items);
      }
      newGodownId = godownId || purchaseReturn.godownId;
      await assertSufficientStock(lines, newGodownId);
      totals = computeTotals(lines);
    } catch (err) {
      await applyStockDelta(purchaseReturn.items, -1, oldGodownId);
      throw err;
    }

    if (returnNo) purchaseReturn.returnNo = returnNo.trim();
    if (returnDate) purchaseReturn.returnDate = returnDate;
    if (godownId) purchaseReturn.godownId = godownId;
    if (supplierId) purchaseReturn.supplierId = supplierId;
    if (originalInvoiceNo !== undefined) purchaseReturn.originalInvoiceNo = originalInvoiceNo;
    if (originalPurchaseId !== undefined) purchaseReturn.originalPurchaseId = originalPurchaseId || null;
    if (notes !== undefined) purchaseReturn.notes = notes;
    purchaseReturn.items = lines;
    Object.assign(purchaseReturn, totals);

    const refund = refundAmount !== undefined ? parseFloat(refundAmount) || 0 : purchaseReturn.refundAmount;
    purchaseReturn.refundAmount = refund;
    purchaseReturn.pendingAmount = totals.netAmount - refund;
    if (dueDate !== undefined) purchaseReturn.dueDate = dueDate || null;

    await purchaseReturn.save();
    await applyStockDelta(lines, -1, purchaseReturn.godownId);

    res.status(200).json(purchaseReturn);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const deletePurchaseReturn = async (req, res) => {
  try {
    const purchaseReturn = await PurchaseReturn.findById(req.params.id);
    if (!purchaseReturn) {
      return res.status(404).json({ message: "Purchase Return not found" });
    }

    await applyStockDelta(purchaseReturn.items, 1, purchaseReturn.godownId);
    await purchaseReturn.deleteOne();

    res.status(200).json({ message: "Purchase Return deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getPurchaseReturns,
  getPurchaseReturnById,
  lookupOriginalInvoice,
  createPurchaseReturn,
  updatePurchaseReturn,
  deletePurchaseReturn,
};
