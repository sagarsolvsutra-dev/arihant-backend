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
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
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
    // "Expired" (what the UI has always called this) — its own honestly-named field,
    // split off from openingStockDamagedCase/Pcs so "Damaged" can be a real, separate
    // third state below instead of the old field/label mismatch.
    openingStockExpiredCase: { type: Number, default: 0 },
    openingStockExpiredPcs: { type: Number, default: 0 },
    openingStockDamagedCase: { type: Number, default: 0 },
    openingStockDamagedPcs: { type: Number, default: 0 },
    lastCostRate: { type: Number, default: 0 },
    netCostRetailer: { type: Number, default: 0 },
    netCostWholesaler: { type: Number, default: 0 },
    netCostDistributor: { type: Number, default: 0 },
    netCostRetailerPerPiece: { type: Number, default: 0 },
    netCostWholesalerPerPiece: { type: Number, default: 0 },
    netCostDistributorPerPiece: { type: Number, default: 0 },
    mrpEntries: {
      type: [
        {
          mrp: { type: Number, default: 0 },
          mrpActive: { type: Boolean, default: true },
          purchaseRate: { type: Number, default: 0 },
          discountPercentage: { type: Number, default: 0 },
          netCostSelf: { type: Number, default: 0 },
          netCostSelfPerPiece: { type: Number, default: 0 },
          marginToCostRetailer: { type: Number, default: 0 },
          marginToCostWholesaler: { type: Number, default: 0 },
          marginToCostDistributor: { type: Number, default: 0 },
          marginToMrpRetailer: { type: Number, default: 0 },
          marginToMrpWholesaler: { type: Number, default: 0 },
          marginToMrpDistributor: { type: Number, default: 0 },
          retailRate: { type: Number, default: 0 },
          wholeSaleRate: { type: Number, default: 0 },
          distributorRate: { type: Number, default: 0 },
          netCostRetailer: { type: Number, default: 0 },
          netCostWholesaler: { type: Number, default: 0 },
          netCostDistributor: { type: Number, default: 0 },
          netCostRetailerPerPiece: { type: Number, default: 0 },
          netCostWholesalerPerPiece: { type: Number, default: 0 },
          netCostDistributorPerPiece: { type: Number, default: 0 },
          packing: { type: Number, default: 1 },
          purchaseQty: { type: Number, default: 1 },
          salesQty: { type: Number, default: 1 },
          minStockQty: { type: Number, default: 0 },
          weightPerPiece: { type: Number, default: 0 },
          schemeRemark: { type: String, default: "" },
          openingStockFreshCase: { type: Number, default: 0 },
          openingStockFreshPcs: { type: Number, default: 0 },
          openingStockExpiredCase: { type: Number, default: 0 },
          openingStockExpiredPcs: { type: Number, default: 0 },
          openingStockDamagedCase: { type: Number, default: 0 },
          openingStockDamagedPcs: { type: Number, default: 0 },
          // Per-godown breakdown of this MRP tier's stock. The flat opening-stock
          // fields above are kept as a rollup (sum across godownStock) for backward
          // compatibility with anything still reading them directly.
          godownStock: {
            type: [
              {
                godownId: {
                  type: mongoose.Schema.Types.ObjectId,
                  ref: "Godown",
                  required: true,
                },
                openingStockFreshCase: { type: Number, default: 0 },
                openingStockFreshPcs: { type: Number, default: 0 },
                openingStockExpiredCase: { type: Number, default: 0 },
                openingStockExpiredPcs: { type: Number, default: 0 },
                openingStockDamagedCase: { type: Number, default: 0 },
                openingStockDamagedPcs: { type: Number, default: 0 },
              },
            ],
            default: [],
          },
        },
      ],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Item + Sub Group together identify a unique product — the same Item Name can
// legitimately repeat across different Sub Groups (e.g. "Namkeen" under both
// "Ratlami Sev" and "Nylon Sev" as distinct varieties), so uniqueness is no longer
// on itemName alone. itemSubGroupId is nullable (Sub Group is optional on Items),
// and Mongo's compound unique index still correctly rejects two items sharing the
// same {companyId, itemName, itemSubGroupId: null} (no Sub Group at all).
ItemSchema.index({ companyId: 1, itemName: 1, itemSubGroupId: 1 }, { unique: true });

// codeBarCode must be unique per company — a partial index so it only applies to
// non-empty codes (codeBarCode is required client-side, but this stays safe for any
// legacy row that somehow has one blank; multiple blanks don't collide with each other).
// $gt: "" (not $ne) — partialFilterExpression only supports a limited operator set
// ($eq/$exists/$gt/$gte/$lt/$lte/$type), and an empty string sorts before every
// non-empty one, so this is equivalent to "codeBarCode is non-empty".
ItemSchema.index(
  { companyId: 1, codeBarCode: 1 },
  { unique: true, partialFilterExpression: { codeBarCode: { $gt: "" } } }
);

ItemSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("Item", ItemSchema);
