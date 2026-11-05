function staffMiddleware(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: "Authentication required",
    });
  }

  const allowedRoles = ["admin", "restaurant_staff"];

  if (!allowedRoles.includes(req.user.role)) {
    return res.status(403).json({
      error: "Staff access required",
    });
  }

  next();
}

module.exports = staffMiddleware;
