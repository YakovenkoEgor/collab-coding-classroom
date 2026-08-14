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
// Public API - mirrors the shape the rest of the app expects
// (stdout, stderr, compileOutput, status, time, memory)
// ---------------------------------------------------------------------

async function runJavaCode(sourceCode, stdin = "") {
  const codeDir = makeTempDir("javasandbox-src-");
  const outDir = makeTempDir("javasandbox-out-");

  try {
    fs.writeFileSync(path.join(codeDir, "Main.java"), sourceCode, "utf8");
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
      "/code/Main.java",
      "-d",
      "/out",
    ];

    const compileResult = await runDocker(compileArgs);

    if (compileResult.exitCode === -1) {
      // Docker itself failed to run (not installed / not running)
      return {
        stdout: "",
        stderr: compileResult.stderr,
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
      "Main",
    ];

    const runResult = await runDocker(runArgs, stdin);

    if (runResult.exitCode === -1) {
      return {
        stdout: "",
        stderr: runResult.stderr,
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

module.exports = { runJavaCode };
