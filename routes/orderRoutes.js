const express = require("express");

const pool = require("../database");
const authMiddleware = require("../middleware/authMiddleware");
const adminMiddleware = require("../middleware/adminMiddleware");

const router = express.Router();

// GET /api/orders
// Get orders of the logged-in user
router.get("/orders", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `  
      SELECT
        orders.id,
        users.name AS customer_name,
        orders.total_price,
        orders.delivery_address,
        orders.order_type,
        orders.status
      FROM orders
      JOIN users
        ON orders.user_id = users.id
      WHERE orders.user_id = $1
      ORDER BY orders.id DESC
    `,
      [req.user.userId],
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Database error",
    });
  }
});

// POST /api/orders
router.post("/orders", authMiddleware, async (req, res) => {
  const {
    delivery_address,
    postal_code,
    recipient_name,
    recipient_phone,
    order_type,
    items,
  } = req.body;

  const deliveryFee = order_type === "in_person" ? 0 : 50000;

  if (!Number.isInteger(req.user.userId) || req.user.userId <= 0) {
    return res.status(400).json({
      error: "Invalid user_id",
    });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({
      error: "Order must contain at least one item",
    });
  }

  if (!["online", "in_person"].includes(order_type)) {
    return res.status(400).json({
      error: "Invalid order_type",
    });
  }

  if (
    deliveryFee !== undefined &&
    (!Number.isFinite(Number(deliveryFee)) || Number(deliveryFee) < 0)
  ) {
    return res.status(400).json({
      error: "Invalid delivery_fee",
    });
  }

  for (const item of items) {
    if (!Number.isInteger(item.product_id) || item.product_id <= 0) {
      return res.status(400).json({
        error: "Invalid product_id",
      });
    }

    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      return res.status(400).json({
        error: "Invalid quantity",
      });
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let total_price = Number(deliveryFee) || 0;

    const preparedItems = [];

    for (const item of items) {
      const productResult = await client.query(
        `    SELECT
          price,
          is_available
        FROM products
        WHERE id = $1
    `,
        [item.product_id],
      );

      if (productResult.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error: `Product ${item.product_id} not found`,
        });
      }

      if (!productResult.rows[0].is_available) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          error: `Product ${item.product_id} is not available`,
        });
      }

      const unit_price = Number(productResult.rows[0].price);

      total_price += unit_price * item.quantity;

      preparedItems.push({
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price: unit_price,
      });
    }

    const orderResult = await client.query(
      `
      INSERT INTO orders (
        user_id,
        total_price,
        delivery_address,
        postal_code,
        recipient_name,
        recipient_phone,
        delivery_fee,
        order_type
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `,
      [
        req.user.userId,
        total_price,
        delivery_address,
        postal_code,
        recipient_name,
        recipient_phone,
        deliveryFee,
        order_type,
      ],
    );

    const orderId = orderResult.rows[0].id;

    const createdItems = [];
    for (const item of preparedItems) {
      const itemResult = await client.query(
        `  
        INSERT INTO order_items (
          order_id,
          product_id,
          quantity,
          unit_price
        )
        VALUES ($1, $2, $3, $4)
        RETURNING *
    `,
        [orderId, item.product_id, item.quantity, item.unit_price],
      );

      createdItems.push(itemResult.rows[0]);
    }

    await client.query(
      `  
      INSERT INTO order_status_history (
        order_id,
        status
      )
      VALUES ($1, $2)
    `,
      [orderId, "pending"],
    );

    await client.query("COMMIT");

    res.status(201).json({
      order: orderResult.rows[0],
      items: createdItems,
    });
  } catch (error) {
    console.error(error);

    await client.query("ROLLBACK");

    res.status(500).json({
      error: "Database error",
    });
  } finally {
    client.release();
  }
});

// GET /api/orders/:id
router.get("/orders/:id", authMiddleware, async (req, res) => {
  const orderId = Number(req.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({
      error: "Invalid order id",
    });
  }

  try {
    const orderResult = await pool.query(
      ` 
      SELECT *
      FROM orders
      WHERE id = $1
    `,
      [orderId],
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({
        error: "Order not found",
      });
    }

    const order = orderResult.rows[0];

    if (order.user_id !== req.user.userId) {
      return res.status(403).json({
        error: "You do not have access to this order",
      });
    }

    const itemsResult = await pool.query(
      ` 
      SELECT
        oi.id,
        oi.product_id,
        p.name AS product_name,
        oi.quantity,
        oi.unit_price,
        (oi.quantity * oi.unit_price) AS subtotal
      FROM order_items oi
      JOIN products p
        ON p.id = oi.product_id
      WHERE oi.order_id = $1
      ORDER BY oi.id
    `,
      [orderId],
    );

    const paymentResult = await pool.query(
      `  
      SELECT
        id,
        amount,
        payment_method,
        status,
        paid_at,
        created_at
      FROM payments
      WHERE order_id = $1
    `,
      [orderId],
    );

    res.status(200).json({
      order,
      items: itemsResult.rows,
      payment: paymentResult.rows[0] || null,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Database error",
    });
  }
});

// GET /api/orders/:id/history
router.get("/orders/:id/history", authMiddleware, async (req, res) => {
  const orderId = Number(req.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({
      error: "Invalid order id",
    });
  }

  try {
    const orderResult = await pool.query(
      `  
        SELECT
          id,
          user_id
        FROM orders
        WHERE id = $1
       `,
      [orderId],
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({
        error: "Order not found",
      });
    }

    if (orderResult.rows[0].user_id !== req.user.userId) {
      return res.status(403).json({
        error: "You do not have access to this order history",
      });
    }

    const historyResult = await pool.query(
      ` 
        SELECT
          id,
          order_id,
          status,
          changed_at
        FROM order_status_history
        WHERE order_id = $1
        ORDER BY changed_at ASC
        `,
      [orderId],
    );

    res.status(200).json({
      order_id: orderId,
      history: historyResult.rows,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Database error",
    });
  }
});
// PATCH /api/orders/:id/status
router.patch(
  "/orders/:id/status",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    const orderId = Number(req.params.id);
    const { status } = req.body;

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({
        error: "Invalid order id",
      });
    }

    if (
      ![
        "pending",
        "confirmed",
        "preparing",
        "ready",
        "delivered",
        "cancelled",
      ].includes(status)
    ) {
      return res.status(400).json({
        error: "Invalid order status",
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const orderResult = await client.query(
        `  
        SELECT *
        FROM orders
        WHERE id = $1
       `,
        [orderId],
      );

      if (orderResult.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error: "Order not found",
        });
      }

      const order = orderResult.rows[0];

      const allowedTransitions = {
        pending: ["confirmed", "cancelled"],
        confirmed: ["preparing", "cancelled"],
        preparing: ["ready"],
        ready: ["delivered"],
        delivered: [],
        cancelled: [],
      };

      if (!allowedTransitions[order.status].includes(status)) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          error: `Cannot change status from ${order.status} to ${status}`,
        });
      }

      const updatedOrderResult = await client.query(
        `  
        UPDATE orders
        SET status = $1
        WHERE id = $2
        RETURNING *
       `,
        [status, orderId],
      );

      await client.query(
        `  
        INSERT INTO order_status_history (
          order_id,
          status
        )
        VALUES ($1, $2)
       `,
        [orderId, status],
      );

      await client.query("COMMIT");

      res.status(200).json({
        order: updatedOrderResult.rows[0],
        message: "Order status updated successfully",
      });
    } catch (error) {
      console.error(error);

      await client.query("ROLLBACK");

      res.status(500).json({
        error: "Database error",
      });
    } finally {
      client.release();
    }
  },
);

module.exports = router;
