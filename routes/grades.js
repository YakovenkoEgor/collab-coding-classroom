const express = require("express");
const db = require("../db/database");
const { requireLogin, requireRole } = require("../middleware/auth");
const { toCsv } = require("../csv");
const rules = require("../assignmentRules");
const progsnap = require("../progsnap");

const router = express.Router();

// Teacher-only: the whole gradebook as CSV - one row per student, one column
// per assignment, scores where they meet.
router.get("/export.csv", requireLogin, requireRole("teacher"), (req, res) => {
  const students = db
    .prepare(
      // Surname first, the way the class register reads.
      `SELECT id,
              TRIM(COALESCE(last_name, '') || ' ' || COALESCE(first_name, '')) AS fullName,
              display_name AS displayName, group_name AS groupName
       FROM users WHERE role = 'student'
       ORDER BY group_name IS NULL, group_name, last_name, first_name`
    )
    .all();

  // Surveys are never scored, so they have no column here - only tests that
  // are actually marked, and every other kind of assignment.
  const assignments = db
    .prepare(
      `SELECT id, title FROM assignments
       WHERE type <> 'test' OR test_kind = 'graded'
       ORDER BY created_at`
    )
    .all();

  const grades = db.prepare("SELECT assignment_id, student_id, score FROM grades").all();
  const scoreByPair = new Map(
    grades.map((g) => [`${g.student_id}:${g.assignment_id}`, g.score])
  );

  // The column header is just the assignment's title: the per-group maxima
  // used to be spelled out here, which made the header unreadable in a
  // spreadsheet. The group is a column of its own, and the maxima live in the
  // assignment itself.
  const rows = [["Студент", "Группа", ...assignments.map((a) => a.title)]];
  for (const student of students) {
    rows.push([
      student.fullName || student.displayName,
      student.groupName || "",
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

// Scores are whole numbers from 0 up to the assignment's own maximum
// (or null to clear the grade).
const MIN_SCORE = 0;

function normalizeScore(raw, maxScore) {
  if (raw === undefined || raw === null || raw === "") return { value: null };
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value) || value < MIN_SCORE || value > maxScore) {
    return {
      error: `Балл должен быть целым числом от ${MIN_SCORE} до ${maxScore}`,
    };
  }
  return { value };
}

router.get("/assignment/:assignmentId", requireLogin, (req, res) => {
  const studentId =
    req.session.user.role === "student"
      ? req.session.user.id
      : parseInt(req.query.studentId, 10);
  if (!studentId) return res.status(400).json({ error: "Не указан ученик" });

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
    if (!studentId) return res.status(400).json({ error: "Не указан ученик" });

    const assignment = db
      .prepare("SELECT id FROM assignments WHERE id = ?")
      .get(req.params.assignmentId);
    if (!assignment) return res.status(404).json({ error: "Задание не найдено" });

    // The top mark comes from the student's study group and nowhere else.
    // Without one there is nothing to mark against: either the assignment was
    // not given to that group, or it was given a deadline but no score.
    const maxScore = rules.maxScoreFor(req.params.assignmentId, studentId);
    if (maxScore === null || maxScore === undefined) {
      return res.status(409).json({
        error:
          "Для учебной группы этого ученика максимальный балл за задание не задан — выставить оценку нельзя",
      });
    }

    const normalized = normalizeScore(score, maxScore);
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

    // Process data: the mark, normalised to 0..1 the way ProgSnap2 wants it,
    // against the maximum that applied to this student's group. The initiator
    // is the teacher, not the student whose work it is.
    progsnap.logEvent({
      eventType: progsnap.EventType.X_GRADE,
      subjectId: studentId,
      sessionId: req.sessionID,
      assignmentId: req.params.assignmentId,
      eventInitiator: "InstructorDirectAction",
      score: progsnap.normalizeScore(normalized.value, maxScore),
      extra: { "X-RawScore": normalized.value, "X-MaxScore": maxScore },
    });

    res.json({ grade });
  }
);

module.exports = router;
