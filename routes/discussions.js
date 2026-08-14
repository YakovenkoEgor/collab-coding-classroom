const express = require("express");
const db = require("../db/database");
const { requireLogin } = require("../middleware/auth");

const router = express.Router();

function resolveStudentId(req) {
  if (req.session.user.role === "student") return req.session.user.id;
  const studentId = parseInt(req.query.studentId, 10);
  return Number.isNaN(studentId) ? null : studentId;
}

function getOrCreateDiscussion(assignmentId, studentId) {
  let discussion = db
    .prepare(
      "SELECT * FROM discussions WHERE assignment_id = ? AND student_id = ?"
    )
    .get(assignmentId, studentId);

  if (!discussion) {
    const info = db
      .prepare(
        "INSERT INTO discussions (assignment_id, student_id) VALUES (?, ?)"
      )
      .run(assignmentId, studentId);
    discussion = db
      .prepare("SELECT * FROM discussions WHERE id = ?")
      .get(info.lastInsertRowid);
  }
  return discussion;
}

// Get (or lazily create) the thread + all messages for an
// assignment/student pair.
router.get("/assignment/:assignmentId", requireLogin, (req, res) => {
  const studentId = resolveStudentId(req);
  if (!studentId) return res.status(400).json({ error: "studentId required" });

  const discussion = getOrCreateDiscussion(req.params.assignmentId, studentId);

  const messages = db
    .prepare(
      `SELECT m.*, u.display_name AS authorName, u.role AS authorRole,
              s.version_number AS linkedVersion
       FROM messages m
       JOIN users u ON u.id = m.author_id
       LEFT JOIN submissions s ON s.id = m.submission_id
       WHERE m.discussion_id = ?
       ORDER BY m.created_at ASC`
    )
    .all(discussion.id);

  res.json({ discussion, messages });
});

// Post a message. Optionally include submissionId to link a code version.
router.post("/assignment/:assignmentId/messages", requireLogin, (req, res) => {
  const studentId = resolveStudentId(req);
  if (!studentId) return res.status(400).json({ error: "studentId required" });

  const { body, submissionId } = req.body;
  if (!body || !body.trim()) {
    return res.status(400).json({ error: "Message body required" });
  }

  const discussion = getOrCreateDiscussion(req.params.assignmentId, studentId);

  const info = db
    .prepare(
      `INSERT INTO messages (discussion_id, author_id, body, submission_id)
       VALUES (?, ?, ?, ?)`
    )
    .run(discussion.id, req.session.user.id, body.trim(), submissionId || null);

  const message = db
    .prepare(
      `SELECT m.*, u.display_name AS authorName, u.role AS authorRole,
              s.version_number AS linkedVersion
       FROM messages m
       JOIN users u ON u.id = m.author_id
       LEFT JOIN submissions s ON s.id = m.submission_id
       WHERE m.id = ?`
    )
    .get(info.lastInsertRowid);

  res.json({ message });
});

module.exports = router;
