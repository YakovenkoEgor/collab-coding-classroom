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
// Students are described by first name, last name and study group;
// display_name is stored as the rendered "First Last".
router.post("/users", requireLogin, requireRole("teacher"), (req, res) => {
  const { username, password, firstName, lastName, groupName, role } = req.body;

  const login = (username || "").trim();
  const first = (firstName || "").trim();
  const last = (lastName || "").trim();
  const group = (groupName || "").trim();

  if (!login || !password || !first || !last) {
    return res.status(400).json({
      error: "Username, password, first name and last name are required",
    });
  }

  const finalRole = role === "teacher" ? "teacher" : "student";
  const displayName = `${first} ${last}`;
  const hash = bcrypt.hashSync(password, 10);

  try {
    const info = db
      .prepare(
        `INSERT INTO users
           (username, password_hash, display_name, role, first_name, last_name, group_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(login, hash, displayName, finalRole, first, last, group || null);
    res.json({
      user: {
        id: info.lastInsertRowid,
        username: login,
        displayName,
        firstName: first,
        lastName: last,
        groupName: group || null,
        role: finalRole,
      },
    });
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
      `SELECT id, username, display_name AS displayName, role,
              first_name AS firstName, last_name AS lastName,
              group_name AS groupName
       FROM users WHERE role = 'student'
       ORDER BY group_name IS NULL, group_name, last_name, first_name`
    )
    .all();
  res.json({ users });
});

// Teacher-only: one student's profile plus their standing in every
// assignment - status, last activity and grade.
router.get("/users/:id", requireLogin, requireRole("teacher"), (req, res) => {
  const student = db
    .prepare(
      `SELECT id, username, display_name AS displayName, role,
              first_name AS firstName, last_name AS lastName,
              group_name AS groupName, created_at AS createdAt
       FROM users WHERE id = ? AND role = 'student'`
    )
    .get(req.params.id);
  if (!student) return res.status(404).json({ error: "Student not found" });

  const assignments = db
    .prepare(
      `SELECT a.id AS assignmentId, a.title, a.archived,
              s.version_number AS latestVersion, s.status,
              s.created_at AS lastActivity,
              g.score, g.feedback
       FROM assignments a
       LEFT JOIN submissions s
         ON s.assignment_id = a.id
        AND s.id = (
              SELECT MAX(id) FROM submissions
              WHERE assignment_id = a.id AND student_id = ?
            )
       LEFT JOIN grades g ON g.assignment_id = a.id AND g.student_id = ?
       ORDER BY a.created_at DESC`
    )
    .all(req.params.id, req.params.id);

  res.json({ student, assignments });
});

module.exports = router;
