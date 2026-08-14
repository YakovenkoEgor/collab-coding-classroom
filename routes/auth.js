const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db/database");
const { requireLogin, requireRole } = require("../middleware/auth");

const router = express.Router();

router.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  const user = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
  };

  res.json({ user: req.session.user });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get("/me", (req, res) => {
  res.json({ user: req.session.user || null });
});

// Teacher-only: create a new student (or teacher) account.
router.post("/users", requireLogin, requireRole("teacher"), (req, res) => {
  const { username, password, displayName, role } = req.body;
  if (!username || !password || !displayName) {
    return res.status(400).json({ error: "Missing fields" });
  }
  const finalRole = role === "teacher" ? "teacher" : "student";
  const hash = bcrypt.hashSync(password, 10);

  try {
    const info = db
      .prepare(
        "INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)"
      )
      .run(username, hash, displayName, finalRole);
    res.json({ id: info.lastInsertRowid, username, displayName, role: finalRole });
  } catch (err) {
    if (err.message.includes("UNIQUE")) {
      return res.status(409).json({ error: "Username already exists" });
    }
    throw err;
  }
});

// Teacher-only: list all students (used for the review dashboard).
router.get("/users", requireLogin, requireRole("teacher"), (req, res) => {
  const users = db
    .prepare(
      "SELECT id, username, display_name AS displayName, role FROM users WHERE role = 'student' ORDER BY display_name"
    )
    .all();
  res.json({ users });
});

module.exports = router;
