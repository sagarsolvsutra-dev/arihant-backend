const PurchaseReturn = require("../models/PurchaseReturn");
const Purchase = require("../models/Purchase");
const Item = require("../models/Item");
const Godown = require("../models/Godown");
const Payment = require("../models/Payment");
const BankAccount = require("../models/BankAccount");
const { searchRegex, clampLimit, clampPage } = require("../utils/queryHelpers");
const { usesBankAccount } = require("../utils/paymentModes");

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

  if (
    caseQty < 0 || pcsQty < 0 || freeQty < 0 || beforeGstRate < 0 || lessRs < 0 || cdRs < 0 ||
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
  const pricePerPiece = purchaseQty > 0 ? beforeGstRate / purchaseQty : 0;

  const amount = pricePerPiece * billedPieces;
  const lessAmt = (amount * lessPercent) / 100 + lessRs;
  const cdAmt = (amount * cdPercent) / 100 + cdRs;
  // Discounts can never exceed the line's own amount — otherwise taxableValue/netValue
  // go negative with no error anywhere, silently corrupting the return total.
  if (lessAmt + cdAmt > amount + 1e-6) {
    throw new Error(`Discounts cannot exceed the line amount (item: ${item.itemName})`);
  }
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
// `companyId` scopes the Item lookup to prevent cross-tenant reads.
//
// Deliberately NOT condition-aware, unlike Sale Return: a Purchase Return sends
// back physical stock that's actually sitting in the Fresh bucket (the Damaged
// bucket is essentially never populated in real usage — only a Sale Return with
// condition=Damaged puts anything there). "Condition" on a Purchase Return line is
// just a descriptive reason for the return (recorded on the line, shown in the
// grid) — it does NOT change which bucket is checked/decremented.
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
        `Insufficient stock for "${nameByKey.get(key)}" in the selected godown to return (available: ${available} pcs, needed: ${needed} pcs)`
      );
    }
  }
}

// Reverses the auto-created refund Payment record (+ its BankAccount effect)
// for one invoice, if one exists — matched via `allocations`. Safe to call
// even when none exists. Shared by updatePurchaseReturn and
// deletePurchaseReturn. See purchaseController's identical helper.
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

// Creates a fresh refund Payment record (+ its BankAccount effect) for one
// invoice. Mirrors createPurchaseReturn's own inline block, extracted so
// updatePurchaseReturn can reuse it identically.
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
    notes: `${noteVerb} ${invoiceType} ${invoiceNo}`,
    allocations: [{ invoiceId, invoiceType, allocatedAmount: amount }],
  });
}

// sign = -1 to apply a purchase return's stock effect (decrement), +1 to reverse it.
// Same non-destructive per-godown-bucket upsert as Purchase/Sale's applyStockDelta,
// but deliberately does NOT touch lastCostRate/purchaseRate — those are purchase-
// history fields, not meaningful for a return. Always moves the Fresh bucket,
// regardless of line.condition — see assertSufficientStock above for why.
// `companyId` scopes the Item lookup so a line can never mutate a different
// company's Item document.
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
// identical helper for the full rationale.
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

const getPurchaseReturns = async (req, res) => {
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
        page: parsedPage,
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
    const purchaseReturn = await PurchaseReturn.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId }).populate("supplierId", "name");
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
  let purchaseReturn;
  try {
    const {
      companyId,
      returnNo,
      returnDate,
      supplierId,
      originalInvoiceNo,
      originalPurchaseId,
      notes,
      items,
      refundAmount,
      dueDate,
      paymentMode,
      bankAccountId,
    } = req.body;

    if (!companyId || !returnNo || !returnDate || !supplierId) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const exists = await PurchaseReturn.findOne({ companyId, returnNo: returnNo.trim() });
    if (exists) {
      return res.status(400).json({ message: "This return number already exists" });
    }

    const lines = await buildLines(items, companyId);

    if (originalPurchaseId) {
      const original = await Purchase.findOne({ _id: originalPurchaseId, companyId });
      if (original) validateAgainstOriginal(lines, original.items);
    }

    await assertSufficientStock(lines, companyId);
    const totals = computeTotals(lines);
    const refund = parseFloat(refundAmount) || 0;

    purchaseReturn = await PurchaseReturn.create({
      companyId,
      returnNo: returnNo.trim(),
      returnDate,
      supplierId,
      originalInvoiceNo: originalInvoiceNo || "",
      originalPurchaseId: originalPurchaseId || null,
      notes: notes || "",
      items: lines,
      ...totals,
      refundAmount: refund,
      pendingAmount: totals.netAmount - refund,
      paymentMode,
      bankAccountId: usesBankAccount(paymentMode) ? bankAccountId : null,
      dueDate: dueDate || null,
    });

    // Payment creation and the stock effect are both wrapped in the SAME try/catch —
    // a failure in either one must delete the just-created PurchaseReturn and reverse
    // whatever refund-payment effect was already applied. See purchaseController's
    // identical fix for the real orphaned-document bug this closes (confirmed live:
    // an earlier version here left an orphaned PurchaseReturn behind when the Payment
    // model's invoiceType enum mismatch made createInvoicePayment throw).
    try {
      if (refund > 0) {
        await createInvoicePayment({
          companyId,
          invoiceId: purchaseReturn._id,
          invoiceType: "PurchaseReturn",
          invoiceNo: returnNo,
          date: returnDate,
          partyType: "Supplier",
          partyId: supplierId,
          paymentType: "Receive",
          paymentMode,
          bankAccountId,
          amount: refund,
          noteVerb: "Refund for",
        });
      }
      await applyStockDelta(lines, -1, companyId);
    } catch (err) {
      await PurchaseReturn.deleteOne({ _id: purchaseReturn._id });
      await reverseInvoicePayment(purchaseReturn._id, "PurchaseReturn", companyId);
      throw err;
    }

    res.status(201).json(purchaseReturn);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const updatePurchaseReturn = async (req, res) => {
  try {
    const purchaseReturn = await PurchaseReturn.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!purchaseReturn) {
      return res.status(404).json({ message: "Purchase Return not found" });
    }
    const companyId = purchaseReturn.companyId;
    // Captured before any mutation — see saleController.updateSale for why the
    // rollback path must use this snapshot, not `purchaseReturn.items` (reassigned below).
    const oldItems = purchaseReturn.items;
    const oldRefundAmount = purchaseReturn.refundAmount;
    const oldPaymentMode = purchaseReturn.paymentMode;
    const oldBankAccountId = purchaseReturn.bankAccountId;
    const oldSupplierId = purchaseReturn.supplierId;
    const oldReturnNo = purchaseReturn.returnNo;
    const oldReturnDate = purchaseReturn.returnDate;

    const {
      returnNo,
      returnDate,
      supplierId,
      originalInvoiceNo,
      originalPurchaseId,
      notes,
      items,
      refundAmount,
      dueDate,
      paymentMode,
      bankAccountId,
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

    // Reverse the old stock impact before checking/applying the new one — if the new
    // lines don't validate, roll the reversal back before propagating the error so
    // stock never ends up partially mutated. Each old line already carries its own
    // godownId, so this reverses each line against its own godown.
    await applyStockDelta(oldItems, 1, companyId);
    // Reverse whatever refund-payment effect the OLD refund amount applied — the
    // (possibly unchanged) new amount is re-applied below once the rest of the
    // update succeeds, same reverse-then-reapply shape as the stock line above.
    await reverseInvoicePayment(purchaseReturn._id, "PurchaseReturn", companyId);

    try {
      const lines = await buildLines(items || oldItems, companyId);
      const resolvedOriginalId = originalPurchaseId !== undefined ? originalPurchaseId : purchaseReturn.originalPurchaseId;
      if (resolvedOriginalId) {
        const original = await Purchase.findOne({ _id: resolvedOriginalId, companyId });
        if (original) validateAgainstOriginal(lines, original.items);
      }
      await assertSufficientStock(lines, companyId);
      const totals = computeTotals(lines);

      if (returnNo) purchaseReturn.returnNo = returnNo.trim();
      if (returnDate) purchaseReturn.returnDate = returnDate;
      if (supplierId) purchaseReturn.supplierId = supplierId;
      if (originalInvoiceNo !== undefined) purchaseReturn.originalInvoiceNo = originalInvoiceNo;
      if (originalPurchaseId !== undefined) purchaseReturn.originalPurchaseId = originalPurchaseId || null;
      if (notes !== undefined) purchaseReturn.notes = notes;
      purchaseReturn.items = lines;
      Object.assign(purchaseReturn, totals);

      const refund = refundAmount !== undefined ? parseFloat(refundAmount) || 0 : oldRefundAmount;
      purchaseReturn.refundAmount = refund;
      purchaseReturn.pendingAmount = totals.netAmount - refund;
      if (paymentMode !== undefined) purchaseReturn.paymentMode = paymentMode;
      if (usesBankAccount(paymentMode)) purchaseReturn.bankAccountId = bankAccountId;
      else if (paymentMode) purchaseReturn.bankAccountId = null;
      if (dueDate !== undefined) purchaseReturn.dueDate = dueDate || null;

      // Field mutation + save + reapply must all succeed together, or the reversal
      // above must be undone — see saleController.updateSale for the failure mode
      // this closes (a `.save()`-time validation error leaving stock desynced).
      await purchaseReturn.save();
      await applyStockDelta(lines, -1, companyId);

      if (refund > 0) {
        await createInvoicePayment({
          companyId,
          invoiceId: purchaseReturn._id,
          invoiceType: "PurchaseReturn",
          invoiceNo: purchaseReturn.returnNo,
          date: purchaseReturn.returnDate,
          partyType: "Supplier",
          partyId: purchaseReturn.supplierId,
          paymentType: "Receive",
          paymentMode: purchaseReturn.paymentMode,
          bankAccountId: purchaseReturn.bankAccountId,
          amount: refund,
          noteVerb: "Refund for",
        });
      }
    } catch (err) {
      await applyStockDelta(oldItems, -1, companyId);
      if (oldRefundAmount > 0) {
        await createInvoicePayment({
          companyId,
          invoiceId: purchaseReturn._id,
          invoiceType: "PurchaseReturn",
          invoiceNo: oldReturnNo,
          date: oldReturnDate,
          partyType: "Supplier",
          partyId: oldSupplierId,
          paymentType: "Receive",
          paymentMode: oldPaymentMode,
          bankAccountId: oldBankAccountId,
          amount: oldRefundAmount,
          noteVerb: "Refund for",
        }).catch(() => {});
      }
      throw err;
    }

    res.status(200).json(purchaseReturn);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const deletePurchaseReturn = async (req, res) => {
  try {
    const purchaseReturn = await PurchaseReturn.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!purchaseReturn) {
      return res.status(404).json({ message: "Purchase Return not found" });
    }

    await applyStockDelta(purchaseReturn.items, 1, purchaseReturn.companyId);
    await reverseInvoicePayment(purchaseReturn._id, "PurchaseReturn", purchaseReturn.companyId);
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
