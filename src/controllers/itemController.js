const Item = require("../models/Item");

const getItems = async (req, res) => {
  try {
    const { companyId, page = 1, limit = 10, search = "" } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const query = { companyId };
    if (search) {
      query.$or = [
        { itemName: { $regex: search, $options: "i" } },
        { alias: { $regex: search, $options: "i" } },
        { hsnCode: { $regex: search, $options: "i" } },
        { codeBarCode: { $regex: search, $options: "i" } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const parsedLimit = parseInt(limit);

    const [items, total] = await Promise.all([
      Item.find(query)
        .populate("itemGroupId", "name")
        .populate("itemSubGroupId", "name")
        .sort({ createdAt: -1 }).lean()
        .skip(skip)
        .limit(parsedLimit).lean(),
      Item.countDocuments(query)
    ]);

    res.status(200).json({
      data: items,
      pagination: {
        total,
        page: parseInt(page),
        limit: parsedLimit,
        totalPages: Math.ceil(total / parsedLimit)
      }
    });
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

const createItem = async (req, res) => {
  try {
    const { companyId, itemName, alias, itemGroupId, itemSubGroupId, hsnCode, uqcUnit,
            purchaseRate, salesRate, mrp, wholeSaleRate, retailRate, commissionRate,
            minStockQty, maxStockQty, isActive,
            gstPercentage, hsnPrint, codeBarCode, packing, weightPerPiece, schemeRemark, mrpActive,
            discountPercentage, marginToCostRetailer, marginToCostWholesaler, marginToMrpRetailer, marginToMrpWholesaler,
            openingStockFreshCase, openingStockFreshPcs, openingStockDamagedCase, openingStockDamagedPcs, lastCostRate,
            purchaseType, salesType, distributorRate, marginToCostDistributor, marginToMrpDistributor
          } = req.body;

    if (!companyId || !itemName) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    const itemExists = await Item.findOne({ companyId, itemName });
    if (itemExists) {
      return res.status(400).json({ message: "Item already exists in this company" });
    }

    const item = await Item.create({
      companyId,
      itemName: itemName.trim(),
      alias: alias?.trim() || "",
      itemGroupId,
      itemSubGroupId,
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
    });

    res.status(201).json(item);
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

const updateItem = async (req, res) => {
  try {
    const item = await Item.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Item not found" });
    }

    const {
      itemName, alias, itemGroupId, itemSubGroupId, hsnCode, uqcUnit,
      purchaseRate, salesRate, mrp, wholeSaleRate, retailRate, commissionRate,
      minStockQty, maxStockQty, isActive,
      gstPercentage, hsnPrint, codeBarCode, packing, weightPerPiece, schemeRemark, mrpActive,
      discountPercentage, marginToCostRetailer, marginToCostWholesaler, marginToMrpRetailer, marginToMrpWholesaler,
      openingStockFreshCase, openingStockFreshPcs, openingStockDamagedCase, openingStockDamagedPcs, lastCostRate,
      purchaseType, salesType, distributorRate, marginToCostDistributor, marginToMrpDistributor,
      netCostRetailer, netCostWholesaler, netCostDistributor, netCostRetailerPerPiece, netCostWholesalerPerPiece, netCostDistributorPerPiece
    } = req.body;

    if (itemName) {
      const exists = await Item.findOne({ companyId: item.companyId, itemName, _id: { $ne: req.params.id } });
      if (exists) {
        return res.status(400).json({ message: "Another Item already exists with this name" });
      }
      item.itemName = itemName.trim();
    }

    if (alias !== undefined) item.alias = alias.trim() || "";
    if (itemGroupId !== undefined) item.itemGroupId = itemGroupId;
    if (itemSubGroupId !== undefined) item.itemSubGroupId = itemSubGroupId;
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
    if (codeBarCode !== undefined) item.codeBarCode = codeBarCode.trim() || "";
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
    if (salesType !== undefined) item.salesType = salesType;
    if (distributorRate !== undefined) item.distributorRate = parseFloat(distributorRate) || 0;
    if (marginToCostDistributor !== undefined) item.marginToCostDistributor = parseFloat(marginToCostDistributor) || 0;
    if (marginToMrpDistributor !== undefined) item.marginToMrpDistributor = parseFloat(marginToMrpDistributor) || 0;
    if (netCostRetailer !== undefined) item.netCostRetailer = parseFloat(netCostRetailer) || 0;
    if (netCostWholesaler !== undefined) item.netCostWholesaler = parseFloat(netCostWholesaler) || 0;
    if (netCostDistributor !== undefined) item.netCostDistributor = parseFloat(netCostDistributor) || 0;
    if (netCostRetailerPerPiece !== undefined) item.netCostRetailerPerPiece = parseFloat(netCostRetailerPerPiece) || 0;
    if (netCostWholesalerPerPiece !== undefined) item.netCostWholesalerPerPiece = parseFloat(netCostWholesalerPerPiece) || 0;
    if (netCostDistributorPerPiece !== undefined) item.netCostDistributorPerPiece = parseFloat(netCostDistributorPerPiece) || 0;

    await item.save();
    res.status(200).json(item);
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

const deleteItem = async (req, res) => {
  try {
    const item = await Item.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Item not found" });
    }
    await item.deleteOne();
    res.status(200).json({ message: "Item deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

module.exports = {
  getItems,
  createItem,
  updateItem,
  deleteItem,
};
