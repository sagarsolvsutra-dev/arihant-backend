const mongoose = require("mongoose");

const ItemSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    itemName: {
      type: String,
      required: true,
      trim: true,
    },
    itemGroupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ItemGroup",
      default: null,
    },
    itemSubGroupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ItemSubGroup",
      default: null,
    },
    hsnCode: {
      type: String,
      default: "",
    },
    uqcUnit: {
      type: String,
      default: "NOS-NUMBERS",
    },
    purchaseType: {
      type: String,
      enum: ["Carton", "Pieces"],
      default: "Carton",
    },
    purchaseQty: {
      type: Number,
      default: 1,
    },
    salesType: {
      type: String,
      enum: ["Carton", "Pieces"],
      default: "Pieces",
    },
    salesQty: {
      type: Number,
      default: 1,
    },
    purchaseRate: {
      type: Number,
      default: 0,
    },
    salesRate: {
      type: Number,
      default: 0,
    },
    mrp: {
      type: Number,
      default: 0,
    },
    wholeSaleRate: {
      type: Number,
      default: 0,
    },
    retailRate: {
      type: Number,
      default: 0,
    },
    commissionRate: {
      type: Number,
      default: 0,
    },
    minStockQty: {
      type: Number,
      default: 0,
    },
    maxStockQty: {
      type: Number,
      default: 0,
    },
    gstPercentage: { type: Number, default: 0 },
    hsnPrint: { type: String, default: "" },
    codeBarCode: { type: String, default: "" },
    packing: { type: Number, default: 1 },
    weightPerPiece: { type: Number, default: 0 },
    schemeRemark: { type: String, default: "" },
    mrpActive: { type: Boolean, default: true },
    discountPercentage: { type: Number, default: 0 },
    marginToCostRetailer: { type: Number, default: 0 },
    marginToCostWholesaler: { type: Number, default: 0 },
    marginToCostDistributor: { type: Number, default: 0 },
    marginToMrpRetailer: { type: Number, default: 0 },
    marginToMrpWholesaler: { type: Number, default: 0 },
    marginToMrpDistributor: { type: Number, default: 0 },
    distributorRate: { type: Number, default: 0 },
    openingStockFreshCase: { type: Number, default: 0 },
    openingStockFreshPcs: { type: Number, default: 0 },
    openingStockDamagedCase: { type: Number, default: 0 },
    openingStockDamagedPcs: { type: Number, default: 0 },
    lastCostRate: { type: Number, default: 0 },
    netCostRetailer: { type: Number, default: 0 },
    netCostWholesaler: { type: Number, default: 0 },
    netCostDistributor: { type: Number, default: 0 },
    netCostRetailerPerPiece: { type: Number, default: 0 },
    netCostWholesalerPerPiece: { type: Number, default: 0 },
    netCostDistributorPerPiece: { type: Number, default: 0 },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

ItemSchema.index({ companyId: 1, itemName: 1 }, { unique: true });

ItemSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("Item", ItemSchema);
