const express = require("express");
const db = require("../db/database");
const { requireLogin, requireRole } = require("../middleware/auth");
const { runJavaCode } = require("../sandbox");

const router = express.Router();

// Resolve which student's submissions we're looking at: a student can only
// see their own; a teacher must pass ?studentId=
function resolveStudentId(req) {
  if (req.session.user.role === "student") return req.session.user.id;
  const studentId = parseInt(req.query.studentId, 10);
  return Number.isNaN(studentId) ? null : studentId;
}

// Get full version history for an assignment (student sees own; teacher
// passes ?studentId=)
router.get("/assignment/:assignmentId", requireLogin, (req, res) => {
  const studentId = resolveStudentId(req);
  if (!studentId) return res.status(400).json({ error: "studentId required" });

  const rows = db
    .prepare(
      `SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?
       ORDER BY version_number DESC`
    )
    .all(req.params.assignmentId, studentId);
  res.json({ submissions: rows });
});

// Compile & run code without saving a version (scratch run)
router.post(
  "/run",
  requireLogin,
  requireRole("student"),
  async (req, res) => {
    const { code, stdin } = req.body;
    if (!code) return res.status(400).json({ error: "code required" });

    try {
      const result = await runJavaCode(code, stdin || "");
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(502).json({ error: "Failed to run code in sandbox" });
    }
  }
);

// Save a new version (draft or submitted), running it first to capture output
router.post(
  "/assignment/:assignmentId",
  requireLogin,
  requireRole("student"),
  async (req, res) => {
    // status: 'draft' | 'submitted'
    // baseVersionId: id of the version currently open in the student's editor,
    // or null when starting from scratch. New versions may only be based on the
    // latest one - older versions are read-only history.
    const { code, status, baseVersionId } = req.body;
    const assignmentId = req.params.assignmentId;
    const studentId = req.session.user.id;

    if (!code) return res.status(400).json({ error: "code required" });

    const last = db
      .prepare(
        `SELECT id, version_number FROM submissions
         WHERE assignment_id = ? AND student_id = ?
         ORDER BY version_number DESC LIMIT 1`
      )
      .get(assignmentId, studentId);

    const latestId = last ? last.id : null;
    const base =
      baseVersionId === undefined || baseVersionId === null
        ? null
        : parseInt(baseVersionId, 10);

    if (base !== latestId) {
      return res.status(409).json({
        error:
          "You can only edit and submit your latest version. Reload the page to continue from the newest one.",
        latestVersionId: latestId,
      });
    }

    const nextVersion = (last ? last.version_number : 0) + 1;

    let runResult = { stdout: "", stderr: "", status: "Not run" };
    try {
      runResult = await runJavaCode(code, "");
    } catch (err) {
      console.error(err);
    }

    const info = db
      .prepare(
        `INSERT INTO submissions
         (assignment_id, student_id, version_number, code, status,
          last_run_stdout, last_run_stderr, last_run_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        assignmentId,
        studentId,
        nextVersion,
        code,
        status === "submitted" ? "submitted" : "draft",
        runResult.stdout,
        runResult.stderr || runResult.compileOutput || "",
        runResult.status
      );

    const submission = db
      .prepare("SELECT * FROM submissions WHERE id = ?")
      .get(info.lastInsertRowid);
    res.json({ submission });
  }
);

module.exports = router;
