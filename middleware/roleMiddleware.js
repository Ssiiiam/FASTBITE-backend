function roleMiddleware(...allowedRoles) {
  return (req, res, next) => {
    console.log("ROLE MIDDLEWARE REACKED");
    console.log("USER:", req.user);
    console.log("ALLOWED ROLES:", allowedRoles);
    if (!req.user) {
      return res.status(401).json({
        error: "Authentication required",
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      console.log("ROLE DENIED:", req.user.role);
      return res.status(403).json({
        error: "Access denied",
      });
    }
    console.log("ROLE ALLOWED");
    next();
  };
}

module.exports = roleMiddleware;
