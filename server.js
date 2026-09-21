const authMiddleware = require("./authMiddleware");
require("dotenv").config();
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("./database");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Resturant Backend is running!");
});

app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(`
        SELECT
          products.id,
          products.name,
          products.price,
          products.is_available,
          categories.name AS category_name
          FROM products
          JOIN categories
            ON products.category_id = categories.id
      `);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Database error" });
  }
});

app.get("/api/products/:id", async (req, res) => {
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
    res.status(500).json({ error: "Database error" });
  }
});

app.listen(3000, () => {
  console.log("server is running on port 3000");
});

app.post("/api/orders", authMiddleware, async (req, res) => {
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
      error: "Indvalid user_id",
    });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return (
      res.status(400),
      json({
        error: "Order must contain at least one item",
      })
    );
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
        "SELECT price FROM products WHERE id = $1",
        [item.product_id],
      );

      if (productResult.rows.length === 0) {
        return res.status(404).json({
          error: `Product ${item.product_id} not found`,
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
      [orderResult.rows[0].id, "pending"],
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

app.get("/api/orders", async (req, res) => {
  try {
    const result = await pool.query(`
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
      ORDER BY orders.id DESC
      `);
    res.json(result.rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Database error",
    });
  }
});

app.post("/api/payments", authMiddleware, async (req, res) => {
  const { order_id, payment_method } = req.body;

  if (!Number.isInteger(order_id) || order_id <= 0) {
    return res.status(400).json({
      error: "Invalid order_id",
    });
  }
  if (!["online", "cash"].includes(payment_method)) {
    return res.status(400).json({
      error: "Invalid payment method",
    });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const orderResult = await client.query(
      `
      SELECT id, user_id, total_price
      FROM orders
      WHERE id = $1
      `,
      [order_id],
    );

    if (orderResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: "Order not found",
      });
    }

    const order = orderResult.rows[0];
    if (order.user_id !== req.user.userId) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        error: "You do not have access to this order",
      });
    }

    const paymentResult = await client.query(
      `
      INSERT INTO payments (
        order_id,
        amount,
        payment_method,
        status
      )
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `,
      [order.id, order.total_price, payment_method, "pending"],
    );

    await client.query("COMMIT");

    res.status(201).json({
      payment: paymentResult.rows[0],
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

app.get("/api/orders/:id/payment", authMiddleware, async (req, res) => {
  const orderId = Number(req.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({
      error: "Invalid order id",
    });
  }

  try {
    const result = await pool.query(
      `
        SELECT 
          p.id,
          p.order_id,
          p.amount,
          p.payment_method,
          p.status,
          p.paid_at,
          p.created_at
        FROM payments p
        JOIN orders o
          ON o.id = p.order_id
        WHERE p.order_id = $1
          AND o.user_id = $2
      `,
      [orderId, req.user.userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Payment not found",
      });
    }

    res.status(200).json({
      payment: result.rows[0],
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Database error",
    });
  }
});

app.patch("/api/payments/:id/status", async (req, res) => {
  const paymentId = Number(req.params.id);
  const { status } = req.body;

  if (!Number.isInteger(paymentId) || paymentId <= 0) {
    return res.status(400).json({
      error: "Invalid payment id",
    });
  }

  if (!["pending", "successful", "failed"].includes(status)) {
    return res.status(400).json({
      error: "Invalid payment status",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentPaymentResult = await client.query(
      `
      SELECT *
      FROM payments
      WHERE id = $1
      `,
      [paymentId],
    );

    if (currentPaymentResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "Payment not found",
      });
    }

    const currentPayment = currentPaymentResult.rows[0];

    if (currentPayment.status !== "pending") {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Payment status cannot be changed",
      });
    }

    const paymentResult = await client.query(
      `
        UPDATE payments
        SET
          status = $1,
          paid_at = CASE
            WHEN $1 = 'successful' THEN CURRENT_TIMESTAMP
            ELSE paid_at
          END
        WHERE id = $2
        RETURNING *
      `,
      [status, paymentId],
    );

    if (paymentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        erro: "payment not found",
      });
    }

    const payment = paymentResult.rows[0];

    if (status === "successful") {
      await client.query(
        `
        UPDATE orders
        SET status = 'confirmed'
        WHERE id = $1
        `,
        [payment.order_id],
      );
      await client.query(
        `
          INSERT INTO order_status_history (
            order_id,
            status
          )
          VALUES ($1, $2)
        `,
        [payment.order_id, "confirmed"],
      );
    }

    await client.query("COMMIT");

    res.status(200).json({
      payment,
      message:
        status === "successful"
          ? "payment successful and order updated"
          : "payment status updated",
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

app.get("/api/orders/:id", authMiddleware, async (req, res) => {
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
          (oi.quantity * oi.unit_price)
          AS subtotal
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

app.get("/api/orders/:id/history", authMiddleware, async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({
      error: "Invalid order id",
    });
  }

  try {
    const orderResult = await pool.query(
      `
          SELECT id, user_id
          FROM orders
          WHERE id = $1
        `,
      [orderId],
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({
        error: "order not found",
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

app.patch("/api/orders/:id/status", async (req, res) => {
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
        error: "order not found",
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
        RETURNING*
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
      message: "Order status updated successfuly",
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

app.patch("/api/orders/:id/status", async (req, res) => {
  const orderId = Number(req.params.id);
  const { status } = req.body;

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({
      error: "Invalid order id",
    });
  }
  const allowedStatuses = [
    "pending",
    "confirmed",
    "preparing",
    "ready",
    "delivered",
    "cancelled",
  ];

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      error: "Invalid order status",
    });
  }
});

app.get("/api/users/:id", async (req, res) => {
  const userId = Number(req.params.id);

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({
      error: "Invalid user id",
    });
  }
  try {
    const result = await pool.query(
      `
        SELECT 
          id,
          name,
          email,
          phone,
          created_at
        FROM users
        WHERE id = $1
      `,
      [userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "User not found",
      });
    }
    res.status(200).json({
      user: result.rows[0],
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Database error",
    });
  }
});

app.post("/api/users", async (req, res) => {
  const { name, email, phone, password } = req.body;

  if (!name || !email || !phone || !password) {
    return res.status(400).json({
      error: "Name, email, phone and password are required",
    });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  try {
    const result = await pool.query(
      `
        INSERT INTO users (
          name,
          email,
          phone,
          password_hash
        )
        VALUES ($1, $2, $3, $4)
        RETURNING id, name, email, phone, created_at
      `,
      [name, email, phone, passwordHash],
    );
    res.status(201).json({
      user: result.rows[0],
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Database error",
    });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({
      error: "Email and password are required",
    });
  }
  try {
    const result = await pool.query(
      `
        SELECT *
        FROM users
        WHERE email = $1
      `,
      [email],
    );
    if (result.rows.length === 0) {
      return res.status(401).json({
        error: "Invalid email or password",
      });
    }
    const user = result.rows[0];
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({
        error: "Invalid email or password",
      });
    }
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d",
      },
    );
    res.status(200).json({
      message: "Login successfuly",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
      },
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Database error",
    });
  }
});
/*
app.get("/api/protected", authMiddleware, (req, res)=> {
  res.status(200).json({
    message: "You are authenticated",
    user: req.user,
  });
});
*/
app.get("/api/me", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          id,
          name,
          email,
          phone,
          created_at,
        FROM users
        WHERE id= $1
      `,
      [req.user.userId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "User not found",
      });
    }
    res.status(200).json({
      user: result.rows[0],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Database error",
    });
  }
});
