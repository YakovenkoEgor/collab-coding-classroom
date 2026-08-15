const path = require("path");
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
  archived    INTEGER NOT NULL DEFAULT 0
);

-- Every time a student saves/submits, we store a new version row.
-- This gives a full history per (assignment, student), and lets
-- discussion messages link back to a specific version.
CREATE TABLE IF NOT EXISTS submissions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id   INTEGER NOT NULL REFERENCES assignments(id),
  student_id      INTEGER NOT NULL REFERENCES users(id),
  version_number  INTEGER NOT NULL,
  code            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  last_run_stdout TEXT,
  last_run_stderr TEXT,
  last_run_status TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(assignment_id, student_id, version_number)
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
const userColumns = columnNames("users");
const addedUserColumns = [];
for (const col of ["first_name", "last_name", "group_name"]) {
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

module.exports = db;
