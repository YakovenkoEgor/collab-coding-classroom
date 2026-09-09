const express = require("express");
const db = require("../db/database");
const { requireLogin, requireRole } = require("../middleware/auth");
const {
  runJavaProject,
  startInteractiveRun,
  SandboxError,
  QueueFullError,
} = require("../sandbox");

const router = express.Router();

const MAX_FILES_PER_PROJECT = 20;
const MAX_VERSION_TITLE = 80;

// A version's name is free text the student types; keep it short and on one
// line so the history list stays readable.
function readVersionTitle(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_VERSION_TITLE);
}

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

// ---------------------------------------------------------------------
// Interactive runs
//
// Three endpoints per session: start it, listen to its output, feed it a
// line. Output travels over Server-Sent Events - a plain HTTP stream the
// browser understands natively, so no WebSocket library is needed.
// ---------------------------------------------------------------------

const liveSessions = new Map(); // id -> { session, ownerId, buffer }

function ownedSession(req) {
  const entry = liveSessions.get(req.params.sessionId);
  if (!entry) return null;
  return entry.ownerId === req.session.user.id ? entry : null;
}

router.post("/interactive", requireLogin, requireRole("student"), async (req, res) => {
  let project;
  try {
    project = readProject(req.body);
  } catch (err) {
    if (err instanceof SandboxError) return res.status(400).json({ error: err.message });
    throw err;
  }

  // One live program per student: a second Run replaces the first rather than
  // quietly leaving it holding a container.
  for (const [id, entry] of liveSessions) {
    if (entry.ownerId === req.session.user.id) {
      entry.session.stop();
      liveSessions.delete(id);
    }
  }

  try {
    const started = await startInteractiveRun(project.files, project.entry);
    if (!started.ok) return res.json({ compileFailed: true, result: started.result });

    const { session } = started;
    // Output that arrives before the browser opens the stream is kept here.
    const entry = { session, ownerId: req.session.user.id, buffer: [] };
    liveSessions.set(session.id, entry);

    session.on("output", (text) => entry.buffer.push({ type: "output", text }));
    session.on("exit", ({ reason }) => {
      entry.buffer.push({ type: "exit", text: reason });
      // Give a late-connecting client a moment to read the tail.
      setTimeout(() => liveSessions.delete(session.id), 60_000);
    });

    res.json({ sessionId: session.id });
  } catch (err) {
    if (err instanceof SandboxError) return res.status(400).json({ error: err.message });
    if (err instanceof QueueFullError) return res.status(503).json({ error: err.message });
    console.error(err);
    res.status(502).json({ error: "Failed to start the program" });
  }
});

// The live transcript. Everything buffered so far is replayed first, so
// reconnecting doesn't lose output.
router.get("/interactive/:sessionId/stream", requireLogin, (req, res) => {
  const entry = ownedSession(req);
  if (!entry) return res.status(404).json({ error: "No such run" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // tell any proxy not to buffer this
  });

  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  entry.buffer.forEach(send);
  if (entry.session.finished) return res.end();

  const onOutput = (text) => send({ type: "output", text });
  const onExit = ({ reason }) => {
    send({ type: "exit", text: reason });
    res.end();
  };

  entry.session.on("output", onOutput);
  entry.session.on("exit", onExit);

  // Keeps intermediaries from closing an idle connection.
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);

  req.on("close", () => {
    clearInterval(ping);
    entry.session.off("output", onOutput);
    entry.session.off("exit", onExit);
  });
});

router.post("/interactive/:sessionId/input", requireLogin, (req, res) => {
  const entry = ownedSession(req);
  if (!entry) return res.status(404).json({ error: "No such run" });
  if (entry.session.finished) {
    return res.status(409).json({ error: "The program has already finished" });
  }
  const text = typeof req.body.text === "string" ? req.body.text : "";
  entry.session.write(text);
  res.json({ ok: true });
});

router.post("/interactive/:sessionId/stop", requireLogin, (req, res) => {
  const entry = ownedSession(req);
  if (!entry) return res.status(404).json({ error: "No such run" });
  entry.session.stop();
  res.json({ ok: true });
});

// Rename a version. Only the student who owns it, and only while it is still a
// draft - once handed in, the history the teacher sees stays as it was.
router.patch(
  "/:submissionId/title",
  requireLogin,
  requireRole("student"),
  (req, res) => {
    const submission = db
      .prepare("SELECT * FROM submissions WHERE id = ?")
      .get(req.params.submissionId);
    if (!submission) return res.status(404).json({ error: "Submission not found" });
    if (submission.student_id !== req.session.user.id) {
      return res.status(403).json({ error: "Not your submission" });
    }
    if (submission.status !== "draft") {
      return res
        .status(400)
        .json({ error: "Only a draft can be renamed" });
    }

    const title = readVersionTitle(req.body.title);
    db.prepare("UPDATE submissions SET title = ? WHERE id = ?").run(
      title,
      submission.id
    );
    res.json({ submission: { ...submission, title } });
  }
);

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
      // Every slot is busy and the waiting list is full - ask them to retry.
      if (err instanceof QueueFullError) return res.status(503).json({ error: err.message });
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

    // Only code assignments are compiled and run - a written answer has
    // nothing to execute, and free-form work never reaches this route.
    const assignmentType = (
      db.prepare("SELECT type FROM assignments WHERE id = ?").get(assignmentId) || {}
    ).type;

    if (assignmentType === "freeform") {
      return res.status(400).json({
        error: "This assignment takes attached files, not saved versions",
      });
    }

    // A written answer is a single blob; store it under a fixed name so the
    // rest of the version machinery keeps working unchanged.
    if (assignmentType === "text") {
      project = {
        files: [{ filename: "answer.txt", content: project.files[0].content }],
        entry: "answer.txt",
      };
    }

    // Code is compiled and run only when the student actually submits.
    // Saving a draft used to cost a full sandbox run, which doubled the load
    // for no one's benefit - the student presses Run when they want output.
    const shouldRun = assignmentType === "code" && status === "submitted";

    let runResult = {
      stdout: "",
      stderr: "",
      status: assignmentType === "text" ? "Saved" : "Not run",
    };
    // What the student typed into the console-input box, if anything. Stored
    // with the version so the teacher can rerun it under the same input.
    const stdin = typeof req.body.stdin === "string" ? req.body.stdin : "";

    if (shouldRun) {
      try {
        runResult = await runJavaProject(project.files, project.entry, stdin);
      } catch (err) {
        if (err instanceof SandboxError) return res.status(400).json({ error: err.message });
        if (err instanceof QueueFullError) return res.status(503).json({ error: err.message });
        console.error(err);
      }
    }

    const entryFile = project.files.find((f) => f.filename === project.entry);

    const save = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO submissions
           (assignment_id, student_id, version_number, title, code, stdin, status,
            last_run_stdout, last_run_stderr, last_run_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          assignmentId,
          studentId,
          nextVersion,
          readVersionTitle(req.body.title),
          // Kept in sync with the entry file so single-file views still work.
          entryFile.content,
          stdin,
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
