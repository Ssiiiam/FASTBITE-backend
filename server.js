const paymentRoutes = require("./routes/paymentRoutes");
const orderRoutes = require("./routes/orderRoutes");
const productRoutes = require("./routes/productRoutes");
const userRoutes = require("./routes/userRoutes");
const authMiddleware = require("./middleware/authMiddleware");
const adminMiddleware = require("./middleware/adminMiddleware");
require("dotenv").config();
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("./database");

const app = express();
app.use(express.json());

app.use("/api", paymentRoutes);
app.use("/api", orderRoutes);
app.use("/api", productRoutes);
app.use("/api", userRoutes);

app.get("/", (req, res) => {
  res.send("Resturant Backend is running!");
});

app.get("/api/me", authMiddleware, async (req, res) => {
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

app.get("/api/protected", authMiddleware, (req, res) => {
  res.status(200).json({
    message: "You are authenticated!",
    user: req.user,
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
  });
});

app.use((error, req, res, next) => {
  console.error(error);

  res.status(500).json({
    error: "Internal server error",
  });
});

app.listen(3000, () => {
  console.log("server is running on port 3000");
});
