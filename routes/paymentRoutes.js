const express = require("express");
const roleMiddleware = require("../middleware/roleMiddleware");
const pool = require("../database");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

const ZARINPAL_SANDBOX = process.env.ZARINPAL_SANDBOX === "true";
const ZARINPAL_BASE_URL = ZARINPAL_SANDBOX
  ? "https://sandbox.zarinpal.com/pg/v4/payment"
  : "https://api.zarinpal.com/pg/v4/payment";

function tomanToRial(amountToman) {
  if (!Number.isSafeInteger(amountToman) || amountToman <= 0) {
    throw new Error("Invalid payment amount");
  }
  return amountToman * 10;
}

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

    const orderResult = await client.query(
    `
      SELECT
        id,
        user_id,
        total_price,
        order_type,
        status
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

    // Online delivery orders cannot use cash.
    if (order.order_type === "online" && payment_method === "cash") {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Online delivery orders must be paid online",
      });
    }

    // Do not allow another payment for an already-paid order.
    const existingPaymentResult = await client.query(
    `
      SELECT id, status
      FROM payments
      WHERE order_id = $1
      ORDER BY id DESC
      LIMIT 1
    `,
      [order.id],
    );

    if (existingPaymentResult.rows.length > 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Payment already exists for this order",
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
    console.error("CREATE PAYMENT ERROR:", error);

    await client.query("ROLLBACK");

    res.status(500).json({
      error: "Database error",
      details: error.message,
    });
  } finally {
    client.release();
  }
});

router.post("/payments/:id/start", authMiddleware, async (req, res) => {
  const paymentId = Number(req.params.id);

  if (!Number.isInteger(paymentId) || paymentId <= 0) {
    return res.status(400).json({
      error: "Invalid payment id",
    });
  }

  const merchantId = process.env.ZARINPAL_MERCHANT_ID;

  if (!merchantId) {
    return res.status(500).json({
      error: "Zarinpal merchant ID is not configured",
    });
  }

  try {
    // Load payment and verify ownership.
    const result = await pool.query(
    `
        SELECT
          p.id,
          p.order_id,
          p.amount,
          p.payment_method,
          p.status,
          p.gateway,
          p.gateway_reference,
          o.user_id
        FROM payments p
        JOIN orders o ON o.id = p.order_id
        WHERE p.id = $1
      `,
      [paymentId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Payment not found",
      });
    }

    const payment = result.rows[0];

    if (payment.user_id !== req.user.userId) {
      return res.status(403).json({
        error: "You do not have access to this payment",
      });
    }

    if (payment.payment_method !== "online") {
      return res.status(400).json({
        error: "Only online payments can use Zarinpal",
      });
    }

    if (payment.status !== "pending") {
      return res.status(400).json({
        error: "Payment is not pending",
      });
    }

    // Do not create another gateway request for an existing authority.
    if (payment.gateway_reference) {
      return res.status(409).json({
        error: "A gateway request already exists for this payment",
      });
    }

    const amount = tomanToRial(Number(payment.amount));

    const callbackUrl = `${process.env.BACKEND_URL}/api/payments/callback`;

    const gatewayResponse = await fetch(`${ZARINPAL_BASE_URL}/request.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        merchant_id: merchantId,
        amount,
        callback_url: callbackUrl,
        description: `Restaurant order #${payment.order_id}`,
      }),
    });

    const data = await gatewayResponse.json();

    if (
      !gatewayResponse.ok ||
      data.data?.code !== 100 ||
      !data.data?.authority
    ) {
      console.error("ZARINPAL REQUEST FAILED:", data);

      return res.status(502).json({
        error: "Could not create Zarinpal payment",
        gateway_code: data.errors?.code ?? data.data?.code ?? null,
      });
    }

    const authority = data.data.authority;
    const updateResult = await pool.query(
    `
        UPDATE payments
        SET
          gateway = 'zarinpal',
          gateway_reference = $1
        WHERE id = $2
          AND status = 'pending'
          AND gateway_reference IS NULL
        RETURNING id
      `,
      [authority, paymentId],
    );

    if (updateResult.rowCount === 0) {
      return res.status(409).json({
        error: "Payment changed while starting gateway request",
      });
    }

    const paymentBaseUrl = ZARINPAL_SANDBOX
      ? "https://sandbox.zarinpal.com/pg/StartPay/"
      : "https://www.zarinpal.com/pg/StartPay/";

    return res.status(200).json({
      payment_id: paymentId,
      payment_url: `${paymentBaseUrl}${authority}`,
    });
  } catch (error) {
    console.error("START ZARINPAL PAYMENT ERROR:", error);

    return res.status(502).json({
      error: "Could not connect to Zarinpal",
    });
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

router.patch(
  "/payments/:id/confirm-cash",
  authMiddleware,
  roleMiddleware("restaurant_staff", "admin"),
  async (req, res) => {
    const paymentId = Number(req.params.id);

    if (!Number.isInteger(paymentId) || paymentId <= 0) {
      return res.status(400).json({
        error: "Invalid payment id",
      });
    }

    const client = await pool.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      const paymentResult = await client.query(
        `  SELECT
           p.id,
           p.order_id,
           p.amount,
           p.payment_method,
           p.status AS payment_status,
           o.order_type,
           o.status AS order_status
         FROM payments p
         JOIN orders o ON o.id = p.order_id
         WHERE p.id = $1
         FOR UPDATE OF p, o`,
        [paymentId],
      );

      if (paymentResult.rows.length === 0) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(404).json({
          error: "Payment not found",
        });
      }

      const payment = paymentResult.rows[0];

      if (payment.payment_method !== "cash") {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(400).json({
          error: "Only cash payments can be confirmed manually",
        });
      }

      if (payment.order_type !== "in_person") {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(400).json({
          error: "Cash confirmation is only allowed for in-person orders",
        });
      }

      if (payment.payment_status !== "pending") {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(400).json({
          error: "Payment is not pending",
        });
      }

      if (payment.order_status !== "pending") {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(400).json({
          error: "Only pending orders can be confirmed",
        });
      }

      const updatedPaymentResult = await client.query(
        `  UPDATE payments
         SET status = 'successful',
             paid_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [paymentId],
      );

      const updatedOrderResult = await client.query(
        `  UPDATE orders
         SET status = 'confirmed'
         WHERE id = $1
           AND status = 'pending'
         RETURNING *`,
        [payment.order_id],
      );

      if (updatedOrderResult.rows.length === 0) {
        throw new Error("Order status changed unexpectedly");
      }

      await client.query(
        `  INSERT INTO order_status_history (order_id, status)
         VALUES ($1, 'confirmed')`,
        [payment.order_id],
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(200).json({
        payment: updatedPaymentResult.rows[0],
        order: updatedOrderResult.rows[0],
        message: "Cash payment confirmed successfully",
      });
    } catch (error) {
      console.error("CONFIRM CASH PAYMENT ERROR:", error);

      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error("ROLLBACK ERROR:", rollbackError);
        }
      }

      return res.status(500).json({
        error: "Failed to confirm cash payment",
      });
    } finally {
      client.release();
    }
  },
);

router.post("/payments/:id/test", authMiddleware, async (req, res) => {
  // Only allow simulated payments in development test mode.
  if (
    process.env.PAYMENT_TEST_MODE !== "true"
  ) {
    return res.status(403).json({
      error: "Test payments are disabled",
    });
  }

  const paymentId = Number(req.params.id);

  if (!Number.isInteger(paymentId) || paymentId <= 0) {
    return res.status(400).json({
      error: "Invalid payment id",
    });
  }

  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const paymentResult = await client.query(
      `
        SELECT
          p.id,
          p.order_id,
          p.amount,
          p.payment_method,
          p.status,
          o.user_id
        FROM payments p
        JOIN orders o ON o.id = p.order_id
        WHERE p.id = $1
        FOR UPDATE OF p, o
      `,
      [paymentId],
    );

    if (paymentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(404).json({
        error: "Payment not found",
      });
    }

    const payment = paymentResult.rows[0];

    if (String(payment.user_id) !== String(req.user.userId)) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(403).json({
        error: "You cannot access this payment",
      });
    }

    if (payment.payment_method !== "online") {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(400).json({
        error: "Only online payments can use this test route",
      });
    }

    if (payment.status !== "pending") {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(400).json({
        error: "Payment is not pending",
      });
    }

    const updatedPayment = await client.query(
      `
        UPDATE payments
        SET
          status = 'successful',
          paid_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *
      `,
      [paymentId],
    );

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
          status,
          changed_by
        )
        VALUES ($1, 'confirmed', $2)
      `,
      [payment.order_id, req.user.userId],
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(200).json({
      payment: updatedPayment.rows[0],
      message: "Test payment simulated successfully",
      test_mode: true,
    });
  } catch (error) {
    console.error("TEST PAYMENT ERROR:", error);

    if (transactionStarted) {
      await client.query("ROLLBACK");
    }

    return res.status(500).json({
      error: "Could not simulate test payment",
    });
  } finally {
    client.release();
  }
});

module.exports = router;
