const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

// DB_PATH lets you point at a throwaway copy (handy for trying a migration
// before it touches the real classroom.db).
const dbPath = process.env.DB_PATH || path.join(__dirname, "..", "classroom.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ---------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assignments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  starter_code TEXT NOT NULL DEFAULT '',
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  archived    INTEGER NOT NULL DEFAULT 0,
  max_score   INTEGER NOT NULL DEFAULT 15
);

-- Every time a student saves/submits, we store a new version row.
-- This gives a full history per (assignment, student), and lets
-- discussion messages link back to a specific version.
CREATE TABLE IF NOT EXISTS submissions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id   INTEGER NOT NULL REFERENCES assignments(id),
  student_id      INTEGER NOT NULL REFERENCES users(id),
  version_number  INTEGER NOT NULL,
  -- Optional name the student gave this version ("цикл работает", "перед сдачей").
  -- Empty means the version is shown by its number alone.
  title           TEXT NOT NULL DEFAULT '',
  code            TEXT NOT NULL,
  stdin           TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  last_run_stdout TEXT,
  last_run_stderr TEXT,
  last_run_status TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(assignment_id, student_id, version_number)
);

-- The starter project a teacher hands out with an assignment: the files a
-- student's editor is pre-filled with. Separate from assignment_files, which
-- holds downloadable handouts (PDF/DOCX), not source code.
-- assignments.starter_code mirrors the entry file so older screens still work.
CREATE TABLE IF NOT EXISTS assignment_starter_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  filename      TEXT NOT NULL,
  content       TEXT NOT NULL,
  encoding      TEXT NOT NULL DEFAULT 'text',
  is_entry      INTEGER NOT NULL DEFAULT 0,
  UNIQUE(assignment_id, filename)
);

-- Files a student attaches to a free-form assignment. Deliberately not
-- versioned: the student adds, replaces and removes them at will, within the
-- limits in storage.js. Code and text assignments use submissions instead.
CREATE TABLE IF NOT EXISTS submission_uploads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  student_id    INTEGER NOT NULL REFERENCES users(id),
  original_name TEXT NOT NULL,
  stored_name   TEXT NOT NULL UNIQUE,
  size_bytes    INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(assignment_id, student_id, original_name)
);

-- Files belonging to one submission version. A version is a snapshot of the
-- whole project, so every version owns its own full set of rows.
-- submissions.code still holds the entry file's source, which keeps the older
-- single-file screens and queries working unchanged.
-- A project holds Java sources and the data files the program reads and
-- writes. A text file is stored as it is; anything else (a serialised object,
-- say) is stored base64 with encoding = 'base64' - see projectFiles.js.
CREATE TABLE IF NOT EXISTS submission_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  filename      TEXT NOT NULL,
  content       TEXT NOT NULL,
  encoding      TEXT NOT NULL DEFAULT 'text',
  is_entry      INTEGER NOT NULL DEFAULT 0,
  UNIQUE(submission_id, filename)
);

-- Per-study-group exceptions to an assignment's deadline and top mark.
-- A row overrides only the fields it fills in; NULL means "use the
-- assignment's own value". Groups without a row here follow the assignment,
-- and so do students who belong to no group.
CREATE TABLE IF NOT EXISTS assignment_group_rules (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  group_name    TEXT NOT NULL,
  deadline      TEXT,
  max_score     INTEGER,
  PRIMARY KEY (assignment_id, group_name)
);

-- One discussion thread per (assignment, student) pair.
CREATE TABLE IF NOT EXISTS discussions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  student_id    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(assignment_id, student_id)
);

-- Messages within a discussion. Optionally references a specific
-- submission version so a comment can point at exact code.
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  discussion_id   INTEGER NOT NULL REFERENCES discussions(id),
  author_id       INTEGER NOT NULL REFERENCES users(id),
  body            TEXT NOT NULL,
  submission_id   INTEGER REFERENCES submissions(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Teacher-uploaded handouts attached to an assignment (PDF, DOCX, ...).
-- The bytes live on disk under uploads/; only metadata is stored here.
CREATE TABLE IF NOT EXISTS assignment_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  original_name TEXT NOT NULL,
  stored_name   TEXT NOT NULL UNIQUE,
  size_bytes    INTEGER NOT NULL,
  uploaded_by   INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Class-wide announcements the teacher writes. Each one is shown to students
-- until active_until passes; nothing is deleted when it expires, so the
-- teacher can still see what was announced.
CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  body         TEXT NOT NULL,
  active_until TEXT NOT NULL,
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Test assignments: a list of questions the student answers in one sitting.
-- Two kinds, set on the assignment: 'graded' has correct answers and is
-- marked, 'survey' has none and is never scored (see assignments.test_kind).
CREATE TABLE IF NOT EXISTS test_questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  position      INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('single', 'multiple', 'open')),
  body          TEXT NOT NULL,
  -- Open questions only, and optional even there: with an expected answer the
  -- question is checked automatically, without one it waits for the teacher.
  expected_answer TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS test_options (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES test_questions(id),
  position    INTEGER NOT NULL,
  body        TEXT NOT NULL,
  is_correct  INTEGER NOT NULL DEFAULT 0
);

-- One attempt per student per test. started_at is what the countdown runs
-- from; submitted_at is set when the student hands it in or the time runs out.
CREATE TABLE IF NOT EXISTS test_attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  student_id    INTEGER NOT NULL REFERENCES users(id),
  -- UTC, like every other timestamp in this database. The window the test is
  -- open in (available_from / deadline) is the other thing entirely: those
  -- are local-time strings a teacher typed.
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at  TEXT,
  UNIQUE(assignment_id, student_id)
);

-- Answers are saved as the student works, so whatever is recorded here is
-- what gets handed in when the clock stops.
CREATE TABLE IF NOT EXISTS test_answers (
  attempt_id  INTEGER NOT NULL REFERENCES test_attempts(id),
  question_id INTEGER NOT NULL REFERENCES test_questions(id),
  -- Chosen options as a comma-separated list of ids; empty for open answers.
  option_ids  TEXT NOT NULL DEFAULT '',
  text_answer TEXT NOT NULL DEFAULT '',
  answered_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (attempt_id, question_id)
);

-- Process data in the ProgSnap2 sense: an append-only log of what happened
-- while a student worked, so the course can be analysed afterwards (and the
-- data shared in a standard format - see progsnap.js and
-- scripts/export-progsnap2.js). Column names follow the specification so the
-- export is a straight copy rather than a translation.
--
-- Nothing here is ever updated or deleted by the app: a row is a statement
-- that something happened at a moment in time.
CREATE TABLE IF NOT EXISTS events (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,  -- EventID
  event_type           TEXT NOT NULL,                      -- EventType
  subject_id           INTEGER REFERENCES users(id),       -- resolved to a surrogate key on export
  session_id           TEXT,                               -- SessionID
  assignment_id        INTEGER REFERENCES assignments(id), -- AssignmentID
  submission_id        INTEGER,                            -- which version, when there is one
  code_state_id        TEXT,                               -- CodeStateID (content hash)
  code_state_section   TEXT,                               -- CodeStateSection: the file a File.* event is about
  server_timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
  client_timestamp     TEXT,                               -- ClientTimestamp, for events the browser reports
  event_initiator      TEXT,                               -- EventInitiator
  edit_type            TEXT,                               -- EditType
  compile_result       TEXT,                               -- CompileResult
  compile_message_type TEXT,                               -- CompileMessageType
  compile_message_data TEXT,                               -- CompileMessageData
  execution_id         TEXT,                               -- ExecutionID
  execution_result     TEXT,                               -- ExecutionResult
  program_input        TEXT,                               -- ProgramInput
  program_output       TEXT,                               -- ProgramOutput
  program_error_output TEXT,                               -- ProgramErrorOutput
  score                REAL,                               -- Score, normalised 0..1
  attempt              INTEGER,                            -- Attempt
  parent_event_id      INTEGER REFERENCES events(id),      -- ParentEventID
  resource_id          TEXT,                               -- ResourceID
  extra                TEXT                                -- JSON for dataset-specific X- columns
);

CREATE INDEX IF NOT EXISTS idx_events_subject ON events(subject_id, id);
CREATE INDEX IF NOT EXISTS idx_events_assignment ON events(assignment_id, id);

-- Snapshots the events point at, stored once per distinct content: a student
-- pressing Run twice without editing anything produces one code state, not two.
CREATE TABLE IF NOT EXISTS event_code_states (
  code_state_id TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS event_code_state_files (
  code_state_id TEXT NOT NULL REFERENCES event_code_states(code_state_id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  content       TEXT NOT NULL,
  encoding      TEXT NOT NULL DEFAULT 'text',
  is_entry      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (code_state_id, filename)
);

CREATE TABLE IF NOT EXISTS grades (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  student_id    INTEGER NOT NULL REFERENCES users(id),
  score         REAL,
  feedback      TEXT NOT NULL DEFAULT '',
  graded_by     INTEGER REFERENCES users(id),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (assignment_id, student_id)
);
`);

// ---------------------------------------------------------------------
// Migrations
//
// The CREATE TABLE statements above only run on a fresh database, so
// columns added later have to be patched onto existing installs here.
// Each step checks first, which makes this safe to run on every startup.
// ---------------------------------------------------------------------
function columnNames(table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

// Students are now stored as first name / last name / study group instead of
// a single display name. display_name is kept as the rendered "First Last"
// so existing queries and screens keep working.
// email: optional, imported from CSV.
// initial_password: the generated password, kept in clear text so the teacher
// can read it back out of the student's profile and pass it on. See the note
// in routes/auth.js - it is only ever sent to a teacher.
const userColumns = columnNames("users");
const addedUserColumns = [];
for (const col of ["first_name", "last_name", "group_name", "email", "initial_password"]) {
  if (!userColumns.includes(col)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
    addedUserColumns.push(col);
  }
}

if (addedUserColumns.length > 0) {
  // Backfill from display_name: everything before the first space is the
  // first name, the rest is the last name.
  db.exec(`
    UPDATE users
    SET first_name = CASE
          WHEN instr(display_name, ' ') > 0
          THEN substr(display_name, 1, instr(display_name, ' ') - 1)
          ELSE display_name
        END,
        last_name = CASE
          WHEN instr(display_name, ' ') > 0
          THEN substr(display_name, instr(display_name, ' ') + 1)
          ELSE ''
        END
    WHERE first_name IS NULL
  `);
  console.log(
    `[db] migrated users table: added ${addedUserColumns.join(", ")}`
  );
}

// A surrogate key for every student, used as SubjectID in exported process
// data. It is random, carries no personal data, and is deliberately not
// derived from the login, the name or the database id - so an exported
// dataset cannot be traced back to a person without this table, which is
// never part of an export.
if (!columnNames("users").includes("subject_key")) {
  db.exec("ALTER TABLE users ADD COLUMN subject_key TEXT");
  console.log("[db] migrated users table: added subject_key");
}

// Unique rather than merely random: a collision would silently merge two
// students' work in an analysis.
db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_subject_key ON users(subject_key)"
);

// A trigger rather than a column default, so every way of creating a user -
// the bootstrap teacher, the add-student form, the CSV import, a future one -
// gets a key without having to remember to ask for one.
db.exec(`
  CREATE TRIGGER IF NOT EXISTS users_subject_key_after_insert
  AFTER INSERT ON users
  WHEN NEW.subject_key IS NULL OR NEW.subject_key = ''
  BEGIN
    UPDATE users SET subject_key = lower(hex(randomblob(10))) WHERE id = NEW.id;
  END;
`);

function newSubjectKey() {
  // 16 bytes of base32-ish text: short enough to read in a CSV, wide enough
  // that keys never collide, and safe as a directory name.
  return crypto.randomBytes(10).toString("hex");
}

{
  const missing = db
    .prepare("SELECT id FROM users WHERE subject_key IS NULL OR subject_key = ''")
    .all();
  if (missing.length > 0) {
    const assign = db.prepare("UPDATE users SET subject_key = ? WHERE id = ?");
    const fill = db.transaction((rows) => {
      for (const row of rows) assign.run(newSubjectKey(), row.id);
    });
    fill(missing);
    console.log(`[db] assigned a subject key to ${missing.length} user(s)`);
  }
}

// Submissions predating multi-file projects have their source only in
// submissions.code. Give each of them a single Main.java entry file so every
// version looks the same to the rest of the app.
const legacySubmissions = db
  .prepare(
    `SELECT s.id, s.code FROM submissions s
     WHERE NOT EXISTS (SELECT 1 FROM submission_files f WHERE f.submission_id = s.id)`
  )
  .all();

if (legacySubmissions.length > 0) {
  const insert = db.prepare(
    `INSERT INTO submission_files (submission_id, filename, content, is_entry)
     VALUES (?, 'Main.java', ?, 1)`
  );
  const migrate = db.transaction((rows) => {
    for (const row of rows) insert.run(row.id, row.code);
  });
  migrate(legacySubmissions);
  console.log(
    `[db] migrated ${legacySubmissions.length} single-file submission(s) to Main.java`
  );
}

// Assignment kind: 'code' (Java project), 'text' (written answer, versioned
// the same way) or 'freeform' (arbitrary attached files, not versioned).
// Everything that existed before multi-type support is a code assignment.
if (!columnNames("assignments").includes("type")) {
  db.exec("ALTER TABLE assignments ADD COLUMN type TEXT NOT NULL DEFAULT 'code'");
  console.log("[db] migrated assignments table: added type");
}

// Console input the student supplied for this version. Programs that read
// with java.util.Scanner need it, and keeping it alongside the version means
// the teacher sees the run under the same input the student used.
if (!columnNames("submissions").includes("stdin")) {
  db.exec("ALTER TABLE submissions ADD COLUMN stdin TEXT NOT NULL DEFAULT ''");
  console.log("[db] migrated submissions table: added stdin");
}

// How a project file's content is stored: 'text' as written, 'base64' for a
// file that isn't text (a serialised object, for instance). Everything that
// existed before data files were allowed is Java source, so it is text.
for (const table of ["submission_files", "assignment_starter_files"]) {
  if (!columnNames(table).includes("encoding")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN encoding TEXT NOT NULL DEFAULT 'text'`);
    console.log(`[db] migrated ${table}: added encoding`);
  }
}

// Test assignments carry three extra settings:
//   test_kind           'graded' (checked and marked) or 'survey' (neither)
//   available_from      the test cannot be started before this; NULL means
//                       "as soon as it exists" (assignments.deadline is the
//                       other end of the window)
//   time_limit_minutes  how long one attempt may last once started
//
// network_access: 1 when a run of this assignment may reach the file mirror
// (see mirror.js). Off by default - the sandbox has no network at all.
for (const [col, type] of [
  ["test_kind", "TEXT"],
  ["available_from", "TEXT"],
  ["time_limit_minutes", "INTEGER"],
  ["network_access", "INTEGER NOT NULL DEFAULT 0"],
]) {
  if (!columnNames("assignments").includes(col)) {
    db.exec(`ALTER TABLE assignments ADD COLUMN ${col} ${type}`);
    console.log(`[db] migrated assignments table: added ${col}`);
  }
}

// A student-chosen name for a version, so a draft can be found by what it is
// rather than by its number. Versions saved before this keep an empty name.
if (!columnNames("submissions").includes("title")) {
  db.exec("ALTER TABLE submissions ADD COLUMN title TEXT NOT NULL DEFAULT ''");
  console.log("[db] migrated submissions table: added title");
}

// Top mark for an assignment. 15 was hard-coded everywhere before this, so
// that is what existing assignments keep.
if (!columnNames("assignments").includes("max_score")) {
  db.exec("ALTER TABLE assignments ADD COLUMN max_score INTEGER NOT NULL DEFAULT 15");
  console.log("[db] migrated assignments table: added max_score");
}

// Optional due date for an assignment, stored as an ISO-ish
// "YYYY-MM-DD HH:MM" string so it compares correctly with datetime('now').
if (!columnNames("assignments").includes("deadline")) {
  db.exec("ALTER TABLE assignments ADD COLUMN deadline TEXT");
  console.log("[db] migrated assignments table: added deadline");
}

// Assignments created before starter projects keep their starter in
// assignments.starter_code. Give each one a Main.java entry file to match.
const legacyStarters = db
  .prepare(
    `SELECT a.id, a.starter_code FROM assignments a
     WHERE NOT EXISTS (
       SELECT 1 FROM assignment_starter_files f WHERE f.assignment_id = a.id
     )`
  )
  .all();

if (legacyStarters.length > 0) {
  const insert = db.prepare(
    `INSERT INTO assignment_starter_files (assignment_id, filename, content, is_entry)
     VALUES (?, 'Main.java', ?, 1)`
  );
  const migrate = db.transaction((rows) => {
    for (const row of rows) insert.run(row.id, row.starter_code || "");
  });
  migrate(legacyStarters);
  console.log(
    `[db] migrated ${legacyStarters.length} assignment starter(s) to Main.java`
  );
}

db.newSubjectKey = newSubjectKey;

module.exports = db;
