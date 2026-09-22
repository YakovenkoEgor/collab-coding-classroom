// Removes all student accounts and all assignments, with everything that
// hangs off them: submissions and their files, discussions and messages,
// grades, starter projects, and uploaded handouts (rows and files on disk).
//
// Teacher accounts are kept by default, so you can still sign in afterwards.
// Pass --all-users to remove them too: the login screen then offers to create
// the first teacher again.
//
//   npm run reset -- --yes
//   npm run reset -- --yes --all-users
//
// Takes a backup first unless --skip-backup is passed. Without --yes it only
// reports what it would delete.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const args = process.argv.slice(2);
const confirmed = args.includes("--yes");
const skipBackup = args.includes("--skip-backup");
const allUsers = args.includes("--all-users");

if (confirmed && !skipBackup) {
  console.log("Taking a backup first...\n");
  require("./backup-db").backup();
  console.log("");
}

const db = require("../db/database");
const storage = require("../storage");

const counts = {
  students: db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'student'").get().c,
  assignments: db.prepare("SELECT COUNT(*) c FROM assignments").get().c,
  submissions: db.prepare("SELECT COUNT(*) c FROM submissions").get().c,
  submission_files: db.prepare("SELECT COUNT(*) c FROM submission_files").get().c,
  discussions: db.prepare("SELECT COUNT(*) c FROM discussions").get().c,
  messages: db.prepare("SELECT COUNT(*) c FROM messages").get().c,
  grades: db.prepare("SELECT COUNT(*) c FROM grades").get().c,
  assignment_files: db.prepare("SELECT COUNT(*) c FROM assignment_files").get().c,
  assignment_starter_files: db
    .prepare("SELECT COUNT(*) c FROM assignment_starter_files")
    .get().c,
  assignment_group_rules: db
    .prepare("SELECT COUNT(*) c FROM assignment_group_rules")
    .get().c,
  submission_uploads: db.prepare("SELECT COUNT(*) c FROM submission_uploads").get().c,
};

const teachers = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'teacher'").get().c;
counts[allUsers ? "teachers_DELETED" : "teachers_kept"] = teachers;

console.log("About to delete:");
for (const [name, count] of Object.entries(counts)) {
  console.log(`  ${name.padEnd(26)} ${count}`);
}

if (!confirmed) {
  console.log("\nNothing was deleted. Re-run with --yes to go ahead.");
  process.exit(0);
}

// Handouts and student attachments live on disk; collect their names before
// the rows go away.
const storedNames = db
  .prepare(
    `SELECT stored_name FROM assignment_files
     UNION ALL
     SELECT stored_name FROM submission_uploads`
  )
  .all();

// Children before parents - foreign keys are enforced.
const wipe = db.transaction(() => {
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM discussions").run();
  db.prepare("DELETE FROM submission_files").run();
  db.prepare("DELETE FROM submissions").run();
  db.prepare("DELETE FROM grades").run();
  db.prepare("DELETE FROM assignment_files").run();
  db.prepare("DELETE FROM assignment_starter_files").run();
  db.prepare("DELETE FROM assignment_group_rules").run();
  db.prepare("DELETE FROM submission_uploads").run();
  db.prepare("DELETE FROM assignments").run();
  if (allUsers) {
    // grades.graded_by and assignment_files.uploaded_by point at teachers, so
    // those rows are already gone by this point.
    db.prepare("DELETE FROM users").run();
  } else {
    db.prepare("DELETE FROM users WHERE role = 'student'").run();
  }
});

wipe();

let removedFiles = 0;
for (const row of storedNames) {
  const full = storage.pathForStoredName(row.stored_name);
  if (full && fs.existsSync(full)) {
    fs.rmSync(full, { force: true });
    removedFiles++;
  }
}

console.log("\nDone.");
console.log(`  handout files removed from disk: ${removedFiles}`);
if (allUsers) {
  console.log("  no accounts left - the login screen will offer to create the first teacher");
}
console.log("Remaining:");
for (const table of [
  "users",
  "assignments",
  "submissions",
  "submission_files",
  "discussions",
  "messages",
  "grades",
  "assignment_files",
  "assignment_starter_files",
  "assignment_group_rules",
  "submission_uploads",
]) {
  console.log(
    `  ${table.padEnd(26)} ${db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c}`
  );
}
