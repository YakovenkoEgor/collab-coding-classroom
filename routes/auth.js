const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("../db/database");
const { requireLogin, requireRole } = require("../middleware/auth");
const { parseCsv, toCsv } = require("../csv");
const { withDeadlineState } = require("../deadlines");

const router = express.Router();

// Passwords are generated for imported students and shown to the teacher
// afterwards, so they are stored in clear text in users.initial_password
// alongside the bcrypt hash used for signing in. That is a deliberate
// trade-off: the teacher has to be able to read the credentials back out to
// hand them over. The clear-text copy is only ever returned to a teacher.
const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PASSWORD_LENGTH = 8;

function generatePassword() {
  const bytes = crypto.randomBytes(PASSWORD_LENGTH);
  let out = "";
  for (let i = 0; i < PASSWORD_LENGTH; i++) {
    out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  }
  return out;
}

// Header names we understand, so a file exported from a spreadsheet works
// whether its first row is a header or already the first student.
const HEADER_WORDS = ["фамилия", "имя", "логин", "почта", "lastname", "firstname", "login", "email"];

function looksLikeHeader(row) {
  return row.some((cell) => HEADER_WORDS.includes(cell.trim().toLowerCase()));
}

function teacherCount() {
  return db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'teacher'").get().c;
}

// Public: lets the login screen decide whether to offer "create a teacher
// account". Deliberately exposes nothing but the yes/no.
router.get("/bootstrap-status", (req, res) => {
  res.json({ teacherExists: teacherCount() > 0 });
});

// Public, but only while the system has no teacher at all - the very first
// account has to come from somewhere. The check and the insert share one
// transaction so two simultaneous requests can't both create a teacher.
router.post("/bootstrap-teacher", (req, res) => {
  const { firstName, lastName, username, email, password } = req.body;

  const first = (firstName || "").trim();
  const last = (lastName || "").trim();
  const login = (username || "").trim();
  const mail = (email || "").trim();

  if (!first || !last || !login || !mail || !password) {
    return res.status(400).json({
      error: "First name, last name, login, email and password are all required",
    });
  }
  if (/\s/.test(login)) {
    return res.status(400).json({ error: "Login must not contain spaces" });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  const displayName = `${first} ${last}`;
  const hash = bcrypt.hashSync(password, 10);

  try {
    const create = db.transaction(() => {
      if (teacherCount() > 0) return null; // someone got here first
      return db
        .prepare(
          `INSERT INTO users
             (username, password_hash, display_name, role, first_name, last_name, email)
           VALUES (?, ?, ?, 'teacher', ?, ?, ?)`
        )
        .run(login, hash, displayName, first, last, mail).lastInsertRowid;
    });

    const id = create();
    if (id === null) {
      return res
        .status(409)
        .json({ error: "A teacher account already exists - please sign in instead" });
    }

    res.json({ user: { id, username: login, displayName, role: "teacher" } });
  } catch (err) {
    if (err.message.includes("UNIQUE")) {
      return res.status(409).json({ error: "Username already exists" });
    }
    throw err;
  }
});

router.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  const user = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
  };

  res.json({ user: req.session.user });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get("/me", (req, res) => {
  res.json({ user: req.session.user || null });
});

// Teacher-only: create a new student (or teacher) account.
// Students are described by first name, last name and study group;
// display_name is stored as the rendered "First Last".
router.post("/users", requireLogin, requireRole("teacher"), (req, res) => {
  const { username, password, firstName, lastName, groupName, email, role } = req.body;

  const login = (username || "").trim();
  const first = (firstName || "").trim();
  const last = (lastName || "").trim();
  const group = (groupName || "").trim();

  if (!login || !password || !first || !last) {
    return res.status(400).json({
      error: "Username, password, first name and last name are required",
    });
  }

  const finalRole = role === "teacher" ? "teacher" : "student";
  const displayName = `${first} ${last}`;
  const hash = bcrypt.hashSync(password, 10);

  try {
    const info = db
      .prepare(
        `INSERT INTO users
           (username, password_hash, display_name, role, first_name, last_name,
            group_name, email, initial_password)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      // The password is kept readable so the teacher can look it up again in
      // the student's profile, same as for CSV-imported students.
      .run(
        login,
        hash,
        displayName,
        finalRole,
        first,
        last,
        group || null,
        (email || "").trim() || null,
        password
      );
    res.json({
      user: {
        id: info.lastInsertRowid,
        username: login,
        displayName,
        firstName: first,
        lastName: last,
        groupName: group || null,
        email: (email || "").trim() || null,
        role: finalRole,
      },
    });
  } catch (err) {
    if (err.message.includes("UNIQUE")) {
      return res.status(409).json({ error: "Username already exists" });
    }
    throw err;
  }
});

// Teacher-only: bulk-create students from CSV.
// Columns: last name, first name, login, email (optional).
// Each student gets a generated password, returned here and readable later
// from their profile.
router.post("/users/import", requireLogin, requireRole("teacher"), (req, res) => {
  const { csv, groupName } = req.body;
  if (typeof csv !== "string" || csv.trim() === "") {
    return res.status(400).json({ error: "CSV content required" });
  }

  let rows;
  try {
    rows = parseCsv(csv);
  } catch {
    return res.status(400).json({ error: "Could not read that file as CSV" });
  }
  if (rows.length === 0) return res.status(400).json({ error: "The file is empty" });
  if (looksLikeHeader(rows[0])) rows = rows.slice(1);
  if (rows.length === 0) {
    return res.status(400).json({ error: "The file has a header but no students" });
  }

  const group = (groupName || "").trim();
  const created = [];
  const errors = [];

  const insert = db.prepare(
    `INSERT INTO users
       (username, password_hash, display_name, role, first_name, last_name,
        group_name, email, initial_password)
     VALUES (?, ?, ?, 'student', ?, ?, ?, ?, ?)`
  );

  rows.forEach((row, index) => {
    const line = index + 1;
    const lastName = (row[0] || "").trim();
    const firstName = (row[1] || "").trim();
    const username = (row[2] || "").trim();
    const email = (row[3] || "").trim();

    if (!lastName || !firstName || !username) {
      errors.push({
        line,
        value: row.join(", ").slice(0, 60),
        error: "Last name, first name and login are all required",
      });
      return;
    }
    if (/\s/.test(username)) {
      errors.push({ line, value: username, error: "Login must not contain spaces" });
      return;
    }

    const password = generatePassword();
    try {
      const info = insert.run(
        username,
        bcrypt.hashSync(password, 10),
        `${firstName} ${lastName}`,
        firstName,
        lastName,
        group || null,
        email || null,
        password
      );
      created.push({
        id: info.lastInsertRowid,
        line,
        username,
        displayName: `${firstName} ${lastName}`,
        email: email || null,
        password,
      });
    } catch (err) {
      errors.push({
        line,
        value: username,
        error: err.message.includes("UNIQUE")
          ? "A user with this login already exists"
          : "Could not create this student",
      });
    }
  });

  res.json({ created, errors, total: rows.length });
});

// Teacher-only: list all students (used for the review dashboard).
router.get("/users", requireLogin, requireRole("teacher"), (req, res) => {
  const users = db
    .prepare(
      `SELECT id, username, display_name AS displayName, role,
              first_name AS firstName, last_name AS lastName,
              group_name AS groupName
       FROM users WHERE role = 'student'
       ORDER BY group_name IS NULL, group_name, last_name, first_name`
    )
    .all();
  res.json({ users });
});

// Teacher-only: the class roster as CSV, credentials included, for handing
// out logins. Registered before "/users/:id" so "export.csv" isn't read as an
// id.
//
// This file contains passwords in clear text - the same ones the teacher can
// already read in a student's profile, since that is the point of storing
// them (see the note next to PASSWORD_ALPHABET). Treat the download as a
// sensitive document.
router.get("/users/export.csv", requireLogin, requireRole("teacher"), (req, res) => {
  const students = db
    .prepare(
      `SELECT first_name AS firstName, last_name AS lastName, username,
              initial_password AS initialPassword
       FROM users WHERE role = 'student'
       ORDER BY group_name IS NULL, group_name, last_name, first_name`
    )
    .all();

  const rows = [["Имя", "Фамилия", "Логин", "Пароль"]];
  for (const s of students) {
    rows.push([
      s.firstName || "",
      s.lastName || "",
      s.username,
      // Accounts created before passwords were kept have nothing to show.
      s.initialPassword || "",
    ]);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="students-${stamp}.csv"`);
  res.send(toCsv(rows));
});

// Teacher-only: one student's profile plus their standing in every
// assignment - status, last activity and grade.
router.get("/users/:id", requireLogin, requireRole("teacher"), (req, res) => {
  const student = db
    .prepare(
      `SELECT id, username, display_name AS displayName, role,
              first_name AS firstName, last_name AS lastName,
              group_name AS groupName, email, created_at AS createdAt,
              initial_password AS initialPassword
       FROM users WHERE id = ? AND role = 'student'`
    )
    .get(req.params.id);
  if (!student) return res.status(404).json({ error: "Student not found" });

  const assignments = db
    .prepare(
      `SELECT a.id AS assignmentId, a.title, a.archived, a.deadline,
              s.version_number AS latestVersion, s.status,
              s.created_at AS lastActivity,
              g.score, g.feedback,
              -- Has the student actually handed anything in for this one?
              EXISTS (
                SELECT 1 FROM submissions sub
                WHERE sub.assignment_id = a.id AND sub.student_id = ?
                  AND sub.status = 'submitted'
              ) AS hasSubmitted
       FROM assignments a
       LEFT JOIN submissions s
         ON s.assignment_id = a.id
        AND s.id = (
              SELECT MAX(id) FROM submissions
              WHERE assignment_id = a.id AND student_id = ?
            )
       LEFT JOIN grades g ON g.assignment_id = a.id AND g.student_id = ?
       ORDER BY a.created_at DESC`
    )
    .all(req.params.id, req.params.id, req.params.id);

  res.json({ student, assignments: assignments.map(withDeadlineState) });
});

module.exports = router;
