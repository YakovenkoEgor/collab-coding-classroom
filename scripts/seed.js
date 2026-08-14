// Run with: npm run seed
// Creates one teacher account and a couple of sample student accounts.
// Edit the values below before running, or just change passwords after.

const bcrypt = require("bcryptjs");
const db = require("../db/database");

function upsertUser(username, password, displayName, role) {
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) {
    console.log(`User '${username}' already exists, skipping.`);
    return;
  }
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)"
  ).run(username, hash, displayName, role);
  console.log(`Created ${role}: ${username} / ${password}`);
}

upsertUser("teacher", "teacher123", "Ms. Teacher", "teacher");
upsertUser("student1", "student123", "Alex Student", "student");
upsertUser("student2", "student123", "Sam Student", "student");

console.log("\nDone. Log in at the app with the credentials above, then");
console.log("change passwords / add real students via the teacher dashboard.");
