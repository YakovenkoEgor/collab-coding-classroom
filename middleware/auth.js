function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Вы не авторизованы" });
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) {
      return res.status(403).json({ error: `Нужны права: ${role === "teacher" ? "преподаватель" : "ученик"}` });
    }
    next();
  };
}

module.exports = { requireLogin, requireRole };
