const express = require("express");
const db = require("../db/database");
const { requireLogin, requireRole } = require("../middleware/auth");
const { toCsv } = require("../csv");

const router = express.Router();

// Teacher-only: the whole gradebook as CSV - one row per student, one column
// per assignment, scores where they meet.
router.get("/export.csv", requireLogin, requireRole("teacher"), (req, res) => {
  const students = db
    .prepare(
      `SELECT id, display_name AS displayName, group_name AS groupName
       FROM users WHERE role = 'student'
       ORDER BY group_name IS NULL, group_name, last_name, first_name`
    )
    .all();

  const assignments = db
    .prepare("SELECT id, title FROM assignments ORDER BY created_at")
    .all();

  const grades = db.prepare("SELECT assignment_id, student_id, score FROM grades").all();
  const scoreByPair = new Map(
    grades.map((g) => [`${g.student_id}:${g.assignment_id}`, g.score])
  );

  const rows = [["Студент", ...assignments.map((a) => a.title)]];
  for (const student of students) {
    rows.push([
      student.displayName,
      ...assignments.map((a) => {
        const score = scoreByPair.get(`${student.id}:${a.id}`);
        return score === undefined || score === null ? "" : score;
      }),
    ]);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="grades-${stamp}.csv"`
  );
  res.send(toCsv(rows));
});

// Scores are whole numbers from 0 to 15 (or null to clear the grade).
const MIN_SCORE = 0;
const MAX_SCORE = 15;

function normalizeScore(raw) {
  if (raw === undefined || raw === null || raw === "") return { value: null };
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value) || value < MIN_SCORE || value > MAX_SCORE) {
    return {
      error: `Score must be a whole number between ${MIN_SCORE} and ${MAX_SCORE}`,
    };
  }
  return { value };
}

router.get("/assignment/:assignmentId", requireLogin, (req, res) => {
  const studentId =
    req.session.user.role === "student"
      ? req.session.user.id
      : parseInt(req.query.studentId, 10);
  if (!studentId) return res.status(400).json({ error: "studentId required" });

  const grade = db
    .prepare(
      "SELECT * FROM grades WHERE assignment_id = ? AND student_id = ?"
    )
    .get(req.params.assignmentId, studentId);
  res.json({ grade: grade || null });
});

router.put(
  "/assignment/:assignmentId",
  requireLogin,
  requireRole("teacher"),
  (req, res) => {
    const { studentId, score, feedback } = req.body;
    if (!studentId) return res.status(400).json({ error: "studentId required" });

    const normalized = normalizeScore(score);
    if (normalized.error) return res.status(400).json({ error: normalized.error });

    db.prepare(
      `INSERT INTO grades (assignment_id, student_id, score, feedback, graded_by, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(assignment_id, student_id)
       DO UPDATE SET score = excluded.score, feedback = excluded.feedback,
                     graded_by = excluded.graded_by, updated_at = datetime('now')`
    ).run(
      req.params.assignmentId,
      studentId,
      normalized.value,
      feedback || "",
      req.session.user.id
    );

    const grade = db
      .prepare(
        "SELECT * FROM grades WHERE assignment_id = ? AND student_id = ?"
      )
      .get(req.params.assignmentId, studentId);
    res.json({ grade });
  }
);

module.exports = router;
