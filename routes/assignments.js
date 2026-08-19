const express = require("express");
const db = require("../db/database");
const { requireLogin, requireRole } = require("../middleware/auth");
const storage = require("../storage");
const { isValidJavaFilename, SandboxError } = require("../sandbox");

const router = express.Router();

const MAX_STARTER_FILES = 20;
const DEFAULT_STARTER =
  "public class Main {\n    public static void main(String[] args) {\n        \n    }\n}\n";

function starterFilesFor(assignmentId) {
  return db
    .prepare(
      `SELECT filename, content, is_entry AS isEntry
       FROM assignment_starter_files WHERE assignment_id = ?
       ORDER BY is_entry DESC, filename`
    )
    .all(assignmentId);
}

// Normalises the starter project from the request. Accepts the multi-file
// shape, and still understands the old single-textarea `starterCode`.
function readStarterProject(body) {
  if (Array.isArray(body.starterFiles) && body.starterFiles.length > 0) {
    if (body.starterFiles.length > MAX_STARTER_FILES) {
      throw new SandboxError(
        `A starter project can hold at most ${MAX_STARTER_FILES} files`
      );
    }
    const files = body.starterFiles.map((f) => ({
      filename: String(f.filename || "").trim(),
      content: typeof f.content === "string" ? f.content : "",
    }));

    const seen = new Set();
    for (const file of files) {
      if (!isValidJavaFilename(file.filename)) {
        throw new SandboxError(
          `"${file.filename}" is not a valid Java file name (expected something like Main.java)`
        );
      }
      if (seen.has(file.filename)) {
        throw new SandboxError(`Duplicate file name: ${file.filename}`);
      }
      seen.add(file.filename);
    }

    const entry =
      body.starterEntry && files.some((f) => f.filename === body.starterEntry)
        ? body.starterEntry
        : files[0].filename;
    return { files, entry };
  }

  const code =
    typeof body.starterCode === "string" && body.starterCode.trim().length > 0
      ? body.starterCode
      : DEFAULT_STARTER;
  return { files: [{ filename: "Main.java", content: code }], entry: "Main.java" };
}

function filesForAssignment(assignmentId) {
  return db
    .prepare(
      `SELECT id, original_name AS originalName, size_bytes AS size, created_at AS createdAt
       FROM assignment_files WHERE assignment_id = ? ORDER BY id`
    )
    .all(assignmentId);
}

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

// Teacher-only: which submitted work is still waiting to be graded.
// A pair (assignment, student) counts as pending when the student has
// submitted something and either there is no grade yet, or they submitted a
// newer version after the grade was given.
// Registered before "/:id" so "review" isn't read as an assignment id.
router.get("/review/pending", requireLogin, requireRole("teacher"), (req, res) => {
  const rows = db
    .prepare(
      `WITH latest_submitted AS (
         SELECT assignment_id, student_id, MAX(created_at) AS last_submitted
         FROM submissions
         WHERE status = 'submitted'
         GROUP BY assignment_id, student_id
       )
       SELECT l.assignment_id AS assignmentId, l.student_id AS studentId
       FROM latest_submitted l
       LEFT JOIN grades g
         ON g.assignment_id = l.assignment_id AND g.student_id = l.student_id
       WHERE g.score IS NULL OR g.updated_at < l.last_submitted`
    )
    .all();

  const byAssignment = {};
  const byStudent = {};
  for (const r of rows) {
    byAssignment[r.assignmentId] = (byAssignment[r.assignmentId] || 0) + 1;
    byStudent[r.studentId] = (byStudent[r.studentId] || 0) + 1;
  }
  res.json({ byAssignment, byStudent, total: rows.length });
});

router.get("/:id", requireLogin, (req, res) => {
  const assignment = db
    .prepare("SELECT * FROM assignments WHERE id = ?")
    .get(req.params.id);
  if (!assignment) return res.status(404).json({ error: "Not found" });
  res.json({
    assignment,
    files: filesForAssignment(assignment.id),
    starterFiles: starterFilesFor(assignment.id),
  });
});

// The starter project a student's editor opens with.
router.get("/:id/starter", requireLogin, (req, res) => {
  const files = starterFilesFor(req.params.id);
  const entry = (files.find((f) => f.isEntry) || files[0] || {}).filename || null;
  res.json({ files, entry });
});

// Handouts attached to an assignment - both roles need to read these.
router.get("/:id/files", requireLogin, (req, res) => {
  res.json({ files: filesForAssignment(req.params.id) });
});

// Download a handout. The file is served from its generated stored name;
// the original name is only used for the download prompt.
router.get("/:id/files/:fileId/download", requireLogin, (req, res) => {
  const file = db
    .prepare(
      "SELECT * FROM assignment_files WHERE id = ? AND assignment_id = ?"
    )
    .get(req.params.fileId, req.params.id);
  if (!file) return res.status(404).json({ error: "File not found" });

  const fullPath = storage.pathForStoredName(file.stored_name);
  if (!fullPath) return res.status(404).json({ error: "File not found" });

  res.download(fullPath, file.original_name, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: "File is missing from disk" });
    }
  });
});

// Teacher-only: create an assignment, optionally with handout files.
// files: [{ name, data }] where data is base64 (a data: URL is also accepted).
router.post("/", requireLogin, requireRole("teacher"), (req, res) => {
  const { title, description, files } = req.body;
  if (!title) return res.status(400).json({ error: "Title required" });

  let starter;
  try {
    starter = readStarterProject(req.body);
  } catch (err) {
    if (err instanceof SandboxError) return res.status(400).json({ error: err.message });
    throw err;
  }

  let storedFiles = [];
  try {
    storedFiles = storage.storeFiles(files);
  } catch (err) {
    if (err instanceof storage.UploadError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  try {
    const entryFile = starter.files.find((f) => f.filename === starter.entry);

    const create = db.transaction(() => {
      const info = db
        .prepare(
          "INSERT INTO assignments (title, description, starter_code, created_by) VALUES (?, ?, ?, ?)"
        )
        // starter_code mirrors the entry file for the older single-file paths.
        .run(title, description || "", entryFile.content, req.session.user.id);

      const insertStarter = db.prepare(
        `INSERT INTO assignment_starter_files (assignment_id, filename, content, is_entry)
         VALUES (?, ?, ?, ?)`
      );
      for (const f of starter.files) {
        insertStarter.run(
          info.lastInsertRowid,
          f.filename,
          f.content,
          f.filename === starter.entry ? 1 : 0
        );
      }

      const insertFile = db.prepare(
        `INSERT INTO assignment_files
           (assignment_id, original_name, stored_name, size_bytes, uploaded_by)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const f of storedFiles) {
        insertFile.run(
          info.lastInsertRowid,
          f.originalName,
          f.storedName,
          f.size,
          req.session.user.id
        );
      }
      return info.lastInsertRowid;
    });

    const assignmentId = create();
    const assignment = db
      .prepare("SELECT * FROM assignments WHERE id = ?")
      .get(assignmentId);
    res.json({
      assignment,
      files: filesForAssignment(assignmentId),
      starterFiles: starterFilesFor(assignmentId),
    });
  } catch (err) {
    // Don't leave orphaned files on disk if the database write fails.
    storedFiles.forEach((f) => storage.removeFile(f.storedName));
    throw err;
  }
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
