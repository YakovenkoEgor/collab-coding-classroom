const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const db = require("../db/database");
const progsnap = require("../progsnap");
const { requireLogin, requireRole } = require("../middleware/auth");
const { parseCsv, toCsv } = require("../csv");
const { withDeadlineState } = require("../deadlines");
const rules = require("../assignmentRules");
const storage = require("../storage");

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
      error: "Имя, фамилия, логин, почта и пароль обязательны",
    });
  }
  if (/\s/.test(login)) {
    return res.status(400).json({ error: "Логин не должен содержать пробелов" });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: "Пароль должен быть не короче 6 символов" });
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
        .json({ error: "Учётная запись преподавателя уже существует — войдите в неё" });
    }

    res.json({ user: { id, username: login, displayName, role: "teacher" } });
  } catch (err) {
    if (err.message.includes("UNIQUE")) {
      return res.status(409).json({ error: "Такой логин уже занят" });
    }
    throw err;
  }
});

router.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Укажите логин и пароль" });
  }

  const user = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Неверный логин или пароль" });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
  };

  // Process data: a work session starts here. Only students are logged -
  // the dataset is about how students work, and the teacher's own clicking
  // around is not part of it.
  if (user.role === "student") {
    progsnap.logEvent({
      eventType: progsnap.EventType.SESSION_START,
      subjectId: user.id,
      sessionId: req.sessionID,
    });
  }

  res.json({ user: req.session.user });
});

router.post("/logout", (req, res) => {
  // Logged before the session is destroyed - afterwards there is no id left
  // to attach the event to. A session that simply expires leaves no
  // Session.End, which the exported README spells out.
  const user = req.session.user;
  if (user && user.role === "student") {
    progsnap.logEvent({
      eventType: progsnap.EventType.SESSION_END,
      subjectId: user.id,
      sessionId: req.sessionID,
    });
  }
  req.session.destroy(() => res.json({ ok: true }));
});

// Who is logged in. The session carries enough to render the top bar; the
// name, group and e-mail are read from the database, because a student's own
// dashboard shows them and they can change while a session is open. The
// stored password is deliberately not among them.
router.get("/me", (req, res) => {
  if (!req.session.user) return res.json({ user: null });

  const row = db
    .prepare(
      `SELECT first_name AS firstName, last_name AS lastName,
              group_name AS groupName, email
       FROM users WHERE id = ?`
    )
    .get(req.session.user.id);

  res.json({ user: { ...req.session.user, ...(row || {}) } });
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
      error: "Логин, пароль, имя и фамилия обязательны",
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
      return res.status(409).json({ error: "Такой логин уже занят" });
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
    return res.status(400).json({ error: "Нужно содержимое CSV-файла" });
  }

  let rows;
  try {
    rows = parseCsv(csv);
  } catch {
    return res.status(400).json({ error: "Не удалось прочитать файл как CSV" });
  }
  if (rows.length === 0) return res.status(400).json({ error: "Файл пуст" });
  if (looksLikeHeader(rows[0])) rows = rows.slice(1);
  if (rows.length === 0) {
    return res.status(400).json({ error: "В файле есть заголовок, но нет учеников" });
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
        error: "Фамилия, имя и логин обязательны",
      });
      return;
    }
    if (/\s/.test(username)) {
      errors.push({ line, value: username, error: "Логин не должен содержать пробелов" });
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
        firstName,
        lastName,
        email: email || null,
        password,
      });
    } catch (err) {
      errors.push({
        line,
        value: username,
        error: err.message.includes("UNIQUE")
          ? "Пользователь с таким логином уже существует"
          : "Не удалось создать этого ученика",
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
              group_name AS groupName, email
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

  // Surname first, the same order the teacher sees on screen.
  const rows = [["Фамилия", "Имя", "Логин", "Пароль"]];
  for (const s of students) {
    rows.push([
      s.lastName || "",
      s.firstName || "",
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
// Teacher-only: change a student's details. Every field the platform keeps
// about them can be edited here; a blank password field leaves the current
// one alone, so changing a surname does not reset a login.
router.put("/users/:id", requireLogin, requireRole("teacher"), (req, res) => {
  const student = db
    .prepare("SELECT * FROM users WHERE id = ? AND role = 'student'")
    .get(req.params.id);
  if (!student) return res.status(404).json({ error: "Ученик не найден" });

  const login = (req.body.username || "").trim();
  const first = (req.body.firstName || "").trim();
  const last = (req.body.lastName || "").trim();
  const group = (req.body.groupName || "").trim();
  const email = (req.body.email || "").trim();
  const password = typeof req.body.password === "string" ? req.body.password : "";

  if (!login || !first || !last) {
    return res.status(400).json({ error: "Логин, имя и фамилия обязательны" });
  }
  if (/\s/.test(login)) {
    return res.status(400).json({ error: "Логин не должен содержать пробелов" });
  }
  if (password && password.length < 6) {
    return res.status(400).json({ error: "Пароль должен быть не короче 6 символов" });
  }

  try {
    db.prepare(
      `UPDATE users
       SET username = ?, first_name = ?, last_name = ?, display_name = ?,
           group_name = ?, email = ?
       WHERE id = ?`
    ).run(login, first, last, `${first} ${last}`, group || null, email || null, student.id);

    if (password) {
      // initial_password is kept readable on purpose - it is what the teacher
      // reads back out of the profile to hand to the student. Setting a new
      // password replaces both, so the two never disagree.
      db.prepare(
        "UPDATE users SET password_hash = ?, initial_password = ? WHERE id = ?"
      ).run(bcrypt.hashSync(password, 10), password, student.id);
    }
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "Такой логин уже занят" });
    }
    throw err;
  }

  res.json({
    user: db
      .prepare(
        `SELECT id, username, display_name AS displayName, role,
                first_name AS firstName, last_name AS lastName,
                group_name AS groupName, email,
                initial_password AS initialPassword
         FROM users WHERE id = ?`
      )
      .get(student.id),
  });
});

// Teacher-only: delete a student and everything that belongs to them.
//
// This is the one destructive action in the app, so it takes the student's
// own login as confirmation: a misplaced click cannot remove a term of work.
// Children go before parents, the same order scripts/clear-classroom-data.js
// uses, because foreign keys are on.
router.delete("/users/:id", requireLogin, requireRole("teacher"), (req, res) => {
  const student = db
    .prepare("SELECT * FROM users WHERE id = ? AND role = 'student'")
    .get(req.params.id);
  if (!student) return res.status(404).json({ error: "Ученик не найден" });

  if ((req.body.confirmUsername || "").trim() !== student.username) {
    return res.status(400).json({
      error: `Для удаления подтвердите логин ученика: ${student.username}`,
    });
  }

  // Files on disk are removed after the transaction commits - a failed delete
  // must not leave the database pointing at files that are already gone.
  const uploads = db
    .prepare("SELECT stored_name AS storedName FROM submission_uploads WHERE student_id = ?")
    .all(student.id);

  const remove = db.transaction(() => {
    db.prepare(
      `DELETE FROM messages
       WHERE discussion_id IN (SELECT id FROM discussions WHERE student_id = ?)`
    ).run(student.id);
    db.prepare("DELETE FROM discussions WHERE student_id = ?").run(student.id);
    db.prepare(
      `DELETE FROM test_answers
       WHERE attempt_id IN (SELECT id FROM test_attempts WHERE student_id = ?)`
    ).run(student.id);
    db.prepare("DELETE FROM test_attempts WHERE student_id = ?").run(student.id);
    db.prepare(
      `DELETE FROM submission_files
       WHERE submission_id IN (SELECT id FROM submissions WHERE student_id = ?)`
    ).run(student.id);
    db.prepare("DELETE FROM submissions WHERE student_id = ?").run(student.id);
    db.prepare("DELETE FROM submission_uploads WHERE student_id = ?").run(student.id);
    db.prepare("DELETE FROM grades WHERE student_id = ?").run(student.id);
    // Their process data goes with them. The code snapshots it pointed at are
    // content-addressed and shared, so they stay; an export only ever carries
    // the ones its own events reference.
    db.prepare("DELETE FROM events WHERE subject_id = ?").run(student.id);
    db.prepare("DELETE FROM users WHERE id = ?").run(student.id);
  });
  remove();

  let removedFiles = 0;
  for (const upload of uploads) {
    const full = storage.pathForStoredName(upload.storedName);
    if (full && fs.existsSync(full)) {
      fs.rmSync(full, { force: true });
      removedFiles++;
    }
  }

  res.json({ ok: true, removedFiles });
});

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
  if (!student) return res.status(404).json({ error: "Ученик не найден" });

  const assignments = db
    .prepare(
      // The deadline and top mark are this student's group's and nothing
      // else's; neither set means the assignment was not given to that group
      // (see assignmentRules.js).
      `SELECT a.id AS assignmentId, a.title, a.archived,
              r.deadline AS deadline,
              r.max_score AS maxScore,
              CASE WHEN r.deadline IS NOT NULL OR r.max_score IS NOT NULL
                   THEN 1 ELSE 0 END AS isActive,
              s.version_number AS latestVersion, s.status,
              s.created_at AS lastActivity,
              g.score, g.feedback,
              a.type,
              -- Has the student actually handed anything in for this one?
              CASE WHEN a.type = 'test'
                THEN EXISTS (
                  SELECT 1 FROM test_attempts t
                  WHERE t.assignment_id = a.id AND t.student_id = ?
                    AND t.submitted_at IS NOT NULL
                )
                ELSE EXISTS (
                  SELECT 1 FROM submissions sub
                  WHERE sub.assignment_id = a.id AND sub.student_id = ?
                    AND sub.status = 'submitted'
                )
              END AS hasSubmitted
       FROM assignments a
       ${rules.RULE_JOIN_FOR_STUDENT}
       LEFT JOIN submissions s
         ON s.assignment_id = a.id
        AND s.id = (
              SELECT MAX(id) FROM submissions
              WHERE assignment_id = a.id AND student_id = ?
            )
       LEFT JOIN grades g ON g.assignment_id = a.id AND g.student_id = ?
       ORDER BY a.created_at DESC`
    )
    // hasSubmitted (two branches), the group-rule join, the latest-submission
    // sub-query and the grade join - all the same student.
    .all(
      req.params.id,
      req.params.id,
      req.params.id,
      req.params.id,
      req.params.id
    );

  res.json({ student, assignments: assignments.map(withDeadlineState) });
});

module.exports = router;
