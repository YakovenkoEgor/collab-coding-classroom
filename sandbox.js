const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// ---------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------
const DOCKER_IMAGE = process.env.SANDBOX_IMAGE || "eclipse-temurin:21-jdk";
const TIME_LIMIT_SECONDS = parseInt(process.env.SANDBOX_TIME_LIMIT || "60", 10);
const MEMORY_LIMIT = process.env.SANDBOX_MEMORY_LIMIT || "768m";
const JVM_HEAP = process.env.SANDBOX_JVM_HEAP || "512m";
const CPUS = process.env.SANDBOX_CPUS || "1";
const PIDS_LIMIT = process.env.SANDBOX_PIDS_LIMIT || "64";

// Node-side safety-net timeout (a bit longer than the in-container timeout,
// in case Docker itself hangs, e.g. pulling an image).
const NODE_TIMEOUT_MS = (TIME_LIMIT_SECONDS + 15) * 1000;

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

// `docker` exists but the daemon is down: the command exits non-zero with a
// connection error. Without this check that surfaces to the student as a
// compilation error with a Docker message in it.
function isDockerUnavailable(stderr) {
  return /failed to connect to the docker API|cannot connect to the docker daemon|error during connect|docker daemon is not running/i.test(
    stderr || ""
  );
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dir) {
  fs.rm(dir, { recursive: true, force: true }, () => {});
}

// Runs a docker command, optionally piping stdin, with a hard Node-side
// timeout as a safety net on top of the in-container `timeout` command.
function runDocker(args, stdin) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const killTimer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
      }
    }, NODE_TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
      // Guard against runaway output filling memory
      if (stdout.length > 200_000) child.kill("SIGKILL");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 200_000) child.kill("SIGKILL");
    });

    child.on("error", (err) => {
      settled = true;
      clearTimeout(killTimer);
      resolve({
        exitCode: -1,
        stdout,
        stderr: `Failed to run Docker: ${err.message}. Is Docker installed and running?`,
        timedOut: false,
      });
    });

    child.on("close", (code, signal) => {
      settled = true;
      clearTimeout(killTimer);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        // 124 is the exit code `timeout` uses when it kills the process
        timedOut: code === 124 || signal === "SIGKILL",
      });
    });

    if (stdin !== undefined && stdin !== null) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------
// Project helpers
// ---------------------------------------------------------------------

// Only plain Java source names. This is a security boundary as much as a
// convenience one: the name becomes a path inside the mounted directory, so
// anything with a slash or ".." must never get through.
const JAVA_FILENAME = /^[A-Za-z_][A-Za-z0-9_]*\.java$/;

function isValidJavaFilename(name) {
  return typeof name === "string" && JAVA_FILENAME.test(name);
}

// javac puts a class from `package a.b;` into a/b/, and java then needs the
// fully qualified name. Comments and strings are not parsed - a declaration
// that isn't the real one would be unusual enough to not be worth the
// machinery.
function packageOf(source) {
  const match = /^[ \t]*package[ \t]+([A-Za-z_][A-Za-z0-9_.]*)[ \t]*;/m.exec(
    String(source || "")
  );
  return match ? match[1] : null;
}

// The class to hand to `java`: "Main", or "tools.Main" when the file declares
// a package.
function entryClassName(file) {
  const className = file.filename.replace(/\.java$/, "");
  const pkg = packageOf(file.content);
  return pkg ? `${pkg}.${className}` : className;
}

class SandboxError extends Error {}

// ---------------------------------------------------------------------
// Public API - mirrors the shape the rest of the app expects
// (stdout, stderr, compileOutput, status, time, memory)
// ---------------------------------------------------------------------

// Compiles every file in the project and runs the one the student picked,
// the way an IDE runs the file that's currently open.
// files: [{ filename, content }], entryFilename: which one holds main().
async function runJavaProject(files, entryFilename, stdin = "") {
  if (!Array.isArray(files) || files.length === 0) {
    throw new SandboxError("The project has no files");
  }
  for (const file of files) {
    if (!isValidJavaFilename(file.filename)) {
      throw new SandboxError(
        `"${file.filename}" is not a valid Java file name (expected something like Main.java)`
      );
    }
  }
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file.filename)) {
      throw new SandboxError(`Duplicate file name: ${file.filename}`);
    }
    seen.add(file.filename);
  }

  const entry = files.find((f) => f.filename === entryFilename);
  if (!entry) {
    throw new SandboxError(`Entry file "${entryFilename}" is not part of the project`);
  }

  const codeDir = makeTempDir("javasandbox-src-");
  const outDir = makeTempDir("javasandbox-out-");

  try {
    for (const file of files) {
      fs.writeFileSync(path.join(codeDir, file.filename), file.content ?? "", "utf8");
    }
    // Make the output dir writable by any container user (openjdk images
    // often run as root by default, but this keeps it safe either way).
    fs.chmodSync(outDir, 0o777);

    // ---- Step 1: compile ----
    const compileArgs = [
      "run",
      "--rm",
      "--network=none",
      `--memory=${MEMORY_LIMIT}`,
      `--cpus=${CPUS}`,
      `--pids-limit=${PIDS_LIMIT}`,
      "-v",
      `${codeDir}:/code:ro`,
      "-v",
      `${outDir}:/out:rw`,
      DOCKER_IMAGE,
      "timeout",
      String(TIME_LIMIT_SECONDS),
      "javac",
      // Every file is passed explicitly - there's no shell in the container
      // to expand a wildcard.
      ...files.map((f) => `/code/${f.filename}`),
      "-d",
      "/out",
    ];

    const compileResult = await runDocker(compileArgs);

    if (compileResult.exitCode === -1 || isDockerUnavailable(compileResult.stderr)) {
      // Docker itself failed to run (not installed, or the daemon is stopped)
      return {
        stdout: "",
        stderr:
          compileResult.exitCode === -1
            ? compileResult.stderr
            : "The code sandbox is unavailable: Docker is not running on the server. Ask your teacher to start it.",
        compileOutput: "",
        status: "Sandbox Error",
      };
    }

    if (compileResult.timedOut) {
      return {
        stdout: "",
        stderr: "",
        compileOutput: "Compilation timed out.",
        status: "Compilation Time Limit Exceeded",
      };
    }

    if (compileResult.exitCode !== 0) {
      return {
        stdout: "",
        stderr: "",
        compileOutput: compileResult.stderr || "Compilation failed.",
        status: "Compilation Error",
      };
    }

    // ---- Step 2: run ----
    const runArgs = [
      "run",
      "--rm",
      "-i",
      "--network=none",
      `--memory=${MEMORY_LIMIT}`,
      `--memory-swap=${MEMORY_LIMIT}`,
      `--cpus=${CPUS}`,
      `--pids-limit=${PIDS_LIMIT}`,
      "--read-only",
      "--tmpfs=/tmp:rw,exec,size=64m",
      "-v",
      `${outDir}:/out:ro`,
      DOCKER_IMAGE,
      "timeout",
      String(TIME_LIMIT_SECONDS),
      "java",
      `-Xmx${JVM_HEAP}`,
      "-cp",
      "/out",
      entryClassName(entry),
    ];

    const runResult = await runDocker(runArgs, stdin);

    if (runResult.exitCode === -1 || isDockerUnavailable(runResult.stderr)) {
      return {
        stdout: "",
        stderr:
          runResult.exitCode === -1
            ? runResult.stderr
            : "The code sandbox is unavailable: Docker is not running on the server. Ask your teacher to start it.",
        compileOutput: "",
        status: "Sandbox Error",
      };
    }

    if (runResult.timedOut) {
      return {
        stdout: runResult.stdout,
        stderr: "Time limit exceeded.",
        compileOutput: "",
        status: "Time Limit Exceeded",
      };
    }

    if (runResult.exitCode !== 0) {
      return {
        stdout: runResult.stdout,
        stderr: runResult.stderr || `Process exited with code ${runResult.exitCode}`,
        compileOutput: "",
        status: "Runtime Error",
      };
    }

    return {
      stdout: runResult.stdout,
      stderr: runResult.stderr,
      compileOutput: "",
      status: "Accepted",
    };
  } finally {
    cleanupDir(codeDir);
    cleanupDir(outDir);
  }
}

// Single-file convenience wrapper, kept so older callers keep working.
async function runJavaCode(sourceCode, stdin = "") {
  return runJavaProject(
    [{ filename: "Main.java", content: sourceCode }],
    "Main.java",
    stdin
  );
}

module.exports = {
  runJavaProject,
  runJavaCode,
  SandboxError,
  isValidJavaFilename,
};
