const express = require("express");

const pool = require("../database");
const authMiddleware = require("../middleware/authMiddleware");
const adminMiddleware = require("../middleware/adminMiddleware");

const router = express.Router();

// GET /api/products
router.get("/products", async (req, res) => {
  try {
    const result = await pool.query(
      `  SELECT
        products.id,
        products.name,
        products.price,
        products.is_available,
        categories.name AS category_name
      FROM products
      JOIN categories
        ON products.category_id = categories.id
        `,
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Database error",
    });
  }
});

// GET /api/products/:id
router.get("/products/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM products WHERE id = $1", [
      req.params.id,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Product not found",
      });
    }

    res.json(result.rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Database error",
    });
  }
});

// POST /api/products
router.post("/products", authMiddleware, adminMiddleware, async (req, res) => {
  const { category_id, name, price, is_available } = req.body;

  if (!Number.isInteger(category_id) || category_id <= 0) {
    return res.status(400).json({
      error: "Invalid category_id",
    });
  }

  if (typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({
      error: "Product name is required",
    });
  }

  if (typeof price !== "number" || price <= 0) {
    return res.status(400).json({
      error: "Invalid price",
    });
  }

  if (typeof is_available !== "boolean") {
    return res.status(400).json({
      error: "is_available must be a boolean",
    });
  }

  try {
    const categoryResult = await pool.query(
      `  
        SELECT id
        FROM categories
        WHERE id = $1
    `,
      [category_id],
    );

    if (categoryResult.rows.length === 0) {
      return res.status(400).json({
        error: "Category not found",
      });
    }

    const productResult = await pool.query(
      `    
        INSERT INTO products (
          category_id,
          name,
          price,
          is_available
        )
        VALUES ($1, $2, $3, $4)
        RETURNING *
    `,
      [category_id, name.trim(), price, is_available],
    );

    const product = productResult.rows[0];

    res.status(201).json({
      product,
      message: "Product created successfully",
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Database error",
    });
  }
});

// PATCH /api/products/:id
router.patch(
  "/products/:id",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    const productId = Number(req.params.id);

    if (!Number.isInteger(productId) || productId <= 0) {
      return res.status(400).json({
        error: "Invalid product id",
      });
    }

    const { name, category_id, price, is_available } = req.body;

    const updates = [];
    const values = [];

    if (name !== undefined) {
      if (typeof name !== "string" || name.trim() === "") {
        return res.status(400).json({
          error: "Invalid product name",
        });
      }

      updates.push("name");
      values.push(name.trim());
    }

    if (category_id !== undefined) {
      if (!Number.isInteger(category_id) || category_id <= 0) {
        return res.status(400).json({
          error: "Invalid category_id",
        });
      }

      updates.push("category_id");
      values.push(category_id);
    }

    if (price !== undefined) {
      if (typeof price !== "number" || price <= 0) {
        return res.status(400).json({
          error: "Invalid price",
        });
      }
      updates.push("price");
      values.push(price);
    }

    if (is_available !== undefined) {
      if (typeof is_available !== "boolean") {
        return res.status(400).json({
          error: "is_available must be a boolean",
        });
      }

      updates.push("is_available");
      values.push(is_available);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        error: "No valid fields to update",
      });
    }

    try {
      if (category_id !== undefined) {
        const categoryResult = await pool.query(
          `      
          SELECT id
          FROM categories
          WHERE id = $1
    `,
          [category_id],
        );

        if (categoryResult.rows.length === 0) {
          return res.status(400).json({
            error: "Category not found",
          });
        }
      }

      const setClause = updates
        .map((column, index) => `${column} = $${index + 1}`)
        .join(", ");

      values.push(productId);

      const result = await pool.query(
        `    
        UPDATE products
        SET ${setClause}
        WHERE id = $${values.length}
        RETURNING *
    `,
        values,
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "Product not found",
        });
      }

      res.status(200).json({
        product: result.rows[0],
        message: "Product updated successfully",
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Database error",
      });
    }
  },
);

module.exports = router;
