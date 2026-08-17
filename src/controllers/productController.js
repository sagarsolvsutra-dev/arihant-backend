const Product = require("../models/Product");

// @desc    Get all products
// @route   GET /api/products
// @access  Public
const getProducts = async (req, res) => {
  try {
    const products = await Product.find({}).sort({ srNo: 1 });
    res.status(200).json(products);
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// @desc    Create a new product
// @route   POST /api/products
// @access  Public
const createProduct = async (req, res) => {
  try {
    const { code, name, mrp, qty, alertQty, gst, brand, category } = req.body;

    if (!code || !name || !mrp || qty === undefined || !gst || !brand || !category) {
      return res.status(400).json({ message: "Please provide all required fields" });
    }

    // Check if product code already exists
    const productExists = await Product.findOne({ code });
    if (productExists) {
      return res.status(400).json({ message: "Product with this code already exists" });
    }

    // Auto-calculate srNo if not provided
    let srNo = req.body.srNo;
    if (!srNo) {
      const lastProduct = await Product.findOne().sort({ srNo: -1 });
      srNo = lastProduct ? lastProduct.srNo + 1 : 1;
    }

    const product = await Product.create({
      ...req.body,
      srNo,
    });

    res.status(201).json(product);
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// @desc    Delete a product
// @route   DELETE /api/products/:id
// @access  Public
const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    await product.deleteOne();
    res.status(200).json({ message: "Product deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

module.exports = {
  getProducts,
  createProduct,
  deleteProduct,
};
