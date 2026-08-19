const express = require("express");
const db = require("../db/database");
const { requireLogin, requireRole } = require("../middleware/auth");
const { runJavaProject, SandboxError } = require("../sandbox");

const router = express.Router();

const MAX_FILES_PER_PROJECT = 20;

// Normalises what the client sent into a file list plus an entry file.
// Older single-file callers ({ code }) are still accepted.
function readProject(body) {
  if (Array.isArray(body.files) && body.files.length > 0) {
    if (body.files.length > MAX_FILES_PER_PROJECT) {
      throw new SandboxError(
        `A project can hold at most ${MAX_FILES_PER_PROJECT} files`
      );
    }
    const files = body.files.map((f) => ({
      filename: String(f.filename || "").trim(),
      content: typeof f.content === "string" ? f.content : "",
    }));
    const entry =
      body.entry && files.some((f) => f.filename === body.entry)
        ? body.entry
        : files[0].filename;
    return { files, entry };
  }

  if (typeof body.code === "string" && body.code.length > 0) {
    return { files: [{ filename: "Main.java", content: body.code }], entry: "Main.java" };
  }

  throw new SandboxError("No code to run");
}

function filesForSubmission(submissionId) {
  return db
    .prepare(
      `SELECT filename, content, is_entry AS isEntry
       FROM submission_files WHERE submission_id = ? ORDER BY is_entry DESC, filename`
    )
    .all(submissionId);
}

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

// Files of one version. A student may only read their own.
router.get("/:submissionId/files", requireLogin, (req, res) => {
  const submission = db
    .prepare("SELECT * FROM submissions WHERE id = ?")
    .get(req.params.submissionId);
  if (!submission) return res.status(404).json({ error: "Submission not found" });

  if (
    req.session.user.role !== "teacher" &&
    submission.student_id !== req.session.user.id
  ) {
    return res.status(403).json({ error: "Not your submission" });
  }

  res.json({ files: filesForSubmission(submission.id) });
});

// Compile & run the project without saving a version (scratch run).
// The entry file is the one the student has open, like running the current
// file in an IDE.
router.post(
  "/run",
  requireLogin,
  requireRole("student"),
  async (req, res) => {
    let project;
    try {
      project = readProject(req.body);
    } catch (err) {
      if (err instanceof SandboxError) return res.status(400).json({ error: err.message });
      throw err;
    }

    try {
      const result = await runJavaProject(project.files, project.entry, req.body.stdin || "");
      res.json(result);
    } catch (err) {
      if (err instanceof SandboxError) return res.status(400).json({ error: err.message });
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
    const { status, baseVersionId } = req.body;
    const assignmentId = req.params.assignmentId;
    const studentId = req.session.user.id;

    let project;
    try {
      project = readProject(req.body);
    } catch (err) {
      if (err instanceof SandboxError) return res.status(400).json({ error: err.message });
      throw err;
    }

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
      runResult = await runJavaProject(project.files, project.entry, "");
    } catch (err) {
      if (err instanceof SandboxError) return res.status(400).json({ error: err.message });
      console.error(err);
    }

    const entryFile = project.files.find((f) => f.filename === project.entry);

    const save = db.transaction(() => {
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
          // Kept in sync with the entry file so single-file views still work.
          entryFile.content,
          status === "submitted" ? "submitted" : "draft",
          runResult.stdout,
          runResult.stderr || runResult.compileOutput || "",
          runResult.status
        );

      const insertFile = db.prepare(
        `INSERT INTO submission_files (submission_id, filename, content, is_entry)
         VALUES (?, ?, ?, ?)`
      );
      for (const file of project.files) {
        insertFile.run(
          info.lastInsertRowid,
          file.filename,
          file.content,
          file.filename === project.entry ? 1 : 0
        );
      }
      return info.lastInsertRowid;
    });

    const submissionId = save();
    const submission = db
      .prepare("SELECT * FROM submissions WHERE id = ?")
      .get(submissionId);
    res.json({ submission, files: filesForSubmission(submissionId) });
  }
);

module.exports = router;
