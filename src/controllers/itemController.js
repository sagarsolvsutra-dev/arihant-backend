const Item = require("../models/Item");
const Purchase = require("../models/Purchase");
const Sale = require("../models/Sale");
const PurchaseReturn = require("../models/PurchaseReturn");
const SaleReturn = require("../models/SaleReturn");
const StockTransfer = require("../models/StockTransfer");
const { searchRegex, clampLimit, clampPage } = require("../utils/queryHelpers");

// An item must always keep at least one MRP entry, and MRP values must stay
// unique per item (Purchase's rate lookup identifies an entry by its MRP).
function validateMrpEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "At least one MRP entry is required";
  }
  const seen = new Set();
  for (const entry of entries) {
    const mrp = parseFloat(entry.mrp) || 0;
    if (seen.has(mrp)) {
      return `Duplicate MRP entry: ${mrp}`;
    }
    seen.add(mrp);
  }
  return null;
}

const getItems = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, search = "" } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const query = { companyId };
    if (search) {
      query.$or = [
        { itemName: searchRegex(search) },
        { alias: searchRegex(search) },
        { hsnCode: searchRegex(search) },
        { codeBarCode: searchRegex(search) }
      ];
    }

    const parsedPage = clampPage(page);
    const parsedLimit = clampLimit(limit);
    const skip = (parsedPage - 1) * parsedLimit;

    const [items, total] = await Promise.all([
      Item.find(query)
        .populate("supplierId", "name")
        .populate("itemSubGroupId", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit).lean(),
      Item.countDocuments(query)
    ]);

    res.status(200).json({
      data: items,
      pagination: {
        total,
        page: parsedPage,
        limit: parsedLimit,
        totalPages: Math.ceil(total / parsedLimit)
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const getItemById = async (req, res) => {
  try {
    const item = await Item.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId })
      .populate("supplierId", "name")
      .populate("itemSubGroupId", "name");
    if (!item) {
      return res.status(404).json({ message: "Item not found" });
    }
    res.status(200).json(item);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const createItem = async (req, res) => {
  try {
    const { companyId, itemName, alias, supplierId, itemSubGroupId, hsnCode, uqcUnit,
            purchaseRate, salesRate, mrp, wholeSaleRate, retailRate, commissionRate,
            minStockQty, maxStockQty, isActive,
            gstPercentage, hsnPrint, codeBarCode, packing, weightPerPiece, schemeRemark, mrpActive,
            discountPercentage, marginToCostRetailer, marginToCostWholesaler, marginToMrpRetailer, marginToMrpWholesaler,
            openingStockFreshCase, openingStockFreshPcs, openingStockDamagedCase, openingStockDamagedPcs, lastCostRate,
            purchaseType, salesType, distributorRate, marginToCostDistributor, marginToMrpDistributor,
            netCostRetailer, netCostWholesaler, netCostDistributor, netCostRetailerPerPiece, netCostWholesalerPerPiece, netCostDistributorPerPiece,
            mrpEntries
          } = req.body;

    if (!companyId || !itemName) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    // Item Name + Sub Group together identify a unique product — the same Item Name
    // can legitimately repeat across different Sub Groups (see the matching index on
    // Item.js). itemSubGroupId is normalized to null the same way it's saved below,
    // so this check matches the index exactly regardless of "" vs undefined vs null.
    // Trimmed the same way the persisted value below is trimmed — otherwise a name
    // that trims down to an existing item's name (e.g. a trailing space) slips past
    // this check and collides on `.create()` with a raw, unformatted 500 instead.
    const trimmedItemName = itemName.trim();
    const itemExists = await Item.findOne({ companyId, itemName: trimmedItemName, itemSubGroupId: itemSubGroupId || null });
    if (itemExists) {
      return res.status(400).json({ message: "An item with this name already exists in this Sub Group" });
    }

    // Code/BarCode must be unique per company — the same physical barcode can't
    // identify two different items.
    const trimmedCode = codeBarCode?.trim() || "";
    if (trimmedCode) {
      const codeExists = await Item.findOne({ companyId, codeBarCode: trimmedCode });
      if (codeExists) {
        return res.status(400).json({ message: "An item with this Code/BarCode already exists" });
      }
    }

    // If the client didn't send explicit MRP entries, seed one from the flat pricing fields
    // so the item always has at least one row in its Multi-MRP grid. Mirrors the frontend's
    // net-cost formula exactly so this fallback entry isn't left showing Self Cost = 0.
    const fallbackPurchaseRate = parseFloat(purchaseRate) || 0;
    const fallbackDiscount = parseFloat(discountPercentage) || 0;
    const fallbackGst = parseFloat(gstPercentage) || 0;
    const fallbackPurchaseQty = parseFloat(req.body.purchaseQty) || 1;
    const fallbackSalesQty = parseFloat(req.body.salesQty) || 1;
    const fallbackDiscounted = fallbackPurchaseRate - fallbackPurchaseRate * (fallbackDiscount / 100);
    const fallbackNetCostSelf = fallbackDiscounted + fallbackDiscounted * (fallbackGst / 100);
    const fallbackNetCostSelfPerPiece =
      fallbackPurchaseQty > 0 ? (fallbackNetCostSelf / fallbackPurchaseQty) * fallbackSalesQty : fallbackNetCostSelf;

    const resolvedMrpEntries = Array.isArray(mrpEntries) && mrpEntries.length > 0
      ? mrpEntries
      : [{
          mrp: parseFloat(mrp) || 0,
          mrpActive: mrpActive !== undefined ? mrpActive : true,
          purchaseRate: fallbackPurchaseRate,
          discountPercentage: fallbackDiscount,
          netCostSelf: fallbackNetCostSelf,
          netCostSelfPerPiece: fallbackNetCostSelfPerPiece,
          marginToCostRetailer: parseFloat(marginToCostRetailer) || 0,
          marginToCostWholesaler: parseFloat(marginToCostWholesaler) || 0,
          marginToCostDistributor: parseFloat(marginToCostDistributor) || 0,
          marginToMrpRetailer: parseFloat(marginToMrpRetailer) || 0,
          marginToMrpWholesaler: parseFloat(marginToMrpWholesaler) || 0,
          marginToMrpDistributor: parseFloat(marginToMrpDistributor) || 0,
          retailRate: parseFloat(retailRate) || 0,
          wholeSaleRate: parseFloat(wholeSaleRate) || 0,
          distributorRate: parseFloat(distributorRate) || 0,
          netCostRetailer: parseFloat(netCostRetailer) || 0,
          netCostWholesaler: parseFloat(netCostWholesaler) || 0,
          netCostDistributor: parseFloat(netCostDistributor) || 0,
          netCostRetailerPerPiece: parseFloat(netCostRetailerPerPiece) || 0,
          netCostWholesalerPerPiece: parseFloat(netCostWholesalerPerPiece) || 0,
          netCostDistributorPerPiece: parseFloat(netCostDistributorPerPiece) || 0,
          packing: parseFloat(packing) || 1,
          purchaseQty: parseFloat(req.body.purchaseQty) || 1,
          salesQty: parseFloat(req.body.salesQty) || 1,
          minStockQty: parseFloat(minStockQty) || 0,
          weightPerPiece: parseFloat(weightPerPiece) || 0,
          schemeRemark: schemeRemark?.trim() || "",
          openingStockFreshCase: parseFloat(openingStockFreshCase) || 0,
          openingStockFreshPcs: parseFloat(openingStockFreshPcs) || 0,
          openingStockDamagedCase: parseFloat(openingStockDamagedCase) || 0,
          openingStockDamagedPcs: parseFloat(openingStockDamagedPcs) || 0,
        }];

    const mrpEntriesError = validateMrpEntries(resolvedMrpEntries);
    if (mrpEntriesError) {
      return res.status(400).json({ message: mrpEntriesError });
    }

    const item = await Item.create({
      companyId,
      itemName: itemName.trim(),
      alias: alias?.trim() || "",
      supplierId,
      itemSubGroupId: itemSubGroupId || null,
      hsnCode: hsnCode?.trim() || "",
      uqcUnit: uqcUnit || "NOS-NUMBERS",
      purchaseRate: parseFloat(purchaseRate) || 0,
      salesRate: parseFloat(salesRate) || 0,
      mrp: parseFloat(mrp) || 0,
      wholeSaleRate: parseFloat(wholeSaleRate) || 0,
      retailRate: parseFloat(retailRate) || 0,
      commissionRate: parseFloat(commissionRate) || 0,
      minStockQty: parseFloat(minStockQty) || 0,
      maxStockQty: parseFloat(maxStockQty) || 0,
      isActive: isActive !== undefined ? isActive : true,
      gstPercentage: parseFloat(gstPercentage) || 0,
      hsnPrint: hsnPrint?.trim() || "",
      codeBarCode: codeBarCode?.trim() || "",
      packing: parseFloat(packing) || 1,
      weightPerPiece: parseFloat(weightPerPiece) || 0,
      schemeRemark: schemeRemark?.trim() || "",
      mrpActive: mrpActive !== undefined ? mrpActive : true,
      discountPercentage: parseFloat(discountPercentage) || 0,
      marginToCostRetailer: parseFloat(marginToCostRetailer) || 0,
      marginToCostWholesaler: parseFloat(marginToCostWholesaler) || 0,
      marginToMrpRetailer: parseFloat(marginToMrpRetailer) || 0,
      marginToMrpWholesaler: parseFloat(marginToMrpWholesaler) || 0,
      openingStockFreshCase: parseFloat(openingStockFreshCase) || 0,
      openingStockFreshPcs: parseFloat(openingStockFreshPcs) || 0,
      openingStockDamagedCase: parseFloat(openingStockDamagedCase) || 0,
      openingStockDamagedPcs: parseFloat(openingStockDamagedPcs) || 0,
      lastCostRate: parseFloat(lastCostRate) || 0,
      purchaseType: purchaseType || "Carton",
      purchaseQty: parseFloat(req.body.purchaseQty) || 1,
      salesType: salesType || "Pieces",
      salesQty: parseFloat(req.body.salesQty) || 1,
      distributorRate: parseFloat(distributorRate) || 0,
      marginToCostDistributor: parseFloat(marginToCostDistributor) || 0,
      marginToMrpDistributor: parseFloat(marginToMrpDistributor) || 0,
      netCostRetailer: parseFloat(netCostRetailer) || 0,
      netCostWholesaler: parseFloat(netCostWholesaler) || 0,
      netCostDistributor: parseFloat(netCostDistributor) || 0,
      netCostRetailerPerPiece: parseFloat(netCostRetailerPerPiece) || 0,
      netCostWholesalerPerPiece: parseFloat(netCostWholesalerPerPiece) || 0,
      netCostDistributorPerPiece: parseFloat(netCostDistributorPerPiece) || 0,
      mrpEntries: resolvedMrpEntries,
    });

    res.status(201).json(item);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const updateItem = async (req, res) => {
  try {
    const item = await Item.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!item) {
      return res.status(404).json({ message: "Item not found" });
    }

    const {
      itemName, alias, supplierId, itemSubGroupId, hsnCode, uqcUnit,
      purchaseRate, salesRate, mrp, wholeSaleRate, retailRate, commissionRate,
      minStockQty, maxStockQty, isActive,
      gstPercentage, hsnPrint, codeBarCode, packing, weightPerPiece, schemeRemark, mrpActive,
      discountPercentage, marginToCostRetailer, marginToCostWholesaler, marginToMrpRetailer, marginToMrpWholesaler,
      openingStockFreshCase, openingStockFreshPcs, openingStockDamagedCase, openingStockDamagedPcs, lastCostRate,
      purchaseType, salesType, purchaseQty, salesQty, distributorRate, marginToCostDistributor, marginToMrpDistributor,
      netCostRetailer, netCostWholesaler, netCostDistributor, netCostRetailerPerPiece, netCostWholesalerPerPiece, netCostDistributorPerPiece,
      mrpEntries
    } = req.body;

    // Item Name + Sub Group together identify a unique product (same rule as
    // createItem/the compound index) — the same name can legitimately repeat across
    // different Sub Groups, so this must check both, not itemName alone. Runs whenever
    // either field is present in the request, using the EFFECTIVE post-update value for
    // whichever one isn't being changed right now.
    if (itemName !== undefined || itemSubGroupId !== undefined) {
      const effectiveName = itemName !== undefined ? itemName.trim() : item.itemName;
      const effectiveSubGroupId = itemSubGroupId !== undefined ? (itemSubGroupId || null) : (item.itemSubGroupId || null);
      const exists = await Item.findOne({
        companyId: item.companyId,
        itemName: effectiveName,
        itemSubGroupId: effectiveSubGroupId,
        _id: { $ne: req.params.id },
      });
      if (exists) {
        return res.status(400).json({ message: "An item with this name already exists in this Sub Group" });
      }
    }
    if (itemName !== undefined) item.itemName = itemName.trim();

    if (alias !== undefined) item.alias = alias.trim() || "";
    if (supplierId !== undefined) item.supplierId = supplierId;
    if (itemSubGroupId !== undefined) item.itemSubGroupId = itemSubGroupId || null;
    if (hsnCode !== undefined) item.hsnCode = hsnCode.trim() || "";
    if (uqcUnit !== undefined) item.uqcUnit = uqcUnit;
    if (purchaseRate !== undefined) item.purchaseRate = parseFloat(purchaseRate) || 0;
    if (salesRate !== undefined) item.salesRate = parseFloat(salesRate) || 0;
    if (mrp !== undefined) item.mrp = parseFloat(mrp) || 0;
    if (wholeSaleRate !== undefined) item.wholeSaleRate = parseFloat(wholeSaleRate) || 0;
    if (retailRate !== undefined) item.retailRate = parseFloat(retailRate) || 0;
    if (commissionRate !== undefined) item.commissionRate = parseFloat(commissionRate) || 0;
    if (minStockQty !== undefined) item.minStockQty = parseFloat(minStockQty) || 0;
    if (maxStockQty !== undefined) item.maxStockQty = parseFloat(maxStockQty) || 0;
    if (isActive !== undefined) item.isActive = isActive;
    
    if (gstPercentage !== undefined) item.gstPercentage = parseFloat(gstPercentage) || 0;
    if (hsnPrint !== undefined) item.hsnPrint = hsnPrint.trim() || "";
    if (codeBarCode !== undefined) {
      const trimmedCode = codeBarCode.trim() || "";
      if (trimmedCode) {
        const codeExists = await Item.findOne({
          companyId: item.companyId,
          codeBarCode: trimmedCode,
          _id: { $ne: req.params.id },
        });
        if (codeExists) {
          return res.status(400).json({ message: "Another item already exists with this Code/BarCode" });
        }
      }
      item.codeBarCode = trimmedCode;
    }
    if (packing !== undefined) item.packing = parseFloat(packing) || 1;
    if (weightPerPiece !== undefined) item.weightPerPiece = parseFloat(weightPerPiece) || 0;
    if (schemeRemark !== undefined) item.schemeRemark = schemeRemark.trim() || "";
    if (mrpActive !== undefined) item.mrpActive = mrpActive;
    if (discountPercentage !== undefined) item.discountPercentage = parseFloat(discountPercentage) || 0;
    if (marginToCostRetailer !== undefined) item.marginToCostRetailer = parseFloat(marginToCostRetailer) || 0;
    if (marginToCostWholesaler !== undefined) item.marginToCostWholesaler = parseFloat(marginToCostWholesaler) || 0;
    if (marginToMrpRetailer !== undefined) item.marginToMrpRetailer = parseFloat(marginToMrpRetailer) || 0;
    if (marginToMrpWholesaler !== undefined) item.marginToMrpWholesaler = parseFloat(marginToMrpWholesaler) || 0;
    if (openingStockFreshCase !== undefined) item.openingStockFreshCase = parseFloat(openingStockFreshCase) || 0;
    if (openingStockFreshPcs !== undefined) item.openingStockFreshPcs = parseFloat(openingStockFreshPcs) || 0;
    if (openingStockDamagedCase !== undefined) item.openingStockDamagedCase = parseFloat(openingStockDamagedCase) || 0;
    if (openingStockDamagedPcs !== undefined) item.openingStockDamagedPcs = parseFloat(openingStockDamagedPcs) || 0;
    if (lastCostRate !== undefined) item.lastCostRate = parseFloat(lastCostRate) || 0;

    if (purchaseType !== undefined) item.purchaseType = purchaseType;
    if (purchaseQty !== undefined) item.purchaseQty = parseFloat(purchaseQty) || 1;
    if (salesType !== undefined) item.salesType = salesType;
    if (salesQty !== undefined) item.salesQty = parseFloat(salesQty) || 1;
    if (distributorRate !== undefined) item.distributorRate = parseFloat(distributorRate) || 0;
    if (marginToCostDistributor !== undefined) item.marginToCostDistributor = parseFloat(marginToCostDistributor) || 0;
    if (marginToMrpDistributor !== undefined) item.marginToMrpDistributor = parseFloat(marginToMrpDistributor) || 0;
    if (netCostRetailer !== undefined) item.netCostRetailer = parseFloat(netCostRetailer) || 0;
    if (netCostWholesaler !== undefined) item.netCostWholesaler = parseFloat(netCostWholesaler) || 0;
    if (netCostDistributor !== undefined) item.netCostDistributor = parseFloat(netCostDistributor) || 0;
    if (netCostRetailerPerPiece !== undefined) item.netCostRetailerPerPiece = parseFloat(netCostRetailerPerPiece) || 0;
    if (netCostWholesalerPerPiece !== undefined) item.netCostWholesalerPerPiece = parseFloat(netCostWholesalerPerPiece) || 0;
    if (netCostDistributorPerPiece !== undefined) item.netCostDistributorPerPiece = parseFloat(netCostDistributorPerPiece) || 0;
    if (Array.isArray(mrpEntries)) {
      const mrpEntriesError = validateMrpEntries(mrpEntries);
      if (mrpEntriesError) {
        return res.status(400).json({ message: mrpEntriesError });
      }
      // The Items Edit UI only ever sends pricing/opening-stock fields per entry — it
      // never includes godownStock (a Purchase/Sale-driven side view the Items form
      // has no field for). A raw replace here silently wiped out real per-godown
      // stock history the moment any MRP entry was edited or reordered, even with no
      // value changes. Preserve each existing entry's own godownStock by matching on
      // MRP (the entry's identity key — see validateMrpEntries) and carrying it over
      // onto the incoming entry, unless the client explicitly sent its own non-empty
      // godownStock for that entry.
      const existingGodownStockByMrp = new Map(
        (item.mrpEntries || []).map((e) => [parseFloat(e.mrp) || 0, e.godownStock || []])
      );
      item.mrpEntries = mrpEntries.map((e) => ({
        ...e,
        godownStock:
          Array.isArray(e.godownStock) && e.godownStock.length > 0
            ? e.godownStock
            : existingGodownStockByMrp.get(parseFloat(e.mrp) || 0) || [],
      }));
    }

    await item.save();
    res.status(200).json(item);
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

const deleteItem = async (req, res) => {
  try {
    const item = await Item.findOne({ _id: req.params.id, companyId: req.effectiveCompanyId });
    if (!item) {
      return res.status(404).json({ message: "Item not found" });
    }

    // A deleted Item is looked up by every transactional controller's applyStockDelta
    // / assertSufficientStock via `if (!item) continue;` — a silent skip, not an
    // error — so deleting an item with real transaction history would silently
    // disable stock-integrity checks for every past Purchase/Sale/Return/Transfer
    // line that references it, letting a later edit/delete of one of those documents
    // update/remove with no stock effect at all while still succeeding.
    const [hasPurchase, hasSale, hasPurchaseReturn, hasSaleReturn, hasTransfer] = await Promise.all([
      Purchase.exists({ companyId: item.companyId, "items.itemId": item._id }),
      Sale.exists({ companyId: item.companyId, "items.itemId": item._id }),
      PurchaseReturn.exists({ companyId: item.companyId, "items.itemId": item._id }),
      SaleReturn.exists({ companyId: item.companyId, "items.itemId": item._id }),
      StockTransfer.exists({ companyId: item.companyId, "items.itemId": item._id }),
    ]);
    if (hasPurchase || hasSale || hasPurchaseReturn || hasSaleReturn || hasTransfer) {
      return res.status(400).json({
        message: "Cannot delete this item — it has Purchase, Sale, Return, or Stock Transfer history. Deactivate it instead.",
      });
    }

    await item.deleteOne();
    res.status(200).json({ message: "Item deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server Error" });
  }
};

module.exports = {
  getItems,
  getItemById,
  createItem,
  updateItem,
  deleteItem,
};
