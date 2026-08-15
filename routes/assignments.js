const express = require("express");
const db = require("../db/database");
const { requireLogin, requireRole } = require("../middleware/auth");
const storage = require("../storage");

const router = express.Router();

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

router.get("/:id", requireLogin, (req, res) => {
  const assignment = db
    .prepare("SELECT * FROM assignments WHERE id = ?")
    .get(req.params.id);
  if (!assignment) return res.status(404).json({ error: "Not found" });
  res.json({ assignment, files: filesForAssignment(assignment.id) });
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
  const { title, description, starterCode, files } = req.body;
  if (!title) return res.status(400).json({ error: "Title required" });

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
    const info = db
      .prepare(
        "INSERT INTO assignments (title, description, starter_code, created_by) VALUES (?, ?, ?, ?)"
      )
      .run(title, description || "", starterCode || "", req.session.user.id);

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

    const assignment = db
      .prepare("SELECT * FROM assignments WHERE id = ?")
      .get(info.lastInsertRowid);
    res.json({ assignment, files: filesForAssignment(assignment.id) });
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
