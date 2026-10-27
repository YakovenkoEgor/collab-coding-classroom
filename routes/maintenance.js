// Teacher-facing maintenance: making a backup and exporting process data.
//
// Both are the command-line scripts the project already has
// (scripts/backup-db.js, scripts/export-progsnap2.js), run from the dashboard
// so the teacher does not need a terminal on the server. Nothing here takes
// parameters from the request: the scripts are fixed, the arguments are fixed,
// and the only thing the browser can do is ask for one of the two to run.

const express = require("express");
const path = require("path");
const { spawn } = require("child_process");
const { requireLogin, requireRole } = require("../middleware/auth");

const router = express.Router();

const ROOT = path.join(__dirname, "..");

// A backup of a classroom-sized database takes seconds; the ceiling is here so
// a stuck script cannot hold a request open forever.
const SCRIPT_TIMEOUT_MS = parseInt(
  process.env.MAINTENANCE_TIMEOUT_MS || "180000",
  10
);

// One at a time, per script: two backups at once would race for the same
// output directory, and the teacher pressing a button twice is likelier than
// it sounds.
const running = new Set();

function runScript(name, args = []) {
  return new Promise((resolve) => {
    // process.execPath is the node binary already running the server, so this
    // works whatever node is called or wherever it lives.
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", name), ...args], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, SCRIPT_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        timedOut,
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

async function handle(req, res, { key, script, args = [], failure }) {
  if (running.has(key)) {
    return res.status(409).json({ error: "Этот скрипт уже выполняется — подождите." });
  }
  running.add(key);
  try {
    const result = await runScript(script, args);
    if (!result.ok) {
      return res.status(502).json({
        error: result.timedOut
          ? `${failure}: скрипт не уложился во время`
          : `${failure}: ${result.stderr || result.stdout || "неизвестная ошибка"}`,
        output: result.stdout,
      });
    }
    res.json({ ok: true, output: result.stdout });
  } finally {
    running.delete(key);
  }
}

router.post("/backup", requireLogin, requireRole("teacher"), (req, res) =>
  handle(req, res, {
    key: "backup",
    script: "backup-db.js",
    failure: "Не удалось сделать резервную копию",
  })
);

router.post("/progsnap-export", requireLogin, requireRole("teacher"), (req, res) =>
  handle(req, res, {
    key: "progsnap",
    script: "export-progsnap2.js",
    failure: "Не удалось выгрузить данные процесса",
  })
);

module.exports = router;
