const express = require("express");
const pool = require("../database");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/cart", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;

    const result = await pool.query(
      `  
        SELECT
          cart_items.id,
          cart_items.product_id,
          cart_items.quantity,
          products.name,
          products.price,
          products.image_url
        FROM carts
        JOIN cart_items
          ON cart_items.cart_id = carts.id
        JOIN products
          ON products.id = cart_items.product_id
        WHERE carts.user_id = $1
        ORDER BY cart_items.id
    `,
      [userId],
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Database error",
    });
  }
});

router.post("/cart/items", authMiddleware, async (req, res) => {
  const { productId, quantity = 1 } = req.body;
  const userId = req.user.userId;

  if (!productId) {
    return res.status(400).json({
      error: "Product ID is required",
    });
  }

  if (!Number.isInteger(quantity) || quantity <= 0) {
    return res.status(400).json({
      error: "Quantity must be a positive integer",
    });
  }

  try {
    // 1. Check product
    const productResult = await pool.query(
      ` 
        SELECT id, name, price, is_available
        FROM products
        WHERE id = $1
    `,
      [productId],
    );

    if (productResult.rows.length === 0) {
      return res.status(404).json({
        error: "Product not found",
      });
    }

    const product = productResult.rows[0];

    if (!product.is_available) {
      return res.status(400).json({
        error: "Product is not available",
      });
    }

    let cartResult = await pool.query(
      `  
        SELECT id
        FROM carts
        WHERE user_id = $1
    `,
      [userId],
    );

    let cartId;

    // 3. Create cart if it doesn't exist
    if (cartResult.rows.length === 0) {
      const newCart = await pool.query(
        `  
          INSERT INTO carts (user_id)
          VALUES ($1)
          RETURNING id
      `,
        [userId],
      );

      cartId = newCart.rows[0].id;
    } else {
      cartId = cartResult.rows[0].id;
    }

    const existingItem = await pool.query(
      ` 
        SELECT id, quantity
        FROM cart_items
        WHERE cart_id = $1
          AND product_id = $2
    `,
      [cartId, productId],
    );

    if (existingItem.rows.length > 0) {
      const newQuantity = existingItem.rows[0].quantity + quantity;

      const updatedItem = await pool.query(
        `  
          UPDATE cart_items
          SET quantity = $1,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
          RETURNING id, product_id, quantity
      `,
        [newQuantity, existingItem.rows[0].id],
      );

      return res.json({
        message: "Cart updated",
        item: updatedItem.rows[0],
      });
    }

    // 5. Add new product to cart
    const newItem = await pool.query(
      `  
        INSERT INTO cart_items (
          cart_id,
          product_id,
          quantity
        )
        VALUES ($1, $2, $3)
        RETURNING id, product_id, quantity
    `,
      [cartId, productId, quantity],
    );

    res.status(201).json({
      message: "Product added to cart",
      item: newItem.rows[0],
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Database error",
    });
  }
});

router.delete("/cart/items/:id", authMiddleware, async (req, res) => {
  const itemId = req.params.id;
  const userId = req.user.userId;

  try {
    const result = await pool.query(
      `  
        DELETE FROM cart_items
        USING carts
        WHERE cart_items.id = $1
          AND cart_items.cart_id = carts.id
          AND carts.user_id = $2
        RETURNING cart_items.id, cart_items.product_id
    `,
      [itemId, userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Cart item not found",
      });
    }

    res.json({
      message: "Cart item removed",
      item: result.rows[0],
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Database error",
    });
  }
});

router.patch("/cart/items/:id", authMiddleware, async (req, res) => {
  const itemId = req.params.id;
  const { quantity } = req.body;
  const userId = req.user.userId;

  if (!Number.isInteger(quantity) || quantity <= 0) {
    return res.status(400).json({
      error: "Quantity must be a positive integer",
    });
  }

  try {
    const result = await pool.query(
      `  
        UPDATE cart_items
        SET quantity = $1,
            updated_at = CURRENT_TIMESTAMP
        FROM carts
        WHERE cart_items.id = $2
          AND cart_items.cart_id = carts.id
          AND carts.user_id = $3
        RETURNING cart_items.id,
                  cart_items.product_id,
                  cart_items.quantity
    `,
      [quantity, itemId, userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Cart item not found",
      });
    }

    res.json({
      message: "Cart item updated",
      item: result.rows[0],
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Database error",
    });
  }
});

module.exports = router;
