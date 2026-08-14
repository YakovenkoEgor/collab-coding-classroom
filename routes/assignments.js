const express = require("express");
const db = require("../db/database");
const { requireLogin, requireRole } = require("../middleware/auth");

const router = express.Router();

// List assignments (both roles see the same list; archived hidden by default)
router.get("/", requireLogin, (req, res) => {
  const includeArchived = req.query.all === "1";
  const rows = includeArchived
    ? db.prepare("SELECT * FROM assignments ORDER BY created_at DESC").all()
    : db
        .prepare(
          "SELECT * FROM assignments WHERE archived = 0 ORDER BY created_at DESC"
        )
        .all();
  res.json({ assignments: rows });
});

router.get("/:id", requireLogin, (req, res) => {
  const assignment = db
    .prepare("SELECT * FROM assignments WHERE id = ?")
    .get(req.params.id);
  if (!assignment) return res.status(404).json({ error: "Not found" });
  res.json({ assignment });
});

// Teacher-only: create an assignment
router.post("/", requireLogin, requireRole("teacher"), (req, res) => {
  const { title, description, starterCode } = req.body;
  if (!title) return res.status(400).json({ error: "Title required" });

  const info = db
    .prepare(
      "INSERT INTO assignments (title, description, starter_code, created_by) VALUES (?, ?, ?, ?)"
    )
    .run(title, description || "", starterCode || "", req.session.user.id);

  const assignment = db
    .prepare("SELECT * FROM assignments WHERE id = ?")
    .get(info.lastInsertRowid);
  res.json({ assignment });
});

// Teacher-only: archive/unarchive
router.patch("/:id", requireLogin, requireRole("teacher"), (req, res) => {
  const { archived } = req.body;
  db.prepare("UPDATE assignments SET archived = ? WHERE id = ?").run(
    archived ? 1 : 0,
    req.params.id
  );
  res.json({ ok: true });
});

// Teacher-only: see every student's latest submission status for an assignment
router.get(
  "/:id/overview",
  requireLogin,
  requireRole("teacher"),
  (req, res) => {
    const rows = db
      .prepare(
        `
      SELECT u.id AS studentId, u.display_name AS displayName,
             s.version_number AS latestVersion, s.status, s.created_at AS lastActivity,
             g.score, g.feedback
      FROM users u
      LEFT JOIN (
        SELECT * FROM submissions
        WHERE assignment_id = ?
        AND id IN (
          SELECT MAX(id) FROM submissions WHERE assignment_id = ? GROUP BY student_id
        )
      ) s ON s.student_id = u.id
      LEFT JOIN grades g ON g.assignment_id = ? AND g.student_id = u.id
      WHERE u.role = 'student'
      ORDER BY u.display_name
    `
      )
      .all(req.params.id, req.params.id, req.params.id);
    res.json({ students: rows });
  }
);

module.exports = router;
