// The file mirror: a tiny web server the sandbox can reach.
//
// Student code runs with --network=none, so a lab like "download a text file
// by its URL" cannot be done at all. Opening the internet to the sandbox is
// not an option, so the platform serves the files itself: the teacher uploads
// them here, and a run that is allowed network access joins an internal Docker
// network where exactly one host answers - the mirror.
//
// What the sandbox can reach on that network:
//   http://files.local/<file name>   (GET and HEAD, read-only)
// What it cannot reach: the internet, the host machine, the platform's own
// API. The network is created with --internal, which drops everything leaving
// the subnet.
//
// The one thing that network does allow is traffic between the containers on
// it - two runs happening at the same moment can see each other's ports. That
// is why network access is a per-assignment switch, off by default.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const projectFiles = require("./projectFiles");

const MIRROR_DIR = process.env.MIRROR_DIR || path.join(__dirname, "mirror");
const NETWORK = process.env.MIRROR_NETWORK || "jc-mirror-net";
const CONTAINER = process.env.MIRROR_CONTAINER || "jc-mirror";
const HOSTNAME = process.env.MIRROR_HOSTNAME || "files.local";
const IMAGE =
  process.env.MIRROR_IMAGE || process.env.SANDBOX_IMAGE || "eclipse-temurin:21-jdk";
const PORT = parseInt(process.env.MIRROR_PORT || "80", 10);

const MAX_FILE_BYTES = parseInt(
  process.env.MIRROR_MAX_FILE_BYTES || String(2 * 1024 * 1024),
  10
);
const MAX_FILES = parseInt(process.env.MIRROR_MAX_FILES || "30", 10);

const BASE_URL = PORT === 80 ? `http://${HOSTNAME}` : `http://${HOSTNAME}:${PORT}`;

class MirrorError extends Error {}

function urlFor(filename) {
  return `${BASE_URL}/${filename}`;
}

function ensureDir() {
  fs.mkdirSync(MIRROR_DIR, { recursive: true });
}

// --- the files themselves -------------------------------------------------

// Stored under their own names on purpose: the whole point of the lab is that
// the name in the URL is the name of the file.
function pathFor(filename) {
  if (!projectFiles.isSafeDataFilename(filename)) return null;
  const full = path.join(MIRROR_DIR, filename);
  if (path.dirname(full) !== MIRROR_DIR) return null;
  return full;
}

function listFiles() {
  ensureDir();
  return fs
    .readdirSync(MIRROR_DIR)
    .filter((name) => {
      try {
        return fs.lstatSync(path.join(MIRROR_DIR, name)).isFile();
      } catch {
        return false;
      }
    })
    .sort()
    .map((name) => ({
      filename: name,
      size: fs.statSync(path.join(MIRROR_DIR, name)).size,
      url: urlFor(name),
    }));
}

// Files arrive base64-encoded in JSON, the same way handouts do - see
// storage.js for why the project avoids multipart uploads.
function storeFile(file) {
  const filename = String((file && file.name) || "").trim();

  // Same policy as a project's data files: a name that is safe both on disk
  // and inside a URL, and a text format - the mirror is for data, not programs.
  if (!projectFiles.isSafeDataFilename(filename)) {
    throw new MirrorError(
      `«${filename}»: имя должно начинаться с буквы или цифры и состоять из латиницы, цифр, точки, дефиса и подчёркивания`
    );
  }
  if (!projectFiles.hasAllowedExtension(filename)) {
    throw new MirrorError(
      `«${filename}»: зеркало раздаёт только текстовые данные (${projectFiles.DATA_EXTENSIONS.slice(
        0,
        8
      ).join(", ")} и подобные, либо без расширения)`
    );
  }

  const raw = typeof file.data === "string" ? file.data : "";
  const payload = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
  const buffer = Buffer.from(payload, "base64");

  if (buffer.length === 0) throw new MirrorError(`«${filename}»: файл пуст`);
  if (buffer.length > MAX_FILE_BYTES) {
    throw new MirrorError(
      `«${filename}»: ${(buffer.length / 1024 / 1024).toFixed(1)} МБ — больше предела в ${(
        MAX_FILE_BYTES /
        1024 /
        1024
      ).toFixed(0)} МБ`
    );
  }

  ensureDir();
  const full = path.join(MIRROR_DIR, filename);
  if (!fs.existsSync(full) && listFiles().length >= MAX_FILES) {
    throw new MirrorError(`В зеркале уже ${MAX_FILES} файлов — удалите лишние`);
  }

  fs.writeFileSync(full, buffer);
  return { filename, size: buffer.length, url: urlFor(filename) };
}

function storeFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new MirrorError("Не выбрано ни одного файла");
  }
  return files.map(storeFile);
}

function removeFile(filename) {
  const full = pathFor(filename);
  if (!full) throw new MirrorError("Неверное имя файла");
  fs.rmSync(full, { force: true });
}

// --- the container ---------------------------------------------------------

function docker(args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function networkExists() {
  const r = await docker(["network", "inspect", NETWORK, "--format", "{{.Name}}"]);
  return r.code === 0;
}

async function containerState() {
  const r = await docker(["inspect", "-f", "{{.State.Running}}", CONTAINER]);
  if (r.code !== 0) return "missing";
  return r.stdout === "true" ? "running" : "stopped";
}

// Idempotent: safe to call before every networked run. When everything is
// already up, this is a single `docker inspect`.
async function ensureUp() {
  ensureDir();

  if ((await containerState()) === "running") return { baseUrl: BASE_URL };

  if (!(await networkExists())) {
    // --internal is what keeps the internet and the host out of reach.
    const created = await docker(["network", "create", "--internal", NETWORK]);
    if (created.code !== 0 && !(await networkExists())) {
      throw new MirrorError(`не удалось создать сеть ${NETWORK}: ${created.stderr}`);
    }
  }

  // A container left over from a previous server run - stopped, or started
  // with different settings - is replaced rather than reused.
  await docker(["rm", "-f", CONTAINER]);

  const started = await docker([
    "run",
    "-d",
    `--name=${CONTAINER}`,
    `--network=${NETWORK}`,
    `--network-alias=${HOSTNAME}`,
    "--memory=128m",
    "--cpus=0.5",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=32",
    "-v",
    `${MIRROR_DIR}:/srv:ro`,
    IMAGE,
    // jwebserver ships with the JDK (18+), so the mirror needs no image of
    // its own, and it only ever answers GET and HEAD.
    "jwebserver",
    "-b",
    "0.0.0.0",
    "-p",
    String(PORT),
    "-d",
    "/srv",
  ]);
  if (started.code !== 0) {
    throw new MirrorError(
      `не удалось запустить зеркало: ${started.stderr || started.stdout}`
    );
  }

  // Give it a moment to bind the port: a run starting in the same second would
  // otherwise get "connection refused" from a mirror that is about to work.
  for (let i = 0; i < 20; i++) {
    const logs = await docker(["logs", CONTAINER], { timeoutMs: 5000 });
    if (/Serving/i.test(logs.stdout + logs.stderr)) break;
    if ((await containerState()) !== "running") {
      throw new MirrorError(`зеркало не запустилось: ${logs.stdout || logs.stderr}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return { baseUrl: BASE_URL };
}

async function stop() {
  await docker(["rm", "-f", CONTAINER]);
}

async function status() {
  const state = await containerState();
  return {
    baseUrl: BASE_URL,
    hostname: HOSTNAME,
    network: NETWORK,
    running: state === "running",
    state,
    files: listFiles(),
  };
}

module.exports = {
  MIRROR_DIR,
  NETWORK,
  HOSTNAME,
  BASE_URL,
  MAX_FILE_BYTES,
  MAX_FILES,
  MirrorError,
  listFiles,
  storeFiles,
  removeFile,
  ensureUp,
  stop,
  status,
  urlFor,
};
