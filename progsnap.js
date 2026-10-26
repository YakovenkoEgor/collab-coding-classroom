// Process data: an append-only log of what students did, in the shape
// ProgSnap2 expects.
//
// ProgSnap2 is a published standard for "programming snapshot" data - the
// sequence of edits, compiles, runs and submissions behind a piece of student
// work, rather than the finished code. Logging it in that shape means the
// course's data can be analysed with the tools and scripts other people have
// already written, and shared without a translation step.
// Specification: https://cssplice.org/progsnap2 (version 8, Beta).
//
// Three rules this module keeps:
//
//   1. Logging never breaks the thing being logged. Every entry point
//      swallows its own errors - a failed insert costs a row of research
//      data, which is worth far less than a student's run.
//   2. Nothing personal goes in. Events reference users by their database id;
//      the export replaces it with the surrogate subject key, and names,
//      logins and discussion messages never enter the log at all.
//   3. Code states are stored once per distinct content. Pressing Run twice
//      without an edit in between produces one snapshot, not two.

const crypto = require("crypto");
const db = require("./db/database");

// --- what gets logged ------------------------------------------------------

// File.Edit is the one event that can arrive by the thousand, so it is off
// unless someone turns it on, and the interval below is the floor on how
// often one student's editor may report a snapshot.
const EDIT_CAPTURE =
  String(process.env.PROGSNAP_EDIT_CAPTURE || "off").toLowerCase() === "on";
const EDIT_INTERVAL_SECONDS = Math.max(
  5,
  parseInt(process.env.PROGSNAP_EDIT_INTERVAL_SECONDS || "60", 10) || 60
);

// Everything else is on unless the whole log is switched off.
const ENABLED = String(process.env.PROGSNAP_LOGGING || "on").toLowerCase() !== "off";

// Program output can be large; a run that printed a megabyte is not worth a
// megabyte of research data. The spec says nothing about this, so the limit
// is ours and the README says what it is.
const MAX_OUTPUT_CHARS = parseInt(
  process.env.PROGSNAP_MAX_OUTPUT_CHARS || "20000",
  10
);

// Standard event types we emit. Anything dataset-specific carries the "X-"
// prefix the specification reserves for exactly that.
const EventType = {
  SESSION_START: "Session.Start",
  SESSION_END: "Session.End",
  PROJECT_OPEN: "Project.Open",
  FILE_EDIT: "File.Edit",
  FILE_CREATE: "File.Create",
  FILE_DELETE: "File.Delete",
  COMPILE: "Compile",
  COMPILE_ERROR: "Compile.Error",
  SUBMIT: "Submit",
  RUN_PROGRAM: "Run.Program",
  RESOURCE_VIEW: "Resource.View",
  // Dataset-specific, documented in the exported README.txt:
  X_DRAFT_SAVE: "X-Draft.Save",
  X_GRADE: "X-Grade",
  X_TEST_START: "X-Test.Start",
  X_TEST_SUBMIT: "X-Test.Submit",
  X_SANDBOX_ERROR: "X-Sandbox.Error",
};

// ExecutionResult is an enum of four values; the sandbox has its own, richer
// set of statuses, so they are mapped rather than passed through.
const EXECUTION_RESULT = {
  Accepted: "Success",
  Saved: "Success",
  "Time Limit Exceeded": "Timeout",
  "Compilation Time Limit Exceeded": "Timeout",
  "Compilation Error": "Error",
  "Runtime Error": "Error",
  "Sandbox Error": "Error",
  Error: "Error",
};

function executionResultFor(status) {
  return EXECUTION_RESULT[status] || "Error";
}

function clip(text) {
  const value = text === undefined || text === null ? null : String(text);
  if (value === null) return null;
  return value.length > MAX_OUTPUT_CHARS
    ? `${value.slice(0, MAX_OUTPUT_CHARS)}\n[…обрезано при записи в журнал]`
    : value;
}

// --- code states -----------------------------------------------------------

// The id is a hash of the content itself, which gives deduplication for free:
// the same project saved twice is the same id, and the Directory format of
// the export can use it as a folder name (hex, so always a legal name).
function codeStateIdFor(files) {
  const normalized = (files || [])
    .filter((f) => f && f.filename)
    .map((f) => ({
      filename: String(f.filename),
      content: typeof f.content === "string" ? f.content : "",
      encoding: f.encoding === "base64" ? "base64" : "text",
      isEntry: f.isEntry ? 1 : 0,
    }))
    .sort((a, b) => a.filename.localeCompare(b.filename));

  if (normalized.length === 0) return null;

  const hash = crypto.createHash("sha256");
  for (const file of normalized) {
    hash.update(file.filename);
    hash.update("\u0000");
    hash.update(file.encoding);
    hash.update("\u0000");
    hash.update(file.content);
    hash.update("\u0000");
  }
  return hash.digest("hex").slice(0, 40);
}

// Stores a snapshot unless an identical one is already there. Returns the id
// so the caller can put it on an event.
function recordCodeState(files, entryFilename) {
  const id = codeStateIdFor(files);
  if (!id) return null;

  const existing = db
    .prepare("SELECT code_state_id FROM event_code_states WHERE code_state_id = ?")
    .get(id);
  if (existing) return id;

  const insertState = db.prepare(
    "INSERT INTO event_code_states (code_state_id) VALUES (?)"
  );
  const insertFile = db.prepare(
    `INSERT INTO event_code_state_files
       (code_state_id, filename, content, encoding, is_entry)
     VALUES (?, ?, ?, ?, ?)`
  );

  const store = db.transaction(() => {
    insertState.run(id);
    for (const file of files) {
      if (!file || !file.filename) continue;
      insertFile.run(
        id,
        String(file.filename),
        typeof file.content === "string" ? file.content : "",
        file.encoding === "base64" ? "base64" : "text",
        file.filename === entryFilename || file.isEntry ? 1 : 0
      );
    }
  });
  store();
  return id;
}

// --- writing events --------------------------------------------------------

const INSERT_EVENT = `
  INSERT INTO events
    (event_type, subject_id, session_id, assignment_id, submission_id,
     code_state_id, code_state_section, client_timestamp, event_initiator,
     edit_type, compile_result, compile_message_type, compile_message_data,
     execution_id, execution_result, program_input, program_output,
     program_error_output, score, attempt, parent_event_id, resource_id, extra)
  VALUES
    (@eventType, @subjectId, @sessionId, @assignmentId, @submissionId,
     @codeStateId, @codeStateSection, @clientTimestamp, @eventInitiator,
     @editType, @compileResult, @compileMessageType, @compileMessageData,
     @executionId, @executionResult, @programInput, @programOutput,
     @programErrorOutput, @score, @attempt, @parentEventId, @resourceId, @extra)
`;

// The one way into the log. Returns the new EventID, or null when nothing was
// written - callers that want to point a later event at this one should check.
function logEvent(event) {
  if (!ENABLED) return null;
  if (event.eventType === EventType.FILE_EDIT && !EDIT_CAPTURE) return null;

  try {
    const info = db.prepare(INSERT_EVENT).run({
      eventType: event.eventType,
      subjectId: event.subjectId ?? null,
      sessionId: event.sessionId ?? null,
      assignmentId: event.assignmentId ?? null,
      submissionId: event.submissionId ?? null,
      codeStateId: event.codeStateId ?? null,
      codeStateSection: event.codeStateSection ?? null,
      clientTimestamp: event.clientTimestamp ?? null,
      // Almost everything here happens because a student pressed something.
      eventInitiator: event.eventInitiator ?? "UserDirectAction",
      editType: event.editType ?? null,
      compileResult: event.compileResult ?? null,
      compileMessageType: event.compileMessageType ?? null,
      compileMessageData: clip(event.compileMessageData),
      executionId: event.executionId ?? null,
      executionResult: event.executionResult ?? null,
      programInput: clip(event.programInput),
      programOutput: clip(event.programOutput),
      programErrorOutput: clip(event.programErrorOutput),
      score: event.score ?? null,
      attempt: event.attempt ?? null,
      parentEventId: event.parentEventId ?? null,
      resourceId: event.resourceId ?? null,
      extra: event.extra ? JSON.stringify(event.extra) : null,
    });
    return info.lastInsertRowid;
  } catch (err) {
    // Deliberately quiet about the row, loud about the fault: losing one
    // event must never turn into a failed run for a student.
    console.error("[progsnap] не удалось записать событие:", err.message);
    return null;
  }
}

// --- the shapes the app actually logs ---------------------------------------

// A run produces up to three events: the compile, a compile error if there was
// one, and the execution. They are linked through ParentEventID so an analysis
// can treat them as one attempt.
function logRun({
  subjectId,
  sessionId,
  assignmentId,
  files,
  entry,
  stdin,
  result,
  interactive = false,
}) {
  if (!ENABLED) return null;
  try {
    const codeStateId = recordCodeState(files, entry);
    const executionId = crypto.randomBytes(8).toString("hex");

    // The platform failed, not the student's code: nothing was compiled and
    // nothing ran, so claiming a Compile and a Run would put a fault of ours
    // into the data as a fault of theirs.
    if (result.status === "Sandbox Error") {
      return logEvent({
        eventType: EventType.X_SANDBOX_ERROR,
        subjectId,
        sessionId,
        assignmentId,
        codeStateId,
        codeStateSection: entry,
        executionId,
        eventInitiator: "ToolReaction",
        programErrorOutput: result.stderr || null,
        extra: {
          "X-SandboxStatus": result.status,
          "X-Interactive": interactive ? "true" : "false",
        },
      });
    }

    const compiled = result.status !== "Compilation Error";

    const compileEventId = logEvent({
      eventType: EventType.COMPILE,
      subjectId,
      sessionId,
      assignmentId,
      codeStateId,
      codeStateSection: entry,
      executionId,
      compileResult: compiled ? "Success" : "Error",
      compileMessageType: compiled ? "Success" : "CompileError",
      compileMessageData: result.compileOutput || null,
    });

    if (!compiled) {
      logEvent({
        eventType: EventType.COMPILE_ERROR,
        subjectId,
        sessionId,
        assignmentId,
        codeStateId,
        codeStateSection: entry,
        executionId,
        parentEventId: compileEventId,
        compileResult: "Error",
        compileMessageType: "CompileError",
        compileMessageData: result.compileOutput || result.stderr || null,
      });
      return compileEventId;
    }

    return logEvent({
      eventType: EventType.RUN_PROGRAM,
      subjectId,
      sessionId,
      assignmentId,
      codeStateId,
      codeStateSection: entry,
      executionId,
      parentEventId: compileEventId,
      executionResult: executionResultFor(result.status),
      programInput: stdin || null,
      programOutput: result.stdout || null,
      programErrorOutput: result.stderr || null,
      extra: {
        "X-SandboxStatus": result.status,
        "X-Interactive": interactive ? "true" : "false",
      },
    });
  } catch (err) {
    console.error("[progsnap] не удалось записать запуск:", err.message);
    return null;
  }
}

// Handing work in, and saving a draft. A draft is not a Submit - the spec's
// Submit means "code was submitted to the system", which here is the moment
// the student says "сдать" - so drafts get a dataset-specific type instead.
function logVersion({
  subjectId,
  sessionId,
  assignmentId,
  submissionId,
  versionNumber,
  files,
  entry,
  status,
}) {
  if (!ENABLED) return null;
  try {
    const codeStateId = recordCodeState(files, entry);
    return logEvent({
      eventType:
        status === "submitted" ? EventType.SUBMIT : EventType.X_DRAFT_SAVE,
      subjectId,
      sessionId,
      assignmentId,
      submissionId,
      codeStateId,
      codeStateSection: entry,
      attempt: versionNumber || null,
    });
  } catch (err) {
    console.error("[progsnap] не удалось записать версию:", err.message);
    return null;
  }
}

// Score is normalised to 0..1 by the specification, and the maximum here can
// differ per study group, so the caller passes the maximum that applied.
function normalizeScore(score, maxScore) {
  if (score === null || score === undefined) return null;
  const max = Number(maxScore);
  if (!Number.isFinite(max) || max <= 0) return null;
  const value = Number(score) / max;
  if (!Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function config() {
  return {
    enabled: ENABLED,
    editCapture: EDIT_CAPTURE,
    editIntervalSeconds: EDIT_INTERVAL_SECONDS,
  };
}

module.exports = {
  EventType,
  EDIT_CAPTURE,
  EDIT_INTERVAL_SECONDS,
  ENABLED,
  MAX_OUTPUT_CHARS,
  config,
  codeStateIdFor,
  recordCodeState,
  logEvent,
  logRun,
  logVersion,
  normalizeScore,
  executionResultFor,
};
