const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const authMiddleware = require("../middleware/authMiddleware");
const adminMiddleware = require("../middleware/adminMiddleware");
const pool = require("../database");
const router = express.Router();

// GET /api/users/me
router.get("/users/me", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `    SELECT
          id,
          name,
          email,
          phone,
          role,
          created_at
        FROM users
        WHERE id = $1
      `,
      [req.user.userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    return res.status(200).json({
      user: result.rows[0],
    });
  } catch (error) {
    console.error("GET OWN PROFILE ERROR:", error);

    return res.status(500).json({
      error: "Failed to retrieve profile",
    });
  }
});

// GET /api/users/staff
// Admin only: retrieve the staff directory
router.get(
  "/users/staff",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const result = await pool.query(
        `  SELECT
          id,
          name,
          email,
          phone,
          role,
          is_active,
          created_at,
          employment_start_date,
          avatar_url
        FROM users
        WHERE role = 'restaurant_staff'
        ORDER BY employment_start_date DESC NULLS LAST, id DESC
      `,
      );

      return res.status(200).json({
        staff: result.rows,
      });
    } catch (error) {
      console.error("GET STAFF DIRECTORY ERROR:", error);

      return res.status(500).json({
        error: "Failed to retrieve staff directory",
      });
    }
  },
);

// GET /api/users/staff/:id
// Admin only: retrieve one staff member
router.get(
  "/users/staff/:id",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    const staffId = Number(req.params.id);

    if (!Number.isSafeInteger(staffId) || staffId <= 0) {
      return res.status(400).json({
        error: "Invalid staff ID",
      });
    }

    try {
      const result = await pool.query(
        `   SELECT
            id,
            name,
            email,
            phone,
            role,
            is_active,
            created_at,
            employment_start_date,
            avatar_url
          FROM users
          WHERE id = $1
            AND role = 'restaurant_staff'
      `,
        [staffId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "Staff member not found",
        });
      }

      return res.status(200).json({
        staff: result.rows[0],
      });
    } catch (error) {
      console.error("GET STAFF PROFILE ERROR:", error);

      return res.status(500).json({
        error: "Failed to retrieve staff profile",
      });
    }
  },
);

router.patch(
  "/users/staff/:id/status",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    const staffId = Number(req.params.id);
    const { is_active } = req.body;

    if (!Number.isSafeInteger(staffId) || staffId <= 0) {
      return res.status(400).json({
        error: "Invalid staff ID",
      });
    }

    if (typeof is_active !== "boolean") {
      return res.status(400).json({
        error: "is_active must be true or false",
      });
    }

    try {
      const result = await pool.query(
        ` UPDATE users
          SET
            is_active = $1,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
            AND role = 'restaurant_staff'
          RETURNING
            id,
            name,
            email,
            phone,
            role,
            is_active,
            employment_start_date,
            avatar_url
        `,
        [is_active, staffId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "Staff member not found",
        });
      }

      return res.status(200).json({
        message: is_active
          ? "Staff account activated successfully"
          : "Staff account deactivated successfully",
        staff: result.rows[0],
      });
    } catch (error) {
      console.error("UPDATE STAFF STATUS ERROR:", error);

      return res.status(500).json({
        error: "Failed to update staff status",
      });
    }
  },
);

// PATCH /api/users/staff/:id
// Admin only: update staff information
router.patch(
  "/users/staff/:id",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    const staffId = Number(req.params.id);

    if (!Number.isSafeInteger(staffId) || staffId <= 0) {
      return res.status(400).json({
        error: "Invalid staff ID",
      });
    }

    const allowedFields = ["name", "email", "phone", "employment_start_date"];

    const updates = [];
    const values = [];

    for (const field of allowedFields) {
      if (!Object.prototype.hasOwnProperty.call(req.body, field)) {
        continue;
      }

      const value = req.body[field];

      if (field === "employment_start_date") {
        if (value === null || value === "") {
          updates.push("employment_start_date = NULL");
          continue;
        }

        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          return res.status(400).json({
            error: "Employment start date must use YYYY-MM-DD format",
          });
        }

        const date = new Date(`${value}T00:00:00.000Z`);

        if (
          Number.isNaN(date.getTime()) ||
          date.toISOString().slice(0, 10) !== value
        ) {
          return res.status(400).json({
            error: "Invalid employment start date",
          });
        }

        values.push(value);
        updates.push(`employment_start_date = $${values.length}`);
        continue;
      }

      if (typeof value !== "string" || !value.trim()) {
        return res.status(400).json({
          error: `${field} must be a non-empty string`,
        });
      }

      const cleanValue =
        field === "email" ? value.trim().toLowerCase() : value.trim();

      if (field === "name" && cleanValue.length > 100) {
        return res.status(400).json({
          error: "Name must not exceed 100 characters",
        });
      }

      if (field === "email") {
        if (
          cleanValue.length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanValue)
        ) {
          return res.status(400).json({
            error: "Please provide a valid email address",
          });
        }
      }

      if (field === "phone" && cleanValue.length > 30) {
        return res.status(400).json({
          error: "Phone number must not exceed 30 characters",
        });
      }

      values.push(cleanValue);
      updates.push(`${field} = $${values.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        error: "Provide at least one field to update",
      });
    }

    values.push(staffId);

    try {
      const result = await pool.query(
        `  UPDATE users
         SET ${updates.join(", ")},
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $${values.length}
           AND role = 'restaurant_staff'
         RETURNING
           id,
           name,
           email,
           phone,
           role,
           created_at,
           employment_start_date,
           avatar_url`,
        values,
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "Staff member not found",
        });
      }

      return res.status(200).json({
        message: "Staff profile updated successfully",
        staff: result.rows[0],
      });
    } catch (error) {
      console.error("UPDATE STAFF ERROR:", error);

      if (error.code === "23505") {
        return res.status(409).json({
          error: "Email or phone already exists",
        });
      }

      return res.status(500).json({
        error: "Failed to update staff profile",
      });
    }
  },
);

// GET /api/users/:id
router.get("/users/:id", authMiddleware, async (req, res) => {
  const userId = Number(req.params.id);

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({
      error: "Invalid user id",
    });
  }

  // Users can view their own profile.
  // Admins can view other users' profiles.
  if (req.user.userId !== userId && req.user.role !== "admin") {
    return res.status(403).json({
      error: "You are not allowed to view this profile",
    });
  }

  try {
    const result = await pool.query(
      `    SELECT
            id,
            name,
            email,
            phone,
            role,
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

    return res.status(200).json({
      user: result.rows[0],
    });
  } catch (error) {
    console.error("GET USER PROFILE ERROR:", error);

    return res.status(500).json({
      error: "Database error",
    });
  }
});

router.post("/users", async (req, res) => {
  const { name, email, phone, password } = req.body;

  if (!name || !phone || !password) {
    return res.status(400).json({
      error: "Name, email, phone and password are required",
    });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (email && !emailRegex.test(email)) {
    return res.status(400).json({
      error: "Invalid email format",
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      error: "password must be at least 6 charactars",
    });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);

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

    if (error.code === "23505") {
      return res.status(409).json({
        error: "Email already exists",
      });
    }

    res.status(500).json({
      error: "Database error",
    });
  }
});

router.patch(
  "/admin/staff/:id",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    const { id } = req.params;
    const { phone, email } = req.body;

    if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
      return res.status(400).json({
        error: "Invalid staff ID",
      });
    }

    if (typeof phone !== "string" || !phone.trim()) {
      return res.status(400).json({
        error: "Phone number is required",
      });
    }

    const normalizedEmail =
      typeof email === "string" && email.trim() ? email.trim() : null;

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (normalizedEmail && !emailRegex.test(normalizedEmail)) {
      return res.status(400).json({
        error: "Invalid email format",
      });
    }

    try {
      const result = await pool.query(
        `  UPDATE users
         SET phone = $1,
             email = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3
           AND role = $4
         RETURNING id, name, phone, email, role, is_active, updated_at`,
        [phone.trim(), normalizedEmail, Number(id), "restaurant_staff"],
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          error: "Staff member not found",
        });
      }

      return res.status(200).json({
        message: "Staff information updated successfully",
        staff: result.rows[0],
      });
    } catch (error) {
      console.error("UPDATE STAFF ERROR:", error);

      if (error.code === "23505") {
        return res.status(409).json({
          error: "Email or phone already exists",
        });
      }

      return res.status(500).json({
        error: "Database error",
      });
    }
  },
);

router.get(
  "/admin/staff",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const result = await pool.query(
        `  SELECT
          id,
          name,
          phone,
          email,
          role,
          employment_start_date,
          is_active,
          created_at,
          updated_at
        FROM users
        WHERE role = $1
        ORDER BY created_at DESC`,
        ["restaurant_staff"],
      );

      return res.status(200).json({
        staff: result.rows,
      });
    } catch (error) {
      console.error("GET ADMIN STAFF ERROR:", error);

      return res.status(500).json({
        error: "Database error",
      });
    }
  },
);

router.post(
  "/admin/staff",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    const { name, email, phone, password } = req.body;

    if (
      typeof name !== "string" ||
      !name.trim() ||
      typeof phone !== "string" ||
      !phone.trim() ||
      typeof password !== "string" ||
      !password
    ) {
      return res.status(400).json({
        error: "Name, phone and password are required",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters",
      });
    }

    const normalizedEmail =
      typeof email === "string" && email.trim() ? email.trim() : null;

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (normalizedEmail && !emailRegex.test(normalizedEmail)) {
      return res.status(400).json({
        error: "Invalid email format",
      });
    }

    try {
      const passwordHash = await bcrypt.hash(password, 10);

      const result = await pool.query(
        `  INSERT INTO users (
          name,
          email,
          phone,
          password_hash,
          role
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, name, email, phone, role, created_at`,
        [
          name.trim(),
          normalizedEmail,
          phone.trim(),
          passwordHash,
          "restaurant_staff",
        ],
      );

      return res.status(201).json({
        message: "Staff account created successfully",
        user: result.rows[0],
      });
    } catch (error) {
      console.error("CREATE STAFF ERROR:", error);

      if (error.code === "23505") {
        return res.status(409).json({
          error: "Email or phone already exists",
        });
      }

      return res.status(500).json({
        error: "Database error",
      });
    }
  },
);

router.patch(
  "/admin/staff/:id/status",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    const { id } = req.params;
    const { is_active } = req.body;

    if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
      return res.status(400).json({
        error: "Invalid staff ID",
      });
    }

    if (typeof is_active !== "boolean") {
      return res.status(400).json({
        error: "is_active must be a boolean",
      });
    }

    try {
      const result = await pool.query(
        `  UPDATE users
         SET is_active = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
           AND role = $3
         RETURNING id, name, phone, email, role, is_active, updated_at`,
        [is_active, Number(id), "restaurant_staff"],
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          error: "Staff member not found",
        });
      }

      return res.status(200).json({
        message: is_active
          ? "Staff account activated successfully"
          : "Staff account deactivated successfully",
        staff: result.rows[0],
      });
    } catch (error) {
      console.error("UPDATE STAFF STATUS ERROR:", error);

      return res.status(500).json({
        error: "Database error",
      });
    }
  },
);

router.post("/login", async (req, res) => {
  const { phone, password } = req.body;

  if (
    typeof phone !== "string" ||
    typeof password !== "string" ||
    !phone.trim() ||
    !password
  ) {
    return res.status(400).json({
      error: "phone and password are required",
    });
  }

  try {
    const result = await pool.query(
      `   SELECT
          id,
          name,
          email,
          phone,
          password_hash,
          role,
          is_active
        FROM users
        WHERE phone = $1
        LIMIT 1
      `,
      [phone.trim()],
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: "Invalid phone or password",
      });
    }

    const user = result.rows[0];

    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({
        error: "Invalid phone or password",
      });
    }

    // Do not allow inactive accounts to log in.
    if (!user.is_active) {
      return res.status(403).json({
        error: "Your account is inactive. Contact an administrator.",
      });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d",
      },
    );

    return res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error);

    return res.status(500).json({
      error: "Unable to log in right now",
    });
  }
});

// POST /api/users/staff
// Admin only: create a staff account
router.post(
  "/users/staff",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const { name, email, phone, password, employment_start_date } = req.body;

      // 1. Validate required fields
      if (
        typeof name !== "string" ||
        typeof email !== "string" ||
        typeof phone !== "string" ||
        typeof password !== "string" ||
        !name.trim() ||
        !email.trim() ||
        !phone.trim() ||
        !password
      ) {
        return res.status(400).json({
          error: "Name, email, phone, and password are required",
        });
      }

      const cleanName = name.trim();
      const cleanEmail = email.trim().toLowerCase();
      const cleanPhone = phone.trim();

      if (cleanName.length > 100) {
        return res.status(400).json({
          error: "Name must not exceed 100 characters",
        });
      }

      if (cleanEmail.length > 254 || cleanPhone.length > 30) {
        return res.status(400).json({
          error: "Email or phone number is too long",
        });
      }

      // 2. Validate email format
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      if (!emailPattern.test(cleanEmail)) {
        return res.status(400).json({
          error: "Please provide a valid email address",
        });
      }

      // 3. Validate password
      if (password.length < 8 || password.length > 72) {
        return res.status(400).json({
          error: "Password must be between 8 and 72 characters",
        });
      }

      // 4. Validate optional employment start date
      let employmentStartDate = null;

      if (
        employment_start_date !== undefined &&
        employment_start_date !== null &&
        employment_start_date !== ""
      ) {
        if (
          typeof employment_start_date !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(employment_start_date)
        ) {
          return res.status(400).json({
            error: "Employment start date must use YYYY-MM-DD format",
          });
        }

        const parsedDate = new Date(`${employment_start_date}T00:00:00.000Z`);

        if (
          Number.isNaN(parsedDate.getTime()) ||
          parsedDate.toISOString().slice(0, 10) !== employment_start_date
        ) {
          return res.status(400).json({
            error: "Employment start date is not a valid calendar date",
          });
        }

        employmentStartDate = employment_start_date;
      }

      // 5. Check for an existing email or phone number
      const existingUser = await pool.query(
        `  SELECT id
         FROM users
         WHERE LOWER(email) = $1 OR phone = $2
         LIMIT 1`,
        [cleanEmail, cleanPhone],
      );

      if (existingUser.rows.length > 0) {
        return res.status(409).json({
          error: "Email or phone already exists",
        });
      }

      // 6. Hash the password
      const passwordHash = await bcrypt.hash(password, 10);

      // 7. Create the staff account
      const result = await pool.query(
        `  INSERT INTO users (
           name,
           email,
           phone,
           password_hash,
           role,
           employment_start_date
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING
           id,
           name,
           email,
           phone,
           role,
           created_at,
           employment_start_date,
           avatar_url`,
        [
          cleanName,
          cleanEmail,
          cleanPhone,
          passwordHash,
          "restaurant_staff",
          employmentStartDate,
        ],
      );

      return res.status(201).json({
        message: "Staff account created successfully",
        user: result.rows[0],
      });
    } catch (error) {
      console.error("CREATE STAFF ERROR:", error);

      if (error.code === "23505") {
        return res.status(409).json({
          error: "Email or phone already exists",
        });
      }
      return res.status(500).json({
        error: "Failed to create staff account",
      });
    }
  },
);

module.exports = router;
