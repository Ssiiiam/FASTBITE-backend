const jwt = require("jsonwebtoken");
const pool = require("../database");

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Authentication required",
    });
  }

  const token = authHeader.slice(7).trim();

  if (!token) {
    return res.status(401).json({
      error: "Invalid or expired token",
    });
  }

  let decoded;

  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({
      error: "Invalid or expired token",
    });
  }

  if (!Number.isSafeInteger(decoded.userId) || decoded.userId <= 0) {
    return res.status(401).json({
      error: "Invalid token payload",
    });
  }

  try {
    const result = await pool.query(
      `  SELECT id, email, role, is_active
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [decoded.userId],
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: "User account not found",
      });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({
        error: "Your account is inactive",
      });
    }

    // Use the current database role, not the role stored in an old token.
    req.user = {
      userId: user.id,
      email: user.email,
      role: user.role,
    };

    return next();
  } catch (error) {
    console.error("AUTH MIDDLEWARE ERROR:", error);

    return res.status(500).json({
      error: "Authentication service unavailable",
    });
  }
}

module.exports = authMiddleware;
