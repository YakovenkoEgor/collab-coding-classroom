const express = require("express");
const db = require("../db/database");
const { requireLogin, requireRole } = require("../middleware/auth");
const storage = require("../storage");
const { isValidJavaFilename, SandboxError } = require("../sandbox");
const { withDeadlineState } = require("../deadlines");

const router = express.Router();

const ASSIGNMENT_TYPES = ["code", "text", "freeform"];
const MAX_STARTER_FILES = 20;

function normalizeType(type) {
  const value = (type || "code").trim();
  if (!ASSIGNMENT_TYPES.includes(value)) {
    throw new SandboxError(
      `Unknown assignment type "${value}" (expected one of: ${ASSIGNMENT_TYPES.join(", ")})`
    );
  }
  return value;
}

// SQL fragment: has this student handed in anything for assignment `a`?
// Free-form assignments have no versions, so an attached file counts instead.
// Both placeholders take the student id.
const HAS_SUBMITTED_SQL = `
  CASE WHEN a.type = 'freeform'
    THEN EXISTS (SELECT 1 FROM submission_uploads u
                 WHERE u.assignment_id = a.id AND u.student_id = ?)
    ELSE EXISTS (SELECT 1 FROM submissions sub
                 WHERE sub.assignment_id = a.id AND sub.student_id = ?
                   AND sub.status = 'submitted')
  END`;
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

// List assignments (both roles see the same list; archived hidden by default).
// For a student each row also carries whether they've handed it in and how the
// deadline stands, so their sidebar can warn them the same way the teacher's
// profile view does.
router.get("/", requireLogin, (req, res) => {
  const includeArchived = req.query.all === "1";
  const where = includeArchived ? "" : "WHERE a.archived = 0";

  if (req.session.user.role !== "student") {
    const rows = db
      .prepare(`SELECT a.* FROM assignments a ${where} ORDER BY a.created_at DESC`)
      .all();
    return res.json({ assignments: rows });
  }

  const rows = db
    .prepare(
      `SELECT a.*, ${HAS_SUBMITTED_SQL} AS hasSubmitted
       FROM assignments a ${where} ORDER BY a.created_at DESC`
    )
    .all(req.session.user.id, req.session.user.id);

  res.json({ assignments: rows.map(withDeadlineState) });
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
         -- versioned work (code and text)
         SELECT s.assignment_id, s.student_id, MAX(s.created_at) AS last_submitted
         FROM submissions s
         JOIN assignments a ON a.id = s.assignment_id
         WHERE s.status = 'submitted' AND a.type <> 'freeform'
         GROUP BY s.assignment_id, s.student_id
         UNION ALL
         -- free-form work: the attached files are the submission
         SELECT u.assignment_id, u.student_id, MAX(u.created_at)
         FROM submission_uploads u
         JOIN assignments a ON a.id = u.assignment_id
         WHERE a.type = 'freeform'
         GROUP BY u.assignment_id, u.student_id
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

// The browser sends datetime-local as "YYYY-MM-DDTHH:MM"; store it with a
// space so it sorts and compares like the other timestamps.
class DeadlineError extends Error {}

// The top mark a teacher can award for this assignment. Kept a whole number:
// the grade box steps through integers, and half-points would make the
// wrap-around behaviour and the gradebook export messy.
const MIN_MAX_SCORE = 1;
const MAX_MAX_SCORE = 100;
const DEFAULT_MAX_SCORE = 15;

function normalizeMaxScore(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MAX_SCORE;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value) || value < MIN_MAX_SCORE || value > MAX_MAX_SCORE) {
    throw new SandboxError(
      `Maximum score must be a whole number between ${MIN_MAX_SCORE} and ${MAX_MAX_SCORE}`
    );
  }
  return value;
}

function normalizeDeadline(deadline) {
  if (typeof deadline !== "string" || deadline.trim() === "") return null;
  const normalized = deadline.trim().replace("T", " ").slice(0, 16);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(normalized)) {
    throw new DeadlineError("Deadline must look like 2026-09-01 18:00");
  }
  return normalized;
}

// Teacher-only: create an assignment, optionally with handout files.
// files: [{ name, data }] where data is base64 (a data: URL is also accepted).
router.post("/", requireLogin, requireRole("teacher"), (req, res) => {
  const { title, description, files, deadline } = req.body;
  if (!title) return res.status(400).json({ error: "Title required" });

  let dueAt;
  try {
    dueAt = normalizeDeadline(deadline);
  } catch (err) {
    if (err instanceof DeadlineError) return res.status(400).json({ error: err.message });
    throw err;
  }

  let assignmentType;
  let maxScore;
  let starter = null;
  try {
    assignmentType = normalizeType(req.body.type);
    maxScore = normalizeMaxScore(req.body.maxScore);
    // Only code assignments carry a Java starter project. A text assignment's
    // starter is the text the student begins from; free-form has none.
    if (assignmentType === "code") starter = readStarterProject(req.body);
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
    const starterContent = starter
      ? starter.files.find((f) => f.filename === starter.entry).content
      : assignmentType === "text"
        ? String(req.body.starterText || "")
        : "";

    const create = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO assignments
             (title, description, starter_code, created_by, deadline, type, max_score)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        // starter_code mirrors the entry file for the older single-file paths.
        .run(
          title,
          description || "",
          starterContent,
          req.session.user.id,
          dueAt,
          assignmentType,
          maxScore
        );

      const insertStarter = db.prepare(
        `INSERT INTO assignment_starter_files (assignment_id, filename, content, is_entry)
         VALUES (?, ?, ?, ?)`
      );
      for (const f of starter ? starter.files : []) {
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

// Teacher-only: edit an assignment.
// Replaces the starter project wholesale, adds any newly uploaded handouts and
// removes the ones listed in removeFileIds. Student work is left untouched.
router.put("/:id", requireLogin, requireRole("teacher"), (req, res) => {
  const assignment = db
    .prepare("SELECT * FROM assignments WHERE id = ?")
    .get(req.params.id);
  if (!assignment) return res.status(404).json({ error: "Not found" });

  const { title, description, files, removeFileIds, deadline } = req.body;
  const newTitle = (title || "").trim();
  if (!newTitle) return res.status(400).json({ error: "Title required" });

  let dueAt;
  let starter = null;
  let assignmentType;
  let maxScore;
  try {
    dueAt = normalizeDeadline(deadline);
    assignmentType = req.body.type === undefined ? assignment.type : normalizeType(req.body.type);
    maxScore =
      req.body.maxScore === undefined
        ? assignment.max_score
        : normalizeMaxScore(req.body.maxScore);
    if (assignmentType === "code") starter = readStarterProject(req.body);
  } catch (err) {
    if (err instanceof DeadlineError || err instanceof SandboxError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  // Lowering the top mark below marks already given would leave grades that
  // the grade box itself would refuse to accept. Say so instead of silently
  // creating that state.
  if (maxScore < assignment.max_score) {
    const above = db
      .prepare(
        "SELECT COUNT(*) c FROM grades WHERE assignment_id = ? AND score > ?"
      )
      .get(assignment.id, maxScore).c;
    if (above > 0) {
      return res.status(409).json({
        error: `${above} student(s) already have a grade above ${maxScore}. Lower those grades first, or keep the maximum at ${assignment.max_score}.`,
      });
    }
  }

  // Changing the type would strand whatever the students have already handed
  // in - versions on one side, attached files on the other.
  if (assignmentType !== assignment.type) {
    const existingWork =
      db
        .prepare("SELECT COUNT(*) c FROM submissions WHERE assignment_id = ?")
        .get(assignment.id).c +
      db
        .prepare("SELECT COUNT(*) c FROM submission_uploads WHERE assignment_id = ?")
        .get(assignment.id).c;
    if (existingWork > 0) {
      return res.status(409).json({
        error:
          "The type can't be changed once students have started working on this assignment",
      });
    }
  }

  // Only handouts belonging to this assignment may be removed.
  const removable = new Set(
    db
      .prepare("SELECT id FROM assignment_files WHERE assignment_id = ?")
      .all(assignment.id)
      .map((row) => row.id)
  );
  const toRemove = (Array.isArray(removeFileIds) ? removeFileIds : [])
    .map((id) => parseInt(id, 10))
    .filter((id) => removable.has(id));

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
    const starterContent = starter
      ? starter.files.find((f) => f.filename === starter.entry).content
      : assignmentType === "text"
        ? String(req.body.starterText || "")
        : "";
    const removedNames = toRemove.map(
      (id) => db.prepare("SELECT stored_name FROM assignment_files WHERE id = ?").get(id)
    );

    const update = db.transaction(() => {
      db.prepare(
        `UPDATE assignments
         SET title = ?, description = ?, starter_code = ?, deadline = ?, type = ?,
             max_score = ?
         WHERE id = ?`
      ).run(
        newTitle,
        description || "",
        starterContent,
        dueAt,
        assignmentType,
        maxScore,
        assignment.id
      );

      db.prepare("DELETE FROM assignment_starter_files WHERE assignment_id = ?").run(
        assignment.id
      );
      const insertStarter = db.prepare(
        `INSERT INTO assignment_starter_files (assignment_id, filename, content, is_entry)
         VALUES (?, ?, ?, ?)`
      );
      for (const f of starter ? starter.files : []) {
        insertStarter.run(
          assignment.id,
          f.filename,
          f.content,
          f.filename === starter.entry ? 1 : 0
        );
      }

      const deleteFile = db.prepare("DELETE FROM assignment_files WHERE id = ?");
      for (const id of toRemove) deleteFile.run(id);

      const insertFile = db.prepare(
        `INSERT INTO assignment_files
           (assignment_id, original_name, stored_name, size_bytes, uploaded_by)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const f of storedFiles) {
        insertFile.run(
          assignment.id,
          f.originalName,
          f.storedName,
          f.size,
          req.session.user.id
        );
      }
    });

    update();

    // Only drop the bytes once the rows are gone for good.
    for (const row of removedNames) {
      if (row) storage.removeFile(row.stored_name);
    }

    res.json({
      assignment: db.prepare("SELECT * FROM assignments WHERE id = ?").get(assignment.id),
      files: filesForAssignment(assignment.id),
      starterFiles: starterFilesFor(assignment.id),
    });
  } catch (err) {
    storedFiles.forEach((f) => storage.removeFile(f.storedName));
    throw err;
  }
});

// Teacher-only: delete an assignment and everything attached to it -
// student submissions, discussions, grades, starter files and handouts.
router.delete("/:id", requireLogin, requireRole("teacher"), (req, res) => {
  const assignment = db
    .prepare("SELECT * FROM assignments WHERE id = ?")
    .get(req.params.id);
  if (!assignment) return res.status(404).json({ error: "Not found" });

  const handouts = db
    .prepare("SELECT stored_name FROM assignment_files WHERE assignment_id = ?")
    .all(assignment.id);
  const studentUploads = db
    .prepare("SELECT stored_name FROM submission_uploads WHERE assignment_id = ?")
    .all(assignment.id);

  // Children first - foreign keys are enforced.
  const wipe = db.transaction(() => {
    db.prepare(
      `DELETE FROM messages WHERE discussion_id IN
         (SELECT id FROM discussions WHERE assignment_id = ?)`
    ).run(assignment.id);
    db.prepare("DELETE FROM discussions WHERE assignment_id = ?").run(assignment.id);
    db.prepare(
      `DELETE FROM submission_files WHERE submission_id IN
         (SELECT id FROM submissions WHERE assignment_id = ?)`
    ).run(assignment.id);
    db.prepare("DELETE FROM submissions WHERE assignment_id = ?").run(assignment.id);
    db.prepare("DELETE FROM grades WHERE assignment_id = ?").run(assignment.id);
    db.prepare("DELETE FROM assignment_files WHERE assignment_id = ?").run(assignment.id);
    db.prepare("DELETE FROM assignment_starter_files WHERE assignment_id = ?").run(
      assignment.id
    );
    db.prepare("DELETE FROM submission_uploads WHERE assignment_id = ?").run(assignment.id);
    db.prepare("DELETE FROM assignments WHERE id = ?").run(assignment.id);
  });

  wipe();
  for (const row of handouts) storage.removeFile(row.stored_name);
  for (const row of studentUploads) storage.removeFile(row.stored_name);

  res.json({ ok: true });
});

// Teacher-only: how much work would be lost by deleting this assignment.
router.get("/:id/impact", requireLogin, requireRole("teacher"), (req, res) => {
  const id = req.params.id;
  res.json({
    submissions: db
      .prepare("SELECT COUNT(*) c FROM submissions WHERE assignment_id = ?")
      .get(id).c,
    students: db
      .prepare(
        "SELECT COUNT(DISTINCT student_id) c FROM submissions WHERE assignment_id = ?"
      )
      .get(id).c,
    uploads: db
      .prepare("SELECT COUNT(*) c FROM submission_uploads WHERE assignment_id = ?")
      .get(id).c,
    grades: db.prepare("SELECT COUNT(*) c FROM grades WHERE assignment_id = ?").get(id).c,
    messages: db
      .prepare(
        `SELECT COUNT(*) c FROM messages WHERE discussion_id IN
           (SELECT id FROM discussions WHERE assignment_id = ?)`
      )
      .get(id).c,
  });
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
    const assignment = db
      .prepare("SELECT type FROM assignments WHERE id = ?")
      .get(req.params.id);
    const isFreeform = assignment && assignment.type === "freeform";

    const rows = db
      .prepare(
        `
      SELECT u.id AS studentId, u.display_name AS displayName,
             u.first_name AS firstName, u.last_name AS lastName,
             s.version_number AS latestVersion, s.status, s.created_at AS lastActivity,
             g.score, g.feedback,
             (SELECT COUNT(*) FROM submission_uploads up
              WHERE up.assignment_id = ? AND up.student_id = u.id) AS fileCount,
             (SELECT MAX(created_at) FROM submission_uploads up
              WHERE up.assignment_id = ? AND up.student_id = u.id) AS lastUpload
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
      -- A base order by surname; the client re-sorts it to put students who
      -- have handed the work in at the top (what counts as "handed in" depends
      -- on the assignment type, which is easier to express there).
      ORDER BY u.last_name, u.first_name, u.display_name
    `
      )
      // fileCount, lastUpload, the two submission sub-queries, and grades
      .all(
        req.params.id,
        req.params.id,
        req.params.id,
        req.params.id,
        req.params.id
      );
    res.json({ students: rows });
  }
);

module.exports = router;
