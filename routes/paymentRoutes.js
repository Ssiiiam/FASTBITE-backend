const express = require("express");

const pool = require("../database");
const authMiddleware = require("../middleware/authMiddleware");
const adminMiddleware = require("../middleware/adminMiddleware");

const router = express.Router();

// POST /api/payments
router.post("/payments", authMiddleware, async (req, res) => {
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

    console.log("order_id");
    console.log("type", typeof order_id);
    const orderResult = await client.query( 
      "SELECT id, user_id, total_price FROM orders WHERE id = $1",
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

// GET /api/orders/:id/payment
router.get("/orders/:id/payment", authMiddleware, async (req, res) => {
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
      `  ,
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

// PATCH /api/payments/:id/status
router.patch(
  "/payments/:id/status",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
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
       ` ,
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
  },
);

module.exports = router;
