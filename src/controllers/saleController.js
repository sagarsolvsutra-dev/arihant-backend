const Sale = require("../models/Sale");
const Item = require("../models/Item");
const Godown = require("../models/Godown");
const Payment = require("../models/Payment");
const BankAccount = require("../models/BankAccount");
const { searchRegex, clampLimit, clampPage } = require("../utils/queryHelpers");
const { usesBankAccount } = require("../utils/paymentModes");

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
  // rate here would silently corrupt Item stock via applyStockDelta. gstPercent was
  // previously missing from this list.
  if (
    caseQty < 0 || pcsQty < 0 || freeQty < 0 || afterGstRate < 0 || lessRs < 0 || cdRs < 0 ||
    lessPercent < 0 || cdPercent < 0 || gstPercent < 0 || gstPercent > 100
  ) {
    throw new Error(`Quantities and rates cannot be negative (item: ${item.itemName})`);
  }
  // Case/Pcs/Free Qty are discrete piece counts — a fractional value was
  // previously accepted silently and would carry a floating-point remainder
  // through totalPieces/stock into the Item's stored pcs fields.
  if (!Number.isInteger(caseQty) || !Number.isInteger(pcsQty) || !Number.isInteger(freeQty)) {
    throw new Error(`Case, Pcs, and Free Qty must be whole numbers (item: ${item.itemName})`);
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
  const pricePerPiece = salesQty > 0 ? afterGstRate / salesQty : 0;

  const amount = pricePerPiece * billedPieces; // GST-inclusive, pre-discount
  const lessAmt = (amount * lessPercent) / 100 + lessRs;
  const cdAmt = (amount * cdPercent) / 100 + cdRs;
  // Discounts can never exceed the line's own amount — otherwise taxableValue/netValue
  // go negative with no error anywhere, silently corrupting the invoice total.
  if (lessAmt + cdAmt > amount + 1e-6) {
    throw new Error(`Discounts cannot exceed the line amount (item: ${item.itemName})`);
  }
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
// Item documents (rate/gst/packing snapshots come from the DB, not the client).
// Both Items and Godowns are scoped to `companyId` — without this, a line whose
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

// A sale can only draw down stock that actually exists in the selected godown's
// bucket for the matched MRP tier — checked as one pass over all lines BEFORE any
// stock is mutated, so a failed sale never leaves stock partially decremented.
// Aggregates by (itemId, mrp) first since the same item/rate could appear on more
// than one line. `companyId` scopes the Item lookup to prevent cross-tenant reads.
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
    const bucket = matchedEntry?.godownStock?.find((g) => String(g.godownId) === godownIdStr);
    const available = parseFloat(bucket?.openingStockFreshPcs) || 0;
    if (available < needed) {
      throw new Error(
        `Insufficient stock for "${nameByKey.get(key)}" in the selected godown (available: ${available} pcs, needed: ${needed} pcs)`
      );
    }
  }
}

// Reverses the auto-created advance-payment Payment record (+ its BankAccount
// effect) for one invoice, if one exists — matched via `allocations`, since
// Payment carries no direct FK back to its source invoice. Safe to call even
// when no such Payment exists. Shared by updateSale (before re-applying the
// new received amount) and deleteSale. See purchaseController's identical
// helper for the full rationale.
async function reverseInvoicePayment(invoiceId, invoiceType, companyId) {
  const existing = await Payment.findOne({
    companyId,
    "allocations.invoiceId": invoiceId,
    "allocations.invoiceType": invoiceType,
  });
  if (!existing) return;
  // Reversal is driven by the stored Payment, so it always undoes exactly what
  // was applied. The `existing.bankAccountId` half is what keeps records written
  // before Cheque/UPI moved the bank safe: those carry a null bankAccountId and
  // never debited anything, so they must not be credited back now.
  if (usesBankAccount(existing.paymentMode) && existing.bankAccountId) {
    await BankAccount.findByIdAndUpdate(existing.bankAccountId, {
      $inc: { currentBalance: existing.paymentType === "Pay" ? existing.amount : -existing.amount },
    });
  }
  await Payment.deleteOne({ _id: existing._id });
}

// Creates a fresh advance-payment Payment record (+ its BankAccount effect)
// for one invoice. Mirrors createSale's own inline block, extracted so
// updateSale can reuse it identically instead of re-deriving the same logic.
async function createInvoicePayment({ companyId, invoiceId, invoiceType, invoiceNo, date, partyType, partyId, paymentType, paymentMode, bankAccountId, amount, noteVerb }) {
  if (!(amount > 0)) return;
  if (usesBankAccount(paymentMode) && bankAccountId) {
    const bank = await BankAccount.findById(bankAccountId);
    if (!bank) throw new Error("Bank account not found");
    if (paymentType === "Pay") {
      if ((bank.currentBalance || 0) < amount) {
        throw new Error("Insufficient balance in selected Bank Account");
      }
      await BankAccount.findByIdAndUpdate(bankAccountId, { $inc: { currentBalance: -amount } });
    } else {
      await BankAccount.findByIdAndUpdate(bankAccountId, { $inc: { currentBalance: amount } });
    }
  }
  await Payment.create({
    companyId,
    paymentDate: date,
    paymentType,
    partyType,
    partyId: partyId || null,
    paymentMode: paymentMode || "Cash",
    bankAccountId: usesBankAccount(paymentMode) ? bankAccountId : null,
    amount,
    notes: `${noteVerb} ${invoiceType} Invoice ${invoiceNo}`,
    allocations: [{ invoiceId, invoiceType, allocatedAmount: amount }],
  });
}

// sign = -1 to apply a sale's stock effect (decrement), +1 to reverse it (increment).
// Mirrors purchaseController.applyStockDelta exactly, with the sign convention
// flipped — a sale draws stock down instead of building it up. Same non-destructive
// per-godown-bucket upsert, same "flat fields are the source of truth, godownStock is
// a Purchase/Sale-driven supplementary view" invariant. `companyId` scopes the Item
// lookup so a line can never mutate a different company's Item document.
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

    item.markModified("mrpEntries");
  }

  const newPcs = (parseFloat(item.openingStockFreshPcs) || 0) + sign * line.totalPieces;
  item.openingStockFreshPcs = newPcs;
  item.openingStockFreshCase = packing > 0 ? newPcs / packing : newPcs;

  await item.save();
}

// Self-healing against a partial mid-loop failure — see purchaseController's
// identical helper for the full rationale. If line N throws, lines 1..N-1
// that already committed are reversed here before re-throwing, so a failed
// call never leaves stock partially applied relative to where it started.
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

const getSales = async (req, res) => {
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
        page: parsedPage,
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
    const sale = await Sale.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId }).populate("customerId", "name customerType");
    if (!sale) {
      return res.status(404).json({ message: "Sale not found" });
    }
    res.status(200).json(sale);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const createSale = async (req, res) => {
  let sale;
  try {
    const { companyId, invoiceType, paymentType, invoiceNo, invoiceDate, deliveryDate, customerId, notes, items, receivedAmount, dueDate, paymentMode, bankAccountId } = req.body;

    if (!companyId || !invoiceNo || !invoiceDate || !customerId) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const exists = await Sale.findOne({ companyId, invoiceNo: invoiceNo.trim() });
    if (exists) {
      return res.status(400).json({ message: "This invoice number already exists" });
    }

    const lines = await buildLines(items, companyId);
    await assertSufficientStock(lines, companyId);
    const totals = computeTotals(lines);
    const received = parseFloat(receivedAmount) || 0;

    sale = await Sale.create({
      companyId,
      invoiceType: invoiceType || "Tax Invoice",
      paymentType: paymentType || "Credit",
      invoiceNo: invoiceNo.trim(),
      invoiceDate,
      deliveryDate: deliveryDate || null,
      customerId,
      notes: notes || "",
      items: lines,
      ...totals,
      receivedAmount: received,
      pendingAmount: totals.netAmount - received,
      paymentMode,
      bankAccountId: usesBankAccount(paymentMode) ? bankAccountId : null,
      dueDate: dueDate || null,
    });

    // Payment creation and the stock effect are both wrapped in the SAME try/catch —
    // a failure in either one must delete the just-created Sale and reverse whatever
    // advance-payment effect was already applied. See purchaseController's identical
    // fix for the real orphaned-document bug this closes.
    try {
      if (received > 0) {
        await createInvoicePayment({
          companyId,
          invoiceId: sale._id,
          invoiceType: "Sale",
          invoiceNo: sale.invoiceNo,
          date: invoiceDate,
          partyType: "Customer",
          partyId: customerId,
          paymentType: "Receive",
          paymentMode,
          bankAccountId,
          amount: received,
          noteVerb: "Advance for",
        });
      }
      await applyStockDelta(lines, -1, companyId);
    } catch (err) {
      await Sale.deleteOne({ _id: sale._id });
      await reverseInvoicePayment(sale._id, "Sale", companyId);
      throw err;
    }

    res.status(201).json(sale);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const updateSale = async (req, res) => {
  try {
    const sale = await Sale.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!sale) {
      return res.status(404).json({ message: "Sale not found" });
    }
    const companyId = sale.companyId;
    // Captured before any mutation — `sale.items` is reassigned below, so the
    // rollback path (if `.save()` or the reapply itself throws) must reverse using
    // this original snapshot, not whatever `sale.items` has since become.
    const oldItems = sale.items;
    const oldReceivedAmount = sale.receivedAmount;
    const oldPaymentMode = sale.paymentMode;
    const oldBankAccountId = sale.bankAccountId;
    const oldCustomerId = sale.customerId;
    const oldInvoiceNo = sale.invoiceNo;
    const oldInvoiceDate = sale.invoiceDate;

    const { invoiceType, paymentType, invoiceNo, invoiceDate, deliveryDate, customerId, notes, items, receivedAmount, dueDate, paymentMode, bankAccountId } = req.body;

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

    // Reverse the old stock impact before checking/applying the new one — if the new
    // lines turn out insufficient, roll the reversal back before propagating the
    // error so stock never ends up partially mutated. Each old line already carries
    // its own godownId, so this reverses each line against its own godown.
    await applyStockDelta(oldItems, 1, companyId);
    // Reverse whatever advance-payment effect the OLD received amount applied — the
    // (possibly unchanged) new amount is re-applied below once the rest of the
    // update succeeds, same reverse-then-reapply shape as the stock line above.
    await reverseInvoicePayment(sale._id, "Sale", companyId);

    try {
      const lines = await buildLines(items || oldItems, companyId);
      await assertSufficientStock(lines, companyId);
      const totals = computeTotals(lines);

      if (invoiceType) sale.invoiceType = invoiceType;
      if (paymentType) sale.paymentType = paymentType;
      if (invoiceNo) sale.invoiceNo = invoiceNo.trim();
      if (invoiceDate) sale.invoiceDate = invoiceDate;
      if (deliveryDate !== undefined) sale.deliveryDate = deliveryDate || null;
      if (customerId) sale.customerId = customerId;
      if (notes !== undefined) sale.notes = notes;
      sale.items = lines;
      Object.assign(sale, totals);

      const received = receivedAmount !== undefined ? parseFloat(receivedAmount) || 0 : oldReceivedAmount;
      sale.receivedAmount = received;
      sale.pendingAmount = totals.netAmount - received;
      if (paymentMode !== undefined) sale.paymentMode = paymentMode;
      if (usesBankAccount(paymentMode)) sale.bankAccountId = bankAccountId;
      else if (paymentMode) sale.bankAccountId = null;
      if (dueDate !== undefined) sale.dueDate = dueDate || null;

      // The field mutation + save + reapply must all succeed together, or the
      // reversal above must be undone — otherwise a validation/cast error thrown by
      // `.save()` itself (not caught by buildLines/assertSufficientStock, which never
      // touch Mongoose validation) leaves the document unchanged in the DB while its
      // stock has already been given back, and a retry of the same bad request
      // reverses the same sale again.
      await sale.save();
      await applyStockDelta(lines, -1, companyId);

      if (received > 0) {
        await createInvoicePayment({
          companyId,
          invoiceId: sale._id,
          invoiceType: "Sale",
          invoiceNo: sale.invoiceNo,
          date: sale.invoiceDate,
          partyType: "Customer",
          partyId: sale.customerId,
          paymentType: "Receive",
          paymentMode: sale.paymentMode,
          bankAccountId: sale.bankAccountId,
          amount: received,
          noteVerb: "Advance for",
        });
      }
    } catch (err) {
      await applyStockDelta(oldItems, -1, companyId);
      // Restore the OLD payment too, on a best-effort basis, so a failed update
      // doesn't leave the invoice with neither its old nor its new advance payment.
      if (oldReceivedAmount > 0) {
        await createInvoicePayment({
          companyId,
          invoiceId: sale._id,
          invoiceType: "Sale",
          invoiceNo: oldInvoiceNo,
          date: oldInvoiceDate,
          partyType: "Customer",
          partyId: oldCustomerId,
          paymentType: "Receive",
          paymentMode: oldPaymentMode,
          bankAccountId: oldBankAccountId,
          amount: oldReceivedAmount,
          noteVerb: "Advance for",
        }).catch(() => {});
      }
      throw err;
    }

    res.status(200).json(sale);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const deleteSale = async (req, res) => {
  try {
    const sale = await Sale.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!sale) {
      return res.status(404).json({ message: "Sale not found" });
    }

    await applyStockDelta(sale.items, 1, sale.companyId);
    // Reverse the advance-payment effect (bank balance + the Payment record) before
    // the invoice it's allocated to stops existing.
    await reverseInvoicePayment(sale._id, "Sale", sale.companyId);
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
