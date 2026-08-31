const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Limiter, QueueFullError } = require("./queue");

// ---------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------
const DOCKER_IMAGE = process.env.SANDBOX_IMAGE || "eclipse-temurin:21-jdk";
const TIME_LIMIT_SECONDS = parseInt(process.env.SANDBOX_TIME_LIMIT || "30", 10);
const MEMORY_LIMIT = process.env.SANDBOX_MEMORY_LIMIT || "512m";
const JVM_HEAP = process.env.SANDBOX_JVM_HEAP || "256m";
const CPUS = process.env.SANDBOX_CPUS || "1";
const PIDS_LIMIT = process.env.SANDBOX_PIDS_LIMIT || "64";

// How many sandbox runs may happen at the same time. Everything else waits.
const SLOTS = parseInt(process.env.SANDBOX_SLOTS || "4", 10);
const MAX_QUEUE = parseInt(process.env.SANDBOX_MAX_QUEUE || "60", 10);

// Student code runs as an unprivileged user inside the container. 65534 is
// "nobody" on the Temurin image; it owns nothing, so a compromise of the JVM
// lands on an account with no rights rather than on root.
const RUN_AS_USER = process.env.SANDBOX_USER || "65534:65534";

// Open files per container. Comfortably above what a JVM needs (~60) and far
// below anything that could exhaust the host.
const NOFILE_LIMIT = process.env.SANDBOX_NOFILE || "256";

// Node-side safety-net timeout (a bit longer than the in-container timeout,
// in case Docker itself hangs, e.g. pulling an image).
const NODE_TIMEOUT_MS = (TIME_LIMIT_SECONDS + 15) * 1000;

// Security flags shared by both the compile and the run container.
// --cap-drop=ALL           strips every Linux capability, including the ones
//                          Docker grants by default (CHOWN, SETUID, NET_RAW…)
// --security-opt           blocks setuid binaries from regaining privileges
// --user                   never run student code as root
// --ulimit nofile          bounds file descriptors
//
// Deliberately NOT using --ulimit nproc: that limit is counted per UID across
// the whole host, so with several containers sharing uid 65534 they would
// exhaust it collectively and fail at random. --pids-limit does the same job
// correctly, per container, through cgroups.
const HARDENING_FLAGS = [
  `--user=${RUN_AS_USER}`,
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  `--pids-limit=${PIDS_LIMIT}`,
  `--ulimit=nofile=${NOFILE_LIMIT}:${NOFILE_LIMIT}`,
];

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

// Removing the directory can fail right after the container exits: on Windows
// the Docker file-sharing layer may still hold a handle for a moment. Retry a
// few times before giving up, and say so if it never works - a silently
// swallowed error here leaves the student's source lying around in the temp
// folder for good.
function cleanupDir(dir, attempt = 0) {
  fs.rm(dir, { recursive: true, force: true }, (err) => {
    if (!err) return;
    if (attempt < 4) {
      setTimeout(() => cleanupDir(dir, attempt + 1), 250 * (attempt + 1));
      return;
    }
    console.warn(`[sandbox] could not remove temp dir ${dir}: ${err.message}`);
  });
}

// Stops the container itself. Killing the `docker run` client is not enough:
// the daemon owns the container, so the client dying leaves it running until
// its own `timeout` fires. `docker kill` removes it right away (--rm cleans up).
function killContainer(name) {
  try {
    const killer = spawn("docker", ["kill", name], { stdio: "ignore" });
    killer.on("error", () => {});
  } catch {
    // Nothing more we can do from here; the in-container timeout is the backstop.
  }
}

// Runs a docker command, optionally piping stdin, with a hard Node-side
// timeout as a safety net on top of the in-container `timeout` command.
// `containerName` is what gets killed when that safety net fires.
function runDocker(args, stdin, containerName) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let clientKillTimer = null;

    // Stop the container, then - only if the client somehow hangs around
    // afterwards - stop the client too.
    const stopEverything = () => {
      if (settled) return;
      killContainer(containerName);
      if (!clientKillTimer) {
        clientKillTimer = setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 5000);
      }
    };

    const killTimer = setTimeout(stopEverything, NODE_TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
      // Guard against runaway output filling memory
      if (stdout.length > 200_000) stopEverything();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stopEverything();
    });

    child.on("error", (err) => {
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(clientKillTimer);
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
      clearTimeout(clientKillTimer);
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

// Every sandbox run in the process goes through this.
const limiter = new Limiter(SLOTS, MAX_QUEUE);

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

  // Validation above is free; everything below starts containers, so it waits
  // for a slot. Callers see nothing but a slower response.
  return limiter.run(() => runProjectInSlot(files, entry, stdin));
}

async function runProjectInSlot(files, entry, stdin) {
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
    const compileName = `jc-build-${crypto.randomBytes(8).toString("hex")}`;
    const compileArgs = [
      "run",
      "--rm",
      `--name=${compileName}`,
      "--network=none",
      `--memory=${MEMORY_LIMIT}`,
      `--cpus=${CPUS}`,
      ...HARDENING_FLAGS,
      // javac needs somewhere to work; the image's own filesystem stays intact
      // because everything it writes goes to the mounted /out.
      "--tmpfs=/tmp:rw,noexec,nosuid,size=32m",
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

    const compileResult = await runDocker(compileArgs, undefined, compileName);

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
    const runName = `jc-run-${crypto.randomBytes(8).toString("hex")}`;
    const runArgs = [
      "run",
      "--rm",
      "-i",
      `--name=${runName}`,
      "--network=none",
      `--memory=${MEMORY_LIMIT}`,
      `--memory-swap=${MEMORY_LIMIT}`,
      `--cpus=${CPUS}`,
      ...HARDENING_FLAGS,
      "--read-only",
      // noexec matters: without it student code can drop a native binary in
      // /tmp and run it, stepping straight outside "this is only Java".
      "--tmpfs=/tmp:rw,noexec,nosuid,size=32m",
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

    const runResult = await runDocker(runArgs, stdin, runName);

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
  QueueFullError,
  isValidJavaFilename,
  // For monitoring: how busy the sandbox is right now.
  sandboxStats: () => limiter.stats(),
};
