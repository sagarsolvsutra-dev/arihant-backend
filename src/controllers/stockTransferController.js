const StockTransfer = require("../models/StockTransfer");
const Item = require("../models/Item");
const Godown = require("../models/Godown");
const { searchRegex, clampLimit, clampPage } = require("../utils/queryHelpers");

// Same matching approach as purchaseController/saleController — MRP is the
// effective identity key for a pricing tier, never trust client packing/qty directly.
function findMatchedRateEntry(raw, item) {
  const rawMrp = raw.mrp !== undefined ? parseFloat(raw.mrp) : undefined;
  if (rawMrp === undefined || !Array.isArray(item.mrpEntries)) return null;
  return item.mrpEntries.find((e) => parseFloat(e.mrp) === rawMrp) || null;
}

// No GST/pricing math at all — a transfer is a pure quantity movement between
// two godowns of the same item, never touching company-wide stock or valuation.
function computeLine(raw, item) {
  const matchedEntry = findMatchedRateEntry(raw, item);
  const packing = parseFloat(matchedEntry?.packing ?? item.packing) || 1;

  const caseQty = parseFloat(raw.caseQty) || 0;
  const pcsQty = parseFloat(raw.pcsQty) || 0;

  if (caseQty < 0 || pcsQty < 0) {
    throw new Error(`Quantities cannot be negative (item: ${item.itemName})`);
  }
  if (caseQty === 0 && pcsQty === 0) {
    throw new Error(`Enter a Case or Pcs quantity greater than 0 (item: ${item.itemName})`);
  }

  const totalPieces = caseQty * packing + pcsQty;

  return {
    itemId: item._id,
    itemName: item.itemName,
    packing,
    mrp: raw.mrp !== undefined ? parseFloat(raw.mrp) || 0 : parseFloat(item.mrp) || 0,
    caseQty,
    pcsQty,
    totalPieces,
  };
}

function computeTotals(lines) {
  return lines.reduce(
    (acc, l) => {
      acc.totalItems += 1;
      acc.totalCase += l.caseQty;
      acc.totalPcs += l.pcsQty;
      acc.totalQty += l.totalPieces;
      return acc;
    },
    { totalItems: 0, totalCase: 0, totalPcs: 0, totalQty: 0 }
  );
}

// Items and the from/to Godowns are scoped to `companyId` — without this, a line
// whose itemId belongs to a DIFFERENT company would still resolve successfully and
// applyStockDelta would silently mutate that other company's live stock.
async function buildLines(rawItems, companyId) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error("At least one item is required");
  }

  const itemIds = rawItems.map((r) => r.itemId);
  const items = await Item.find({ _id: { $in: itemIds }, companyId });
  const itemMap = new Map(items.map((i) => [String(i._id), i]));

  return rawItems.map((raw) => {
    const item = itemMap.get(String(raw.itemId));
    if (!item) {
      throw new Error(`Item not found: ${raw.itemId}`);
    }
    return computeLine(raw, item);
  });
}

async function assertGodownsBelongToCompany(godownIds, companyId) {
  const ids = [...new Set(godownIds.filter(Boolean).map(String))];
  if (ids.length === 0) return;
  const found = await Godown.find({ _id: { $in: ids }, companyId });
  if (found.length !== ids.length) {
    throw new Error("One or more selected godowns were not found");
  }
}

// Only the Fresh (sellable) bucket is transferable — mirrors every other
// controller in this app, which only ever moves the Fresh bucket between
// godowns; Expired/Damaged stock isn't something you'd transfer.
// checkGodownId is the FROM godown on create/update (stock must exist there to move
// out), or the TO godown when called from deleteStockTransfer's reversal (reversing
// takes stock back out of TO, which may have moved on since this transfer was made).
// `companyId` scopes the Item lookup to prevent cross-tenant reads.
async function assertSufficientStock(lines, checkGodownId, companyId) {
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
    const item = await Item.findOne({ _id: itemId, companyId });
    if (!item) continue;
    const matchedEntry = Array.isArray(item.mrpEntries)
      ? item.mrpEntries.find((e) => parseFloat(e.mrp) === mrp)
      : null;
    const bucket = matchedEntry?.godownStock?.find((g) => String(g.godownId) === String(checkGodownId));
    const available = parseFloat(bucket?.openingStockFreshPcs) || 0;
    if (available < needed) {
      throw new Error(
        `Insufficient stock for "${nameByKey.get(key)}" in the selected godown (available: ${available} pcs, needed: ${needed} pcs)`
      );
    }
  }
}

// sign = +1 to apply a transfer (move FROM -> TO), -1 to reverse it (move TO -> FROM).
// Unlike Purchase/Sale/Returns, this ONLY touches each matched MRP entry's
// godownStock[] buckets — the flat Item/mrpEntry openingStockFreshPcs/Case fields
// are never modified, since a transfer redistributes existing stock between two
// godowns of the same item rather than changing the company-wide total. `companyId`
// scopes the Item lookup so a line can never mutate a different company's Item document.
async function applyStockDelta(lines, fromGodownId, toGodownId, sign, companyId) {
  for (const line of lines) {
    const item = await Item.findOne({ _id: line.itemId, companyId });
    if (!item) continue;

    const matchedEntry = findMatchedRateEntry(line, item);
    if (!matchedEntry) continue;

    const entryPacking = parseFloat(matchedEntry.packing) || 1;
    if (!Array.isArray(matchedEntry.godownStock)) matchedEntry.godownStock = [];

    function getOrCreateBucket(godownId) {
      let bucket = matchedEntry.godownStock.find((g) => String(g.godownId) === String(godownId));
      if (!bucket) {
        bucket = {
          godownId,
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
      return bucket;
    }

    const fromBucket = getOrCreateBucket(fromGodownId);
    const fromNewPcs = (parseFloat(fromBucket.openingStockFreshPcs) || 0) - sign * line.totalPieces;
    fromBucket.openingStockFreshPcs = fromNewPcs;
    fromBucket.openingStockFreshCase = entryPacking > 0 ? fromNewPcs / entryPacking : fromNewPcs;

    const toBucket = getOrCreateBucket(toGodownId);
    const toNewPcs = (parseFloat(toBucket.openingStockFreshPcs) || 0) + sign * line.totalPieces;
    toBucket.openingStockFreshPcs = toNewPcs;
    toBucket.openingStockFreshCase = entryPacking > 0 ? toNewPcs / entryPacking : toNewPcs;

    item.markModified("mrpEntries");
    await item.save();
  }
}

const getStockTransfers = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, search = "" } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const query = { companyId };
    if (search) query.transferNo = searchRegex(search);

    const parsedPage = clampPage(page);
    const parsedLimit = clampLimit(limit);
    const skip = (parsedPage - 1) * parsedLimit;

    const [transfers, total] = await Promise.all([
      StockTransfer.find(query)
        .sort({ transferDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit)
        .lean(),
      StockTransfer.countDocuments(query),
    ]);

    res.status(200).json({
      data: transfers,
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

const getStockTransferById = async (req, res) => {
  try {
    const transfer = await StockTransfer.findById(req.params.id);
    if (!transfer) {
      return res.status(404).json({ message: "Stock transfer not found" });
    }
    res.status(200).json(transfer);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const createStockTransfer = async (req, res) => {
  let transfer;
  try {
    const { companyId, transferNo, transferDate, fromGodownId, toGodownId, notes, items } = req.body;

    if (!companyId || !transferNo || !transferDate || !fromGodownId || !toGodownId) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }
    if (String(fromGodownId) === String(toGodownId)) {
      return res.status(400).json({ message: "From Godown and To Godown must be different" });
    }
    await assertGodownsBelongToCompany([fromGodownId, toGodownId], companyId);

    const exists = await StockTransfer.findOne({ companyId, transferNo: transferNo.trim() });
    if (exists) {
      return res.status(400).json({ message: "This transfer number already exists" });
    }

    const lines = await buildLines(items, companyId);
    const totals = computeTotals(lines);

    await assertSufficientStock(lines, fromGodownId, companyId);

    transfer = await StockTransfer.create({
      companyId,
      transferNo: transferNo.trim(),
      transferDate,
      fromGodownId,
      toGodownId,
      notes: notes || "",
      items: lines,
      ...totals,
    });

    try {
      await applyStockDelta(lines, fromGodownId, toGodownId, 1, companyId);
    } catch (stockErr) {
      await StockTransfer.deleteOne({ _id: transfer._id });
      throw stockErr;
    }

    res.status(201).json(transfer);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const updateStockTransfer = async (req, res) => {
  try {
    const transfer = await StockTransfer.findById(req.params.id);
    if (!transfer) {
      return res.status(404).json({ message: "Stock transfer not found" });
    }
    const companyId = transfer.companyId;
    // Captured before any mutation — see saleController.updateSale for why the
    // rollback path must use these snapshots, not `transfer.items`/from/to (reassigned below).
    const oldItems = transfer.items;
    const oldFromGodownId = transfer.fromGodownId;
    const oldToGodownId = transfer.toGodownId;

    const { transferNo, transferDate, fromGodownId, toGodownId, notes, items } = req.body;

    if (transferNo && transferNo.trim() !== transfer.transferNo) {
      const exists = await StockTransfer.findOne({
        companyId: transfer.companyId,
        transferNo: transferNo.trim(),
        _id: { $ne: transfer._id },
      });
      if (exists) {
        return res.status(400).json({ message: "This transfer number already exists" });
      }
    }

    const newFromGodownId = fromGodownId || oldFromGodownId;
    const newToGodownId = toGodownId || oldToGodownId;
    if (String(newFromGodownId) === String(newToGodownId)) {
      return res.status(400).json({ message: "From Godown and To Godown must be different" });
    }
    await assertGodownsBelongToCompany([newFromGodownId, newToGodownId], companyId);

    // Reverse this transfer's OLD effect first (give stock back to the old FROM,
    // take it back out of the old TO) — same reverse-then-try-new-then-rollback
    // pattern as Sale/the Return controllers.
    await applyStockDelta(oldItems, oldFromGodownId, oldToGodownId, -1, companyId);

    try {
      const lines = await buildLines(items || oldItems, companyId);
      const totals = computeTotals(lines);
      await assertSufficientStock(lines, newFromGodownId, companyId);

      if (transferNo) transfer.transferNo = transferNo.trim();
      if (transferDate) transfer.transferDate = transferDate;
      if (fromGodownId) transfer.fromGodownId = fromGodownId;
      if (toGodownId) transfer.toGodownId = toGodownId;
      if (notes !== undefined) transfer.notes = notes;
      transfer.items = lines;
      Object.assign(transfer, totals);

      // Field mutation + save + reapply must all succeed together, or the reversal
      // above must be undone — see saleController.updateSale for the failure mode
      // this closes (a `.save()`-time validation error leaving stock desynced).
      await transfer.save();
      await applyStockDelta(lines, newFromGodownId, newToGodownId, 1, companyId);
    } catch (err) {
      await applyStockDelta(oldItems, oldFromGodownId, oldToGodownId, 1, companyId);
      throw err;
    }

    res.status(200).json(transfer);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const deleteStockTransfer = async (req, res) => {
  try {
    const transfer = await StockTransfer.findById(req.params.id);
    if (!transfer) {
      return res.status(404).json({ message: "Stock transfer not found" });
    }

    // Reversing means giving stock back to FROM and taking it back out of TO — TO's
    // stock may have moved on via a downstream Sale/transfer since this was created,
    // so check TO has enough before reversing (mirrors purchaseController's pattern
    // of checking before a reversal that removes stock).
    await assertSufficientStock(transfer.items, transfer.toGodownId, transfer.companyId);
    await applyStockDelta(transfer.items, transfer.fromGodownId, transfer.toGodownId, -1, transfer.companyId);
    await transfer.deleteOne();

    res.status(200).json({ message: "Stock transfer deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getStockTransfers,
  getStockTransferById,
  createStockTransfer,
  updateStockTransfer,
  deleteStockTransfer,
};
