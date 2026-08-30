// Student attachments on free-form assignments.
//
// Unlike code and text work, these are not versioned: a student adds, replaces
// and removes files freely within the limits in storage.js. There is nothing
// to "submit" - the files that are attached are the submission.

const express = require("express");
const db = require("../db/database");
const { requireLogin, requireRole } = require("../middleware/auth");
const storage = require("../storage");

const router = express.Router();

// A student always works on their own files; a teacher passes ?studentId=.
function resolveStudentId(req) {
  if (req.session.user.role === "student") return req.session.user.id;
  const studentId = parseInt(req.query.studentId, 10);
  return Number.isNaN(studentId) ? null : studentId;
}

function uploadsFor(assignmentId, studentId) {
  return db
    .prepare(
      `SELECT id, original_name AS originalName, size_bytes AS size,
              created_at AS createdAt
       FROM submission_uploads
       WHERE assignment_id = ? AND student_id = ?
       ORDER BY created_at`
    )
    .all(assignmentId, studentId);
}

function requireFreeform(assignmentId) {
  const assignment = db
    .prepare("SELECT * FROM assignments WHERE id = ?")
    .get(assignmentId);
  if (!assignment) return { error: "Assignment not found", status: 404 };
  if (assignment.type !== "freeform") {
    return { error: "This assignment does not take attached files", status: 400 };
  }
  return { assignment };
}

// The limits, so the browser can warn before uploading anything.
router.get("/limits", requireLogin, (req, res) => {
  res.json({
    maxFiles: storage.MAX_STUDENT_FILES,
    maxBytes: storage.MAX_STUDENT_FILE_BYTES,
    blockedExtensions: storage.BLOCKED_STUDENT_EXTENSIONS,
  });
});

router.get("/assignment/:assignmentId", requireLogin, (req, res) => {
  const studentId = resolveStudentId(req);
  if (!studentId) return res.status(400).json({ error: "studentId required" });
  res.json({ files: uploadsFor(req.params.assignmentId, studentId) });
});

// Attach files. Existing files with the same name are replaced.
router.post(
  "/assignment/:assignmentId",
  requireLogin,
  requireRole("student"),
  (req, res) => {
    const check = requireFreeform(req.params.assignmentId);
    if (check.error) return res.status(check.status).json({ error: check.error });

    const assignmentId = check.assignment.id;
    const studentId = req.session.user.id;
    const incoming = Array.isArray(req.body.files) ? req.body.files : [];
    if (incoming.length === 0) {
      return res.status(400).json({ error: "No files to attach" });
    }

    // Same-name uploads replace the old file rather than being refused.
    const existing = uploadsFor(assignmentId, studentId);
    const replacedNames = incoming
      .map((f) => String((f && f.name) || "").trim())
      .filter(Boolean);
    const keptCount = existing.filter(
      (f) => !replacedNames.includes(f.originalName)
    ).length;

    if (keptCount + incoming.length > storage.MAX_STUDENT_FILES) {
      return res.status(400).json({
        error: `You can attach at most ${storage.MAX_STUDENT_FILES} files (you already have ${existing.length}).`,
      });
    }

    let stored = [];
    try {
      stored = storage.storeStudentFiles(incoming);
    } catch (err) {
      if (err instanceof storage.UploadError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    try {
      const replaced = [];
      const save = db.transaction(() => {
        const findSame = db.prepare(
          `SELECT id, stored_name FROM submission_uploads
           WHERE assignment_id = ? AND student_id = ? AND original_name = ?`
        );
        const remove = db.prepare("DELETE FROM submission_uploads WHERE id = ?");
        const insert = db.prepare(
          `INSERT INTO submission_uploads
             (assignment_id, student_id, original_name, stored_name, size_bytes)
           VALUES (?, ?, ?, ?, ?)`
        );

        for (const file of stored) {
          const same = findSame.get(assignmentId, studentId, file.originalName);
          if (same) {
            remove.run(same.id);
            replaced.push(same.stored_name);
          }
          insert.run(
            assignmentId,
            studentId,
            file.originalName,
            file.storedName,
            file.size
          );
        }
      });

      save();
      replaced.forEach((name) => storage.removeFile(name));
      res.json({ files: uploadsFor(assignmentId, studentId) });
    } catch (err) {
      stored.forEach((f) => storage.removeFile(f.storedName));
      throw err;
    }
  }
);

// Students remove their own attachments. Teachers can read them but not
// delete them - the work belongs to the student.
router.delete("/:id", requireLogin, requireRole("student"), (req, res) => {
  const file = db
    .prepare("SELECT * FROM submission_uploads WHERE id = ?")
    .get(req.params.id);
  if (!file) return res.status(404).json({ error: "File not found" });
  if (file.student_id !== req.session.user.id) {
    return res.status(403).json({ error: "Not your file" });
  }

  db.prepare("DELETE FROM submission_uploads WHERE id = ?").run(file.id);
  storage.removeFile(file.stored_name);
  res.json({ files: uploadsFor(file.assignment_id, file.student_id) });
});

router.get("/:id/download", requireLogin, (req, res) => {
  const file = db
    .prepare("SELECT * FROM submission_uploads WHERE id = ?")
    .get(req.params.id);
  if (!file) return res.status(404).json({ error: "File not found" });

  if (
    req.session.user.role !== "teacher" &&
    file.student_id !== req.session.user.id
  ) {
    return res.status(403).json({ error: "Not your file" });
  }

  const fullPath = storage.pathForStoredName(file.stored_name);
  if (!fullPath) return res.status(404).json({ error: "File not found" });

  res.download(fullPath, file.original_name, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: "File is missing from disk" });
    }
  });
});

module.exports = router;
