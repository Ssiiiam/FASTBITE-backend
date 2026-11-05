const express = require("express");
const staffMiddleware = require("../middleware/staffMiddleware");
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
        orders.delivery_fee,
        orders.created_at,
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
    table_id,
  } = req.body;

  console.log("======== CREATE ORDER ========");
  console.log("BODY:", req.body);
  console.log("order_type:", order_type);
  console.log("typeof:", typeof order_type);
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

  // In-person orders must have a table.
  if (order_type === "in_person") {
    if (!Number.isInteger(table_id) || table_id <= 0) {
      return res.status(400).json({
        error: "table_id is required for in-person orders",
      });
    }
  }

  // Online delivery orders must not have a table.
  if (order_type === "online" && table_id !== undefined) {
    return res.status(400).json({
      error: "table_id is not allowed for online orders",
    });
  }

  // Validate order items.
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

  // Backend decides the delivery fee.
  const deliveryFee = order_type === "in_person" ? 0 : 50000;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Check table existence for in-person orders.
    if (order_type === "in_person" ? table_id : null) {
      const tableResult = await client.query(
      `
        SELECT id
        FROM restaurant_tables
        WHERE id = $1
      `,
        [table_id],
      );

      if (tableResult.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error: "Table not found",
        });
      }
    }

    // Start total with delivery fee.
    let total_price = deliveryFee;

    const preparedItems = [];

    // Get product prices from database.
    for (const item of items) {
      const productResult = await client.query(
      `
        SELECT
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

      const product = productResult.rows[0];

      if (!product.is_available) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          error: `Product ${item.product_id} is not available`,
        });
      }

      const unit_price = Number(product.price);

      total_price += unit_price * item.quantity;

      preparedItems.push({
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price,
      });
    }

    // Create order.
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
        order_type,
        table_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `,
      [
        req.user.userId,
        total_price,
        delivery_address ?? null,
        postal_code ?? null,
        recipient_name ?? null,
        recipient_phone ?? null,
        deliveryFee,
        order_type,
        order_type === "in_person" ? table_id : null,
      ],
    );

    const orderId = orderResult.rows[0].id;

    // Create order items.
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

    // Create initial order status history.
    await client.query(
      `
      INSERT INTO order_status_history (
        order_id,
        status,
        changed_by
      )
      VALUES ($1, $2, $3)
    `,
      [orderId, "pending", req.user.userId],
    );

    await client.query("COMMIT");

    res.status(201).json({
      order: orderResult.rows[0],
      items: createdItems,
    });
  } catch (error) {
    console.error("Create ORDER ERROR:", error);

    await client.query("ROLLBACK");

    res.status(500).json({
      error: "Database error",
      details: error.message,
    });
  } finally {
    client.release();
  }
});

// GET /api/admin/orders
router.get(
  "/admin/orders",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const result = await pool.query(
        `  SELECT
          o.id,
          u.name AS customer_name,
          o.total_price,
          o.delivery_address,
          o.order_type,
          o.status,
          o.delivery_fee,
          o.created_at
        FROM orders AS o
        JOIN users AS u
          ON o.user_id = u.id
        ORDER BY o.created_at DESC
      `,
      );

      return res.status(200).json(result.rows);
    } catch (error) {
      console.error("GET ADMIN ORDERS ERROR:", error);

      return res.status(500).json({
        error: "Database error",
      });
    }
  },
);

router.get(
  "/staff/orders",
  authMiddleware,
  staffMiddleware,
  async (req, res) => {
    try {
      const result = await pool.query(
        `  SELECT
          o.id,
          o.user_id,
          u.name AS customer_name,
          o.total_price,
          o.delivery_address,
          o.order_type,
          o.status,
          o.created_at
        FROM orders o
        JOIN users u ON u.id = o.user_id
        ORDER BY o.created_at DESC
      `,
      );

      res.status(200).json({
        orders: result.rows,
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Failed to fetch staff orders",
      });
    }
  },
);

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
      `    SELECT id, user_id
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

    const isAdmin = req.user.role === "admin";
    const isOwner = Number(order.user_id) === Number(req.user.userId);

    if (!isAdmin && !isOwner) {
      return res.status(403).json({
        error: "You do not have access to this order history",
      });
    }

    const historyResult = await pool.query(
      `    SELECT
            h.id,
            h.order_id,
            h.status,
            h.changed_at,
            h.changed_by,
            u.name AS employee_name
          FROM order_status_history AS h
          LEFT JOIN users AS u
            ON u.id = h.changed_by
          WHERE h.order_id = $1
          ORDER BY h.changed_at ASC, h.id ASC
        `,
      [orderId],
    );

    return res.status(200).json({
      order_id: orderId,
      history: historyResult.rows,
    });
  } catch (error) {
    console.error("GET ORDER HISTORY ERROR:", error);

    return res.status(500).json({
      error: "Database error",
    });
  }
});

router.patch(
  "/orders/:id/status",
  authMiddleware,
  staffMiddleware,
  async (req, res) => {
    const orderId = Number(req.params.id);
    const { status } = req.body;

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({
        error: "Invalid order id",
      });
    }

    const allowedTransitions = {
      pending: ["confirmed"],
      confirmed: ["preparing"],
      preparing: ["ready"],
      ready: ["delivered"],
    };

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const orderResult = await client.query(
        `  SELECT id, status
         FROM orders
         WHERE id = $1
         FOR UPDATE`,
        [orderId],
      );

      if (orderResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: "Order not found",
        });
      }

      const currentStatus = orderResult.rows[0].status;
      const nextStatuses = allowedTransitions[currentStatus] || [];

      if (!nextStatuses.includes(status)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Invalid status transition",
          current_status: currentStatus,
          requested_status: status,
          allowed_next_statuses: nextStatuses,
        });
      }

      const updateResult = await client.query(
        `  UPDATE orders
         SET status = $1
         WHERE id = $2
         RETURNING *`,
        [status, orderId],
      );

      await client.query(
        `  INSERT INTO order_status_history
          (order_id, status, changed_by)
         VALUES ($1, $2, $3)`,
        [orderId, status, req.user.userId],
      );

      await client.query("COMMIT");

      return res.status(200).json({
        message: "Order status updated successfully",
        order: updateResult.rows[0],
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("UPDATE ORDER STATUS ERROR:", error);

      return res.status(500).json({
        error: "Failed to update order status",
      });
    } finally {
      client.release();
    }
  },
);

module.exports = router;
