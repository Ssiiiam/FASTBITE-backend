🍔 FASTBITE — Backend

Building FASTBITE, one feature at a time!

FASTBITE is a restaurant ordering application designed to manage online orders, payments, products, tables, and staff operations.

This repository contains the backend API built with Node.js and Express, using PostgreSQL for data storage.

✨ Features

- User Authentication: Secure user authentication with JWT.
- Role-Based Access: Different permissions for administrators, staff, and customers.
- Product Management: Manage restaurant products and availability.
- Shopping Cart: Handle customer cart operations.
- Order Management: Create and manage restaurant orders.
- Payment Integration: Payment processing with Zarinpal test/sandbox configuration.
- Table Management: Manage restaurant tables and QR codes.
- Staff Management: Support staff-related operations.
- Image Uploads: Store and serve product images.

🛠️ Tech Stack

- Node.js
- Express.js
- PostgreSQL
- JSON Web Tokens (JWT)
- bcrypt
- REST API

📁 Project Structure

backend/
├── middleware/
│ ├── adminMiddleware.js
│ ├── authMiddleware.js
│ ├── roleMiddleware.js
│ └── staffMiddleware.js
├── routes/
│ ├── cartsRoutes.js
│ ├── orderRoutes.js
│ ├── paymentRoutes.js
│ ├── productRoutes.js
│ ├── tableRoutes.js
│ └── userRoutes.js
├── uploads/
│ └── products/
├── database.js
├── server.js
├── package.json
├── .env.example
└── .gitignore

🚀 Getting Started

1. Clone the repository

git clone https://github.com/Ssiiiam/FASTBITE-backend.git
cd FASTBITE-backend

2. Install dependencies

npm install

3. Configure environment variables

Create a ".env" file based on ".env.example".

Configure your database connection and other required environment variables according to the backend configuration.

Never commit your actual ".env" file or expose private credentials.

4. Set up PostgreSQL

Make sure PostgreSQL is installed and running.

Create the required database and configure the connection settings in your environment.

5. Start the server

npm run dev

The server runs on the configured port (default: "3000").

🔐 Environment Configuration

The ".env.example" file provides example settings for:

- Server port
- Environment mode
- Frontend URL
- Payment test mode
- Zarinpal sandbox configuration

Sensitive values should be configured locally and kept private.

🧪 Development Status

FASTBITE is an ongoing project. Its backend features are being developed and tested alongside the frontend application.

This repository currently contains the backend only.

👩‍💻 Author

Marzia Ahmadi

Computer Science Student | Aspiring Software Developer

GitHub: "@Ssiiiam" (https://github.com/Ssiiiam)

---

Built with curiosity, practice, and a lot of learning. 🌱
