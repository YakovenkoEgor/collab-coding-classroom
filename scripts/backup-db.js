// Snapshots the database into backups/<timestamp>/.
//
//   npm run backup
//
// Writes two things:
//   raw/       a byte copy of classroom.db (plus -wal/-shm) taken before the
//              app has a chance to migrate anything - restore by copying back
//   tables/    one JSON file per table, readable without SQLite
//
// The raw copy happens first, deliberately: requiring db/database.js runs the
// startup migrations, and a backup should capture the state as it was.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BACKUP_ROOT = path.join(ROOT, "backups");

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

function backup() {
  const dir = path.join(BACKUP_ROOT, timestamp());
  const rawDir = path.join(dir, "raw");
  const tablesDir = path.join(dir, "tables");
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(tablesDir, { recursive: true });

  // ---- 1. raw database files, before any migration runs ----
  const dbPath = process.env.DB_PATH || path.join(ROOT, "classroom.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = dbPath + suffix;
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(rawDir, path.basename(source)));
    }
  }
  console.log(`raw database copied to ${path.relative(ROOT, rawDir)}`);

  // ---- 2. table dumps ----
  const db = require("../db/database");
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((t) => t.name);

  const summary = {};
  for (const table of tables) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    fs.writeFileSync(
      path.join(tablesDir, `${table}.json`),
      JSON.stringify(rows, null, 2),
      "utf8"
    );
    summary[table] = rows.length;
  }

  fs.writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify({ takenAt: new Date().toISOString(), rowCounts: summary }, null, 2),
    "utf8"
  );

  console.log("rows per table:");
  for (const [table, count] of Object.entries(summary)) {
    console.log(`  ${table.padEnd(24)} ${count}`);
  }
  console.log(`\nBackup written to ${path.relative(ROOT, dir)}`);
  return dir;
}

if (require.main === module) backup();

module.exports = { backup };
