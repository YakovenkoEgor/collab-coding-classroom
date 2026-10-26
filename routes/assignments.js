const express = require("express");
const db = require("../db/database");
const { requireLogin, requireRole } = require("../middleware/auth");
const storage = require("../storage");
const { isValidJavaFilename, SandboxError } = require("../sandbox");
const {
  withDeadlineState,
  normalizeDeadline,
  DeadlineError,
} = require("../deadlines");
const rules = require("../assignmentRules");
const progsnap = require("../progsnap");
const projectFiles = require("../projectFiles");
const testing = require("../testing");

const router = express.Router();

const ASSIGNMENT_TYPES = ["code", "text", "freeform", "test"];
const MAX_STARTER_FILES = 20;

function normalizeType(type) {
  const value = (type || "code").trim();
  if (!ASSIGNMENT_TYPES.includes(value)) {
    throw new SandboxError(
      `Неизвестный тип задания «${value}» (ожидается один из: ${ASSIGNMENT_TYPES.join(", ")})`
    );
  }
  return value;
}

// SQL fragment: has this student handed in anything for assignment `a`?
// Free-form assignments have no versions, so an attached file counts instead.
// Both placeholders take the student id.
const HAS_SUBMITTED_SQL = `
  CASE
    WHEN a.type = 'freeform'
      THEN EXISTS (SELECT 1 FROM submission_uploads u
                   WHERE u.assignment_id = a.id AND u.student_id = ?)
    WHEN a.type = 'test'
      THEN EXISTS (SELECT 1 FROM test_attempts t
                   WHERE t.assignment_id = a.id AND t.student_id = ?
                     AND t.submitted_at IS NOT NULL)
    ELSE EXISTS (SELECT 1 FROM submissions sub
                 WHERE sub.assignment_id = a.id AND sub.student_id = ?
                   AND sub.status = 'submitted')
  END`;
const DEFAULT_STARTER =
  "public class Main {\n    public static void main(String[] args) {\n        \n    }\n}\n";

function starterFilesFor(assignmentId) {
  return db
    .prepare(
      `SELECT filename, content, encoding, is_entry AS isEntry
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
        `В стартовом проекте не больше ${MAX_STARTER_FILES} файлов`
      );
    }
    const files = body.starterFiles.map((f) => ({
      filename: String(f.filename || "").trim(),
      content: typeof f.content === "string" ? f.content : "",
      encoding: projectFiles.normalizeEncoding(f.encoding),
    }));

    // Sources and data files follow their own name rules; a starter project
    // may hand out both (an input.txt next to Main.java, say).
    const seen = new Set();
    for (const file of files) {
      if (projectFiles.isJavaFile(file.filename)) {
        if (!isValidJavaFilename(file.filename)) {
          throw new SandboxError(
            `«${file.filename}» — недопустимое имя файла Java (ожидается что-то вроде Main.java)`
          );
        }
      } else if (!projectFiles.isSafeDataFilename(file.filename)) {
        throw new SandboxError(
          `«${file.filename}» — недопустимое имя файла: буквы, цифры, точка, дефис и подчёркивание, без папок`
        );
      }
      if (seen.has(file.filename)) {
        throw new SandboxError(`Файл с именем ${file.filename} уже есть в проекте`);
      }
      seen.add(file.filename);
    }

    const javaFiles = files.filter((f) => projectFiles.isJavaFile(f.filename));
    if (javaFiles.length === 0) {
      throw new SandboxError("В стартовом проекте нужен хотя бы один файл .java");
    }

    // The entry is what the student's Run starts from, so it has to be a
    // source file even if the teacher had a data file selected in the form.
    const chosen = files.find((f) => f.filename === body.starterEntry);
    const entry =
      chosen && projectFiles.isJavaFile(chosen.filename)
        ? chosen.filename
        : javaFiles[0].filename;
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

  // The deadline and the top mark are the ones this student's study group
  // gets; they are aliased so a.* keeps its own raw columns intact, and then
  // put in place of them below.
  const rows = db
    .prepare(
      `SELECT a.*, ${HAS_SUBMITTED_SQL} AS hasSubmitted,
              COALESCE(r.deadline, a.deadline) AS groupDeadline,
              COALESCE(r.max_score, a.max_score) AS groupMaxScore
       FROM assignments a ${rules.RULE_JOIN_FOR_STUDENT}
       ${where} ORDER BY a.created_at DESC`
    )
    // Three placeholders in HAS_SUBMITTED_SQL plus the one in the rule join,
    // all of them this student's id.
    .all(
      req.session.user.id,
      req.session.user.id,
      req.session.user.id,
      req.session.user.id
    );

  res.json({
    assignments: rows.map((row) => {
      const assignment = {
        ...row,
        deadline: row.groupDeadline,
        max_score: row.groupMaxScore,
      };
      if (row.type !== "test") return withDeadlineState(assignment);
      // A test also carries the window it can be solved in, so the student's
      // list can say "not open yet" / "closed" without a second request.
      return {
        ...withDeadlineState(assignment),
        availability: testing.availabilityOf({
          availableFrom: row.available_from,
          deadline: assignment.deadline,
        }),
        questionCount: testing.questionCount(row.id),
      };
    }),
  });
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
         UNION ALL
         -- a handed-in test. Surveys are never marked, so they never wait
         -- for review.
         SELECT t.assignment_id, t.student_id, t.submitted_at
         FROM test_attempts t
         JOIN assignments a ON a.id = t.assignment_id
         WHERE a.type = 'test' AND a.test_kind = 'graded'
           AND t.submitted_at IS NOT NULL
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

// Teacher-only: the study groups a new assignment can give its own rules to.
// Registered before "/:id" so "groups" isn't read as an assignment id.
router.get("/groups", requireLogin, requireRole("teacher"), (req, res) => {
  res.json({ groups: rules.knownGroups(null) });
});

router.get("/:id", requireLogin, (req, res) => {
  const assignment = db
    .prepare("SELECT * FROM assignments WHERE id = ?")
    .get(req.params.id);
  if (!assignment) return res.status(404).json({ error: "Задание не найдено" });
  const isTeacher = req.session.user.role === "teacher";
  res.json({
    assignment,
    files: filesForAssignment(assignment.id),
    starterFiles: starterFilesFor(assignment.id),
    groupRules: rules.rulesForAssignment(assignment.id),
    // The groups the edit form offers rows for.
    groups: rules.knownGroups(assignment.id),
    // A test's questions; only the teacher sees which answers are correct,
    // and students get the questions through /api/tests anyway.
    questions:
      assignment.type === "test" && isTeacher
        ? testing.questionsFor(assignment.id, { withAnswers: true })
        : undefined,
    // Once anyone has started, the questions are frozen: the form shows them
    // read-only and sends only the settings.
    testAttempts:
      assignment.type === "test" && isTeacher
        ? db
            .prepare("SELECT COUNT(*) c FROM test_attempts WHERE assignment_id = ?")
            .get(assignment.id).c
        : undefined,
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
  if (!file) return res.status(404).json({ error: "Файл не найден" });

  const fullPath = storage.pathForStoredName(file.stored_name);
  if (!fullPath) return res.status(404).json({ error: "Файл не найден" });

  // Process data: a student opening the handout is ProgSnap2's Resource.View.
  // The resource is named by its stored name, which carries nothing personal.
  if (req.session.user.role === "student") {
    progsnap.logEvent({
      eventType: progsnap.EventType.RESOURCE_VIEW,
      subjectId: req.session.user.id,
      sessionId: req.sessionID,
      assignmentId: req.params.id,
      resourceId: file.stored_name,
    });
  }

  res.download(fullPath, file.original_name, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: "Файл отсутствует на диске" });
    }
  });
});

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

// Network access is only meaningful where there is a program to run: the
// mirror exists so Java code can download from it.
function readNetworkAccess(raw, assignmentType) {
  if (assignmentType !== "code") return 0;
  return raw === true || raw === 1 || raw === "1" || raw === "true" ? 1 : 0;
}

// Per-group exceptions from the form: [{ groupName, deadline, maxScore }].
// A row that overrides nothing is dropped rather than stored as a no-op, so
// clearing both fields in the form removes the exception.
function readGroupRules(body) {
  const raw = Array.isArray(body.groupRules) ? body.groupRules : [];
  if (raw.length > rules.MAX_GROUP_RULES) {
    throw new SandboxError(
      `Свои правила можно задать не более чем ${rules.MAX_GROUP_RULES} учебным группам`
    );
  }

  const parsed = [];
  const seen = new Set();
  for (const item of raw) {
    const groupName = String((item && item.groupName) || "").trim();
    if (!groupName) continue;
    if (groupName.length > rules.MAX_GROUP_NAME) {
      throw new SandboxError(`Слишком длинное название учебной группы: «${groupName}»`);
    }

    const deadline = normalizeDeadline(item.deadline);
    const hasMax =
      item.maxScore !== undefined && item.maxScore !== null && item.maxScore !== "";
    const maxScore = hasMax ? normalizeMaxScore(item.maxScore) : null;
    if (deadline === null && maxScore === null) continue;

    if (seen.has(groupName)) {
      throw new SandboxError(`Учебная группа «${groupName}» указана дважды`);
    }
    seen.add(groupName);
    parsed.push({ groupName, deadline, maxScore });
  }
  return parsed;
}

// Marks already given that the new limits would put out of range. Checked per
// group, because each group can have a top mark of its own.
function gradesAboveNewMax(assignmentId, defaultMax, groupRules) {
  const maxFor = (groupName) => {
    const rule = groupRules.find((r) => r.groupName === groupName);
    return rule && rule.maxScore !== null ? rule.maxScore : defaultMax;
  };

  return db
    .prepare(
      // '' stands for "no group" - those students follow the assignment.
      `SELECT COALESCE(u.group_name, '') AS groupName,
              MAX(g.score) AS topScore, COUNT(*) AS graded
       FROM grades g JOIN users u ON u.id = g.student_id
       WHERE g.assignment_id = ? AND g.score IS NOT NULL
       GROUP BY COALESCE(u.group_name, '')`
    )
    .all(assignmentId)
    .filter((row) => row.topScore > maxFor(row.groupName))
    .map((row) => ({
      groupName: row.groupName,
      topScore: row.topScore,
      newMax: maxFor(row.groupName),
    }));
}

// The test part of the payload, for an assignment of type "test": its kind
// (graded or survey), how long one attempt may last, when solving opens, and
// the questions themselves.
function readTestSpec(body) {
  const testKind = testing.normalizeKind(body.testKind);
  return {
    testKind,
    timeLimitMinutes: testing.normalizeTimeLimit(body.timeLimitMinutes),
    // Empty means "as soon as it exists", which is the usual case.
    availableFrom: normalizeDeadline(body.availableFrom),
    // Leaving questions out of an edit keeps the ones already stored, so the
    // dates and the time limit can be changed on their own - which is the
    // whole point once students have started answering.
    questions:
      body.questions === undefined ? null : testing.readQuestions(body.questions, testKind),
  };
}

// Teacher-only: create an assignment, optionally with handout files.
// files: [{ name, data }] where data is base64 (a data: URL is also accepted).
router.post("/", requireLogin, requireRole("teacher"), (req, res) => {
  const { title, description, files, deadline } = req.body;
  if (!title) return res.status(400).json({ error: "Укажите название задания" });

  let dueAt;
  try {
    dueAt = normalizeDeadline(deadline);
  } catch (err) {
    if (err instanceof DeadlineError) return res.status(400).json({ error: err.message });
    throw err;
  }

  let assignmentType;
  let maxScore;
  let groupRules;
  let networkAccess = 0;
  let starter = null;
  let test = null;
  try {
    assignmentType = normalizeType(req.body.type);
    maxScore = normalizeMaxScore(req.body.maxScore);
    groupRules = readGroupRules(req.body);
    networkAccess = readNetworkAccess(req.body.networkAccess, assignmentType);
    // Only code assignments carry a Java starter project. A text assignment's
    // starter is the text the student begins from; free-form has none.
    if (assignmentType === "code") starter = readStarterProject(req.body);
    if (assignmentType === "test") {
      test = readTestSpec(req.body);
      // A brand new test has to come with its questions.
      if (!test.questions) throw new testing.TestError("В тесте должен быть хотя бы один вопрос");
    }
  } catch (err) {
    if (
      err instanceof SandboxError ||
      err instanceof DeadlineError ||
      err instanceof testing.TestError
    ) {
      return res.status(400).json({ error: err.message });
    }
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
             (title, description, starter_code, created_by, deadline, type, max_score,
              test_kind, available_from, time_limit_minutes, network_access)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        // starter_code mirrors the entry file for the older single-file paths.
        .run(
          title,
          description || "",
          starterContent,
          req.session.user.id,
          dueAt,
          assignmentType,
          maxScore,
          test ? test.testKind : null,
          test ? test.availableFrom : null,
          test ? test.timeLimitMinutes : null,
          networkAccess
        );

      rules.replaceRules(info.lastInsertRowid, groupRules);
      if (test && test.questions) testing.replaceQuestions(info.lastInsertRowid, test.questions);

      const insertStarter = db.prepare(
        `INSERT INTO assignment_starter_files
           (assignment_id, filename, content, encoding, is_entry)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const f of starter ? starter.files : []) {
        insertStarter.run(
          info.lastInsertRowid,
          f.filename,
          f.content,
          projectFiles.normalizeEncoding(f.encoding),
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
      groupRules: rules.rulesForAssignment(assignmentId),
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
  if (!assignment) return res.status(404).json({ error: "Задание не найдено" });

  const { title, description, files, removeFileIds, deadline } = req.body;
  const newTitle = (title || "").trim();
  if (!newTitle) return res.status(400).json({ error: "Укажите название задания" });

  let dueAt;
  let starter = null;
  let assignmentType;
  let maxScore;
  let groupRules;
  let networkAccess = 0;
  let test = null;
  try {
    dueAt = normalizeDeadline(deadline);
    assignmentType = req.body.type === undefined ? assignment.type : normalizeType(req.body.type);
    maxScore =
      req.body.maxScore === undefined
        ? assignment.max_score
        : normalizeMaxScore(req.body.maxScore);
    // Leaving groupRules out of the request keeps the current exceptions;
    // sending an empty list clears them.
    groupRules =
      req.body.groupRules === undefined
        ? rules.rulesForAssignment(assignment.id)
        : readGroupRules(req.body);
    // Omitted in the request means "leave it as it is".
    networkAccess = readNetworkAccess(
      req.body.networkAccess === undefined
        ? !!assignment.network_access
        : req.body.networkAccess,
      assignmentType
    );
    if (assignmentType === "code") starter = readStarterProject(req.body);
    if (assignmentType === "test") test = readTestSpec(req.body);
  } catch (err) {
    if (
      err instanceof DeadlineError ||
      err instanceof SandboxError ||
      err instanceof testing.TestError
    ) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  // Editing the questions of a test people have already sat would change what
  // their answers were answers to, so the attempts have to go first.
  if (assignmentType === "test") {
    const attempts = db
      .prepare("SELECT COUNT(*) c FROM test_attempts WHERE assignment_id = ?")
      .get(assignment.id).c;
    if (attempts > 0 && req.body.questions !== undefined) {
      return res.status(409).json({
        error: `Этот тест уже начали проходить: ${attempts} чел. Их ответы перестанут соответствовать вопросам. Удалите тест или оставьте вопросы без изменений.`,
      });
    }
  }

  // Lowering a top mark below marks already given would leave grades that the
  // grade box itself would refuse to accept. Say so instead of silently
  // creating that state - per group, since each can have its own maximum.
  const conflicts = gradesAboveNewMax(assignment.id, maxScore, groupRules);
  if (conflicts.length > 0) {
    const where = conflicts
      .map(
        (c) =>
          `${c.groupName || "без группы"}: уже выставлено ${c.topScore}, новый максимум ${c.newMax}`
      )
      .join("; ");
    return res.status(409).json({
      error: `Оценки выше нового максимума уже выставлены (${where}). Исправьте эти оценки или оставьте прежний максимум.`,
    });
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
          "Тип нельзя изменить после того, как ученики начали работать над заданием",
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
             max_score = ?, test_kind = ?, available_from = ?, time_limit_minutes = ?,
             network_access = ?
         WHERE id = ?`
      ).run(
        newTitle,
        description || "",
        starterContent,
        dueAt,
        assignmentType,
        maxScore,
        test ? test.testKind : null,
        test ? test.availableFrom : null,
        test ? test.timeLimitMinutes : null,
        networkAccess,
        assignment.id
      );

      rules.replaceRules(assignment.id, groupRules);
      if (test && test.questions) testing.replaceQuestions(assignment.id, test.questions);

      db.prepare("DELETE FROM assignment_starter_files WHERE assignment_id = ?").run(
        assignment.id
      );
      const insertStarter = db.prepare(
        `INSERT INTO assignment_starter_files
           (assignment_id, filename, content, encoding, is_entry)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const f of starter ? starter.files : []) {
        insertStarter.run(
          assignment.id,
          f.filename,
          f.content,
          projectFiles.normalizeEncoding(f.encoding),
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
      groupRules: rules.rulesForAssignment(assignment.id),
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
  if (!assignment) return res.status(404).json({ error: "Задание не найдено" });

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
    db.prepare("DELETE FROM assignment_group_rules WHERE assignment_id = ?").run(
      assignment.id
    );
    testing.deleteTestData(assignment.id);
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
    testAttempts: db
      .prepare("SELECT COUNT(*) c FROM test_attempts WHERE assignment_id = ?")
      .get(id).c,
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
      .prepare(
        `SELECT type, test_kind AS testKind, time_limit_minutes AS timeLimitMinutes
         FROM assignments WHERE id = ?`
      )
      .get(req.params.id);
    const isFreeform = assignment && assignment.type === "freeform";
    const isTest = assignment && assignment.type === "test";

    const rows = db
      .prepare(
        `
      SELECT u.id AS studentId, u.display_name AS displayName,
             u.first_name AS firstName, u.last_name AS lastName,
             u.group_name AS groupName, a.archived,
             -- The deadline and top mark of this student's own group.
             COALESCE(r.deadline, a.deadline) AS deadline,
             COALESCE(r.max_score, a.max_score) AS maxScore,
             s.version_number AS latestVersion, s.status, s.created_at AS lastActivity,
             g.score, g.feedback,
             (SELECT COUNT(*) FROM submission_uploads up
              WHERE up.assignment_id = ? AND up.student_id = u.id) AS fileCount,
             (SELECT MAX(created_at) FROM submission_uploads up
              WHERE up.assignment_id = ? AND up.student_id = u.id) AS lastUpload,
             t.id AS attemptId, t.started_at AS attemptStarted,
             t.submitted_at AS attemptSubmitted
      FROM users u
      JOIN assignments a ON a.id = ?
      ${rules.RULE_JOIN_FOR_USERS}
      LEFT JOIN (
        SELECT * FROM submissions
        WHERE assignment_id = ?
        AND id IN (
          SELECT MAX(id) FROM submissions WHERE assignment_id = ? GROUP BY student_id
        )
      ) s ON s.student_id = u.id
      LEFT JOIN grades g ON g.assignment_id = ? AND g.student_id = u.id
      LEFT JOIN test_attempts t ON t.assignment_id = ? AND t.student_id = u.id
      WHERE u.role = 'student'
      -- A base order by surname; the client re-sorts it to put students who
      -- have handed the work in at the top (what counts as "handed in" depends
      -- on the assignment type, which is easier to express there).
      ORDER BY u.last_name, u.first_name, u.display_name
    `
      )
      // fileCount, lastUpload, the assignment join, the two submission
      // sub-queries, and grades - every one of them the assignment id.
      .all(
        req.params.id,
        req.params.id,
        req.params.id,
        req.params.id,
        req.params.id,
        req.params.id,
        req.params.id
      );
    // Students who haven't handed the work in get the same due-soon/overdue
    // flag the teacher sees in a profile, now against their group's date.
    // A test's rows carry the state of the attempt and, for a graded test,
    // how it came out - the teacher's table shows that instead of a version
    // number. Expired attempts are closed on the way past.
    const questions = isTest
      ? testing.questionsFor(req.params.id, { withAnswers: true })
      : [];

    res.json({
      students: rows.map((row) => {
        let test = null;
        if (isTest) {
          let attempt = row.attemptId
            ? {
                id: row.attemptId,
                assignmentId: Number(req.params.id),
                studentId: row.studentId,
                startedAt: row.attemptStarted,
                submittedAt: row.attemptSubmitted,
              }
            : null;
          if (attempt) {
            attempt = testing.closeIfExpired(attempt, assignment.timeLimitMinutes);
          }
          test = {
            state: !attempt ? "not-started" : attempt.submittedAt ? "submitted" : "in-progress",
            startedAt: attempt ? attempt.startedAt : null,
            submittedAt: attempt ? attempt.submittedAt : null,
            summary: attempt
              ? testing.checkAttempt(
                  questions,
                  testing.answersFor(attempt.id),
                  assignment.testKind
                ).summary
              : null,
          };
        }

        return withDeadlineState({
          ...row,
          test,
          lastActivity: isTest
            ? (test && (test.submittedAt || test.startedAt)) || null
            : row.lastActivity,
          hasSubmitted: isFreeform
            ? row.fileCount > 0
            : isTest
              ? !!(test && test.state === "submitted")
              : row.status === "submitted",
        });
      }),
      groupRules: rules.rulesForAssignment(req.params.id),
      testKind: isTest ? assignment.testKind : null,
    });
  }
);

module.exports = router;
