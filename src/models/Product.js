const mongoose = require("mongoose");

const ProductSchema = new mongoose.Schema(
  {
    srNo: {
      type: Number,
      required: true,
    },
    code: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    image: {
      type: String,
    },
    name: {
      type: String,
      required: true,
    },
    hsn: {
      type: String,
    },
    mrp: {
      type: String,
      required: true,
    },
    qty: {
      type: Number,
      required: true,
      default: 0,
    },
    alertQty: {
      type: Number,
      required: true,
      default: 5,
    },
    gst: {
      type: String,
      required: true,
    },
    brand: {
      type: String,
      required: true,
    },
    category: {
      type: String,
      required: true,
    },
    expiry: {
      type: String,
      default: "NA",
    },
    status: {
      type: String,
      enum: ["Active", "Inactive"],
      default: "Active",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Product", ProductSchema);
