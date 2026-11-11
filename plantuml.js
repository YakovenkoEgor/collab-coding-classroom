// Rendering PlantUML diagrams.
//
// A diagram is text a student wrote, so it is rendered the same way their Java
// is run: in a throwaway container with no network, a read-only filesystem and
// bounded memory, CPU and time. On top of that PlantUML has a security profile
// of its own - its preprocessor can otherwise read local files and fetch URLs -
// and it is set to SANDBOX, which refuses both and ignores allowlists.
// See https://plantuml.com/security.
//
// The source goes in on stdin and the SVG comes back on stdout (`-pipe`), so
// nothing is written to disk on either side.
//
// Identical sources render to identical pictures, so finished renders are kept
// in memory for the length of the server's life: a student pressing "Отрисовать"
// twice without an edit waits only the first time.

const crypto = require("crypto");
const { spawn } = require("child_process");

// The official image carries PlantUML and Graphviz, which class, object,
// component, deployment, state and use-case diagrams need for layout.
const IMAGE = process.env.PLANTUML_IMAGE || "plantuml/plantuml:latest";

// Arguments passed to the image's own entry point. `-pipe` is what makes it
// read stdin and write stdout, `-tsvg` picks the format, and `-stdrpt:1` is
// what turns a broken diagram into a readable complaint: without it PlantUML
// answers any mistake with a picture of its own welcome screen and says
// nothing, which tells a student nothing either.
const ARGS = (process.env.PLANTUML_ARGS || "-tsvg -pipe -charset UTF-8 -stdrpt:1").split(
  /\s+/
);

const MEMORY_LIMIT = process.env.PLANTUML_MEMORY_LIMIT || "512m";
const CPUS = process.env.PLANTUML_CPUS || "1";
const PIDS_LIMIT = process.env.PLANTUML_PIDS_LIMIT || "64";
const RUN_AS_USER = process.env.PLANTUML_RUN_AS_USER || "65534:65534";
const TIMEOUT_MS = parseInt(process.env.PLANTUML_TIMEOUT_MS || "30000", 10);

// A diagram is text; anything larger than this is not a diagram.
const MAX_SOURCE_CHARS = parseInt(
  process.env.PLANTUML_MAX_SOURCE_CHARS || "100000",
  10
);
// A rendered picture that will not fit on a screen will not fit in a review
// either, and it has to travel to the browser and into a version.
const MAX_SVG_CHARS = parseInt(process.env.PLANTUML_MAX_SVG_CHARS || "2000000", 10);

// How many finished renders to keep. Each is tens of kilobytes, so this is a
// couple of megabytes at most.
const CACHE_LIMIT = parseInt(process.env.PLANTUML_CACHE_LIMIT || "200", 10);

// Renders happen while a student types, so they are bounded the same way runs
// are: a handful at a time, the rest wait.
const MAX_CONCURRENT = parseInt(process.env.PLANTUML_CONCURRENCY || "4", 10);

const cache = new Map(); // hash -> { svg, error }
let running = 0;
const waiting = [];

class PlantUmlError extends Error {}

function sourceHash(source) {
  return crypto.createHash("sha256").update(source, "utf8").digest("hex");
}

// Remembered oldest-first: Map preserves insertion order, so the first key is
// the one to drop.
function remember(hash, result) {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(hash, result);
}

function acquireSlot() {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) return next();
  running--;
}

// `docker` is installed but the daemon is not running. Worth saying plainly:
// the diagram is fine, the server is not.
function isDockerUnavailable(stderr) {
  return /failed to connect to the docker API|cannot connect to the docker daemon|error during connect|docker daemon is not running/i.test(
    stderr || ""
  );
}

// Is the daemon up? Asked before every render, because `docker run` with the
// daemon down does not fail - the Desktop client sits there waiting for an
// engine that is not coming, and the render would only end at its timeout.
// The answer is cached for a few seconds so a burst of renders asks once.
let daemonCheckedAt = 0;
let daemonUp = false;
const DAEMON_CACHE_MS = 5000;
const DAEMON_CHECK_TIMEOUT_MS = 5000;

function checkDaemon() {
  return new Promise((resolve) => {
    const child = spawn("docker", ["version", "--format", "{{.Server.Version}}"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const done = (up) => {
      if (settled) return;
      settled = true;
      resolve(up);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(false);
    }, DAEMON_CHECK_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}

// Is the image here? `docker run` would fetch it, but a 500 MB pull does not
// fit inside one render's time limit, so an absent image is reported as what
// it is - a setup step nobody has done yet - instead of a timeout.
function checkImage() {
  return new Promise((resolve) => {
    const child = spawn("docker", ["image", "inspect", IMAGE], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    let settled = false;
    const done = (present) => {
      if (settled) return;
      settled = true;
      resolve(present);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(false);
    }, DAEMON_CHECK_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}

let imageChecked = false;
let imagePresent = false;

// Returns null when everything is in place, or the message to show when it is
// not. Both answers are cached for a few seconds: a burst of renders asks once.
async function rendererProblem() {
  const now = Date.now();
  if (now - daemonCheckedAt >= DAEMON_CACHE_MS) {
    daemonUp = await checkDaemon();
    daemonCheckedAt = now;
    // A daemon that just came back up may have been given the image since.
    if (!daemonUp) imageChecked = false;
  }
  if (!daemonUp) {
    return "Отрисовка недоступна: на сервере не запущен Docker. Сообщите преподавателю.";
  }

  if (!imageChecked || !imagePresent) {
    imagePresent = await checkImage();
    imageChecked = true;
  }
  if (!imagePresent) {
    return `Отрисовка недоступна: на сервере нет образа ${IMAGE}. Выполните «docker pull ${IMAGE}».`;
  }
  return null;
}

function dockerArgs(containerName) {
  return [
    "run",
    "--rm",
    "-i",
    `--name=${containerName}`,
    // Nothing a diagram needs is on the network, and the renderer must not be
    // able to fetch anything a student names.
    "--network=none",
    `--memory=${MEMORY_LIMIT}`,
    `--memory-swap=${MEMORY_LIMIT}`,
    `--cpus=${CPUS}`,
    `--user=${RUN_AS_USER}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--pids-limit=${PIDS_LIMIT}`,
    "--read-only",
    // Java wants somewhere to put temporary files; this is the only writable
    // place in the container, and nothing may be executed from it.
    "--tmpfs=/tmp:rw,noexec,nosuid,size=64m",
    // PlantUML reads this itself: no local files, no URLs, allowlists ignored.
    "-e",
    "PLANTUML_SECURITY_PROFILE=SANDBOX",
    IMAGE,
    ...ARGS,
  ];
}

function killContainer(name) {
  try {
    spawn("docker", ["kill", name], { stdio: "ignore" }).on("error", () => {});
  } catch {
    // The container is already gone, which is the outcome we wanted.
  }
}

function runDocker(source, containerName) {
  return new Promise((resolve) => {
    const child = spawn("docker", dockerArgs(containerName), {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout = [];
    let stdoutLength = 0;
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killContainer(containerName);
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 5000);
    }, TIMEOUT_MS);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      stdoutLength += chunk.length;
      if (stdoutLength > MAX_SVG_CHARS) {
        killContainer(containerName);
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));

    child.on("error", (err) => finish({ code: -1, stderr: err.message, out: "" }));
    child.on("close", (code) =>
      finish({
        code,
        timedOut,
        stderr,
        out: Buffer.concat(stdout).toString("utf8"),
        tooLarge: stdoutLength > MAX_SVG_CHARS,
      })
    );

    child.stdin.on("error", () => {
      // The container died before reading its input; `close` reports why.
    });
    child.stdin.write(source, "utf8");
    child.stdin.end();
  });
}

// What PlantUML reports on stderr with -stdrpt:1, which looks like this:
//
//   protocolVersion=1
//   status=ERROR
//   lineNumber=3
//   label=Syntax Error? (Assumed diagram type: component)
//
// Nothing is reported when the diagram is fine.
function errorFromReport(stderr) {
  const text = String(stderr || "");
  if (!/status=ERROR/i.test(text)) return null;

  const label = /^label=(.*)$/m.exec(text);
  const line = /^lineNumber=(\d+)$/m.exec(text);
  const message = label ? label[1].trim() : "Ошибка в разметке диаграммы";
  return line ? `Строка ${line[1]}: ${message}` : message;
}

// Renders one source. Always resolves: a diagram that will not render is a
// normal outcome, reported as `error` rather than thrown.
async function render(source) {
  const text = typeof source === "string" ? source : "";
  if (text.trim() === "") {
    return { svg: null, error: "Файл пуст — нечего отрисовывать" };
  }
  if (text.length > MAX_SOURCE_CHARS) {
    return {
      svg: null,
      error: `Исходник длиннее ${MAX_SOURCE_CHARS} символов — это не диаграмма`,
    };
  }

  const hash = sourceHash(text);
  const cached = cache.get(hash);
  if (cached) return { ...cached, cached: true };

  const problem = await rendererProblem();
  if (problem) return { svg: null, error: problem };

  await acquireSlot();
  let result;
  try {
    const name = `jc-puml-${crypto.randomBytes(8).toString("hex")}`;
    result = await runDocker(text, name);
  } finally {
    releaseSlot();
  }

  if (result.code === -1 || isDockerUnavailable(result.stderr)) {
    // Not cached: the next attempt should try again rather than repeat a
    // failure that has nothing to do with the diagram.
    return {
      svg: null,
      error:
        "Отрисовка недоступна: на сервере не запущен Docker. Сообщите преподавателю.",
    };
  }
  if (result.timedOut) {
    return { svg: null, error: "Отрисовка не уложилась во время" };
  }
  if (result.tooLarge) {
    return { svg: null, error: "Диаграмма получилась слишком большой" };
  }

  const svg = result.out.trim();
  if (!svg.startsWith("<?xml") && !svg.startsWith("<svg")) {
    const complaint = (result.stderr || "").trim() || svg;
    const outcome = {
      svg: null,
      error: complaint
        ? `PlantUML не смог отрисовать диаграмму:\n${complaint}`
        : "PlantUML не смог отрисовать диаграмму",
    };
    remember(hash, outcome);
    return outcome;
  }

  // A broken diagram still comes back as a picture - PlantUML draws the error
  // rather than refusing - so both are kept: the picture to look at and the
  // message to act on.
  const outcome = { svg, error: errorFromReport(result.stderr) };
  remember(hash, outcome);
  return outcome;
}

// Renders every diagram of a project, in file-name order. Used when a version
// is saved, so a submitted version carries pictures of all its diagrams and
// nobody has to re-render it later - not the teacher, and not a year from now.
async function renderAll(files) {
  const sources = (files || []).filter((file) => isDiagramFile(file.filename));
  const renders = [];
  for (const file of sources) {
    const result = await render(file.content);
    renders.push({
      filename: file.filename,
      svg: result.svg,
      error: result.error || null,
    });
  }
  return renders;
}

const DIAGRAM_EXTENSIONS = ["puml", "plantuml", "uml", "wsd", "iuml"];

function isDiagramFile(filename) {
  const name = String(filename || "").toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return DIAGRAM_EXTENSIONS.includes(name.slice(dot + 1));
}

module.exports = {
  IMAGE,
  DIAGRAM_EXTENSIONS,
  MAX_SOURCE_CHARS,
  PlantUmlError,
  isDiagramFile,
  render,
  renderAll,
};
