// Snapshots the database and the uploaded files into one archive.
//
//   npm run backup
//   npm run backup -- --keep 20      how many archives to keep (default 10)
//   npm run backup -- --no-archive   leave the folder, don't pack it
//
// Writes backups/classroom-<timestamp>.tar.gz holding:
//   classroom.db   the database, snapshotted with VACUUM INTO
//   tables/*.json  one file per table, readable without SQLite
//   uploads/       handouts and student attachments
//   summary.json   row counts, file counts, and when it was taken
//
// Two things matter about how the snapshot is taken.
//
// VACUUM INTO, rather than copying classroom.db together with its -wal and
// -shm files: in WAL mode the database lives in three files, and copying them
// one after another while the app is writing can capture a torn state. VACUUM
// INTO asks SQLite itself for a consistent single-file copy, which is safe to
// run against the live database - no need to stop the service.
//
// The JSON dumps are read back out of that snapshot, not out of the live
// database, so every table describes the same instant as classroom.db does.
//
// This script deliberately does not require db/database.js: that module runs
// the startup migrations, and a backup has to capture the state as it is.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const BACKUP_ROOT = path.join(ROOT, "backups");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const DEFAULT_KEEP = 10;
const ARCHIVE_PREFIX = "classroom-";

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Everything under a directory, for the upload counts in the summary.
function measureTree(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(full).size;
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { files, bytes };
}

// Keeps the newest `keep` archives and removes the rest. Only files this
// script itself produces are considered - a backup folder put there by hand
// is left alone.
function pruneArchives(keep) {
  if (!Number.isInteger(keep) || keep < 1) return [];
  const archives = fs
    .readdirSync(BACKUP_ROOT)
    .filter((name) => name.startsWith(ARCHIVE_PREFIX) && name.endsWith(".tar.gz"))
    // The timestamp is part of the name, so sorting by name sorts by age.
    .sort();

  const removed = archives.slice(0, Math.max(0, archives.length - keep));
  for (const name of removed) {
    fs.rmSync(path.join(BACKUP_ROOT, name), { force: true });
  }
  return removed;
}

function backup({ keep = DEFAULT_KEEP, archive = true } = {}) {
  const dbPath = process.env.DB_PATH || path.join(ROOT, "classroom.db");
  if (!fs.existsSync(dbPath)) {
    throw new Error(`No database at ${dbPath} - nothing to back up.`);
  }

  // The timestamp names the backup, so two runs inside the same second would
  // land on the same folder - and VACUUM INTO refuses to overwrite a file.
  let name = `${ARCHIVE_PREFIX}${timestamp()}`;
  for (let n = 2; fs.existsSync(path.join(BACKUP_ROOT, name)); n += 1) {
    name = `${ARCHIVE_PREFIX}${timestamp()}-${n}`;
  }
  const dir = path.join(BACKUP_ROOT, name);
  const tablesDir = path.join(dir, "tables");
  fs.mkdirSync(tablesDir, { recursive: true });

  // ---- 1. the database, as one consistent file ----
  const snapshotPath = path.join(dir, "classroom.db");
  const live = new Database(dbPath);
  try {
    live.prepare("VACUUM INTO ?").run(snapshotPath);
  } finally {
    live.close();
  }
  console.log(`database snapshot: ${formatSize(fs.statSync(snapshotPath).size)}`);

  // ---- 2. table dumps, read from the snapshot ----
  const snapshot = new Database(snapshotPath, { readonly: true });
  const rowCounts = {};
  try {
    const tables = snapshot
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all()
      .map((t) => t.name);

    for (const table of tables) {
      const rows = snapshot.prepare(`SELECT * FROM ${table}`).all();
      fs.writeFileSync(
        path.join(tablesDir, `${table}.json`),
        JSON.stringify(rows, null, 2),
        "utf8"
      );
      rowCounts[table] = rows.length;
    }
  } finally {
    snapshot.close();
  }

  // ---- 3. the uploaded files ----
  // Handouts and student attachments live on disk; the database only holds
  // their names. Without these, a restored database points at files that
  // aren't there any more.
  const uploads = measureTree(UPLOAD_DIR);
  if (uploads.files > 0) {
    fs.cpSync(UPLOAD_DIR, path.join(dir, "uploads"), { recursive: true });
  }

  const summary = {
    takenAt: new Date().toISOString(),
    database: dbPath,
    rowCounts,
    uploads,
  };
  fs.writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8"
  );

  console.log("rows per table:");
  for (const [table, count] of Object.entries(rowCounts)) {
    console.log(`  ${table.padEnd(26)} ${count}`);
  }
  console.log(
    `uploaded files: ${uploads.files} (${formatSize(uploads.bytes)})`
  );

  // ---- 4. pack it ----
  let result = dir;
  if (archive) {
    const archivePath = path.join(BACKUP_ROOT, `${name}.tar.gz`);
    // The system tar: present on Ubuntu, and on Windows 10/11 as well. Run it
    // inside the backups directory with plain names - an absolute Windows path
    // like C:\... would be read as a remote "host:path" by GNU tar.
    const tar = spawnSync("tar", ["-czf", `${name}.tar.gz`, name], {
      cwd: BACKUP_ROOT,
      encoding: "utf8",
    });
    if (tar.error || tar.status !== 0) {
      console.warn(
        `\ncould not create the archive (${
          tar.error ? tar.error.message : tar.stderr.trim()
        }).\nThe backup folder is kept as it is - pack it yourself if you need one file.`
      );
    } else {
      fs.rmSync(dir, { recursive: true, force: true });
      result = archivePath;
    }
  }

  const removed = pruneArchives(keep);
  if (removed.length > 0) {
    console.log(
      `\nremoved ${removed.length} older archive(s), keeping the newest ${keep}`
    );
  }

  const size = fs.statSync(result).isFile() ? formatSize(fs.statSync(result).size) : "";
  console.log(`\nBackup: ${result}${size ? ` (${size})` : ""}`);
  printDownloadHint(result);
  return result;
}

// The backup lives inside /opt/classroom, which the app user owns and nobody
// else can enter, so copying it out takes one step through /tmp.
function printDownloadHint(target) {
  if (!fs.statSync(target).isFile()) return;
  const base = path.basename(target);
  console.log("\nTo copy it to your own computer:");
  console.log(`  on the VM:   sudo install -m 600 -o $USER ${target} /tmp/${base}`);
  console.log(`  at home:     scp ВАШ_ЛОГИН@ВАШ_IP:/tmp/${base} .`);
  console.log(`  on the VM:   rm /tmp/${base}`);
  console.log(
    "  (the archive holds passwords and student work - don't leave it in /tmp)"
  );
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      [
        "Usage: npm run backup [-- options]",
        "",
        "  --keep N       keep the N newest archives (default " + DEFAULT_KEEP + ")",
        "  --no-archive   leave the backup folder instead of packing it",
      ].join("\n")
    );
    process.exit(0);
  }

  const keepIndex = args.indexOf("--keep");
  const keep =
    keepIndex === -1 ? DEFAULT_KEEP : parseInt(args[keepIndex + 1], 10);
  if (!Number.isInteger(keep) || keep < 1) {
    console.error("--keep needs a whole number of archives to keep, at least 1");
    process.exit(1);
  }

  backup({ keep, archive: !args.includes("--no-archive") });
}

module.exports = { backup };
