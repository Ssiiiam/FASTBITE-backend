const express = require("express");
const QRCode = require("qrcode");

const pool = require("../database");

const router = express.Router();

// GET /api/tables/qr/:token
router.get("/tables/qr/:token", async (req, res) => {
  const { token } = req.params;

  try {
    const result = await pool.query(
      `  
      SELECT
        id,
        table_number,
        capacity,
        status
      FROM restaurant_tables
      WHERE qr_token = $1
    `,
      [token],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Table not found",
      });
    }

    const table = result.rows[0];

    res.status(200).json({
      table: {
        id: table.id,
        table_number: table.table_number,
        capacity: table.capacity,
        status: table.status,
      },
    });
  } catch (error) {
    console.error("QR TABLE ERROR:", error);

    res.status(500).json({
      error: "Database error",
      details: error.message,
    });
  }
});

// GET /api/tables/:id/qr
router.get("/tables/:id/qr", async (req, res) => {
  const tableId = Number(req.params.id);

  if (!Number.isInteger(tableId) || tableId <= 0) {
    return res.status(400).json({
      error: "Invalid table id",
    });
  }

  try {
    const result = await pool.query(
      `  
      SELECT
        id,
        table_number,
        qr_token
      FROM restaurant_tables
      WHERE id = $1
    `,
      [tableId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Table not found",
      });
    }

    const table = result.rows[0];

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    const menuUrl = `${frontendUrl}/menu?
    table = ${table.qr_token}`;

    const qrImage = await QRCode.toDataURL(menuUrl);

    res.status(200).json({
      table: {
        id: table.id,
        table_number: table.table_number,
      },
      url: menuUrl,
      qr_code: qrImage,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to generate QR code",
    });
  }
});

const authMiddleware = require("../middleware/authMiddleware");
const adminMiddleware = require("../middleware/adminMiddleware");

// GET /api/tables
router.get("/tables", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `  SELECT
          id,
          table_number,
          capacity,
          status
        FROM restaurant_tables
        ORDER BY table_number
       `,
    );

    res.status(200).json({
      tables: result.rows,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Database error",
    });
  }
});

module.exports = router;
