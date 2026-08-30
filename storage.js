// Storage for teacher-uploaded handouts (methodology files) attached to
// assignments.
//
// Files arrive as base64 inside the JSON request body rather than as
// multipart/form-data: that keeps the project dependency-free (no multer),
// which matters here because rebuilding native modules on this machine is
// fragile. For a handful of multi-megabyte handouts the 33% base64 overhead
// is not worth a new dependency.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const UPLOAD_DIR = path.join(__dirname, "uploads");

// Handout formats a teacher would realistically attach. Anything else is
// rejected - this whitelist is what keeps executables out of the folder.
const ALLOWED_EXTENSIONS = [
  ".pdf",
  ".doc",
  ".docx",
  ".odt",
  ".rtf",
  ".txt",
  ".md",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".csv",
  ".png",
  ".jpg",
  ".jpeg",
];

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_FILES_PER_ASSIGNMENT = 10;

// --- Student uploads on free-form assignments ---
//
// Students may attach arbitrary files, so this side uses a blocklist rather
// than a whitelist. Archives are refused because nobody can see what's inside
// before opening them, and everything executable or script-like is refused
// because the danger is to whoever downloads it - the teacher. The server
// itself never opens or runs these files, and stores them under generated
// names, so they are inert while they sit on disk.
const BLOCKED_STUDENT_EXTENSIONS = [
  // archives
  ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".cab", ".iso", ".dmg",
  // native executables and installers
  ".exe", ".msi", ".dll", ".so", ".dylib", ".app", ".apk", ".deb", ".rpm",
  ".com", ".scr", ".pif", ".jar", ".bin",
  // scripts and shortcuts
  ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf",
  ".wsh", ".sh", ".reg", ".lnk", ".hta", ".msc", ".chm",
];

const MAX_STUDENT_FILE_BYTES = 5 * 1024 * 1024; // 5 MB per file
const MAX_STUDENT_FILES = 3;

function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Keeps the name readable in the UI and in the download header, but strips
// anything that could be interpreted as a path.
function sanitizeOriginalName(name) {
  const base = path.basename(String(name || "")).replace(/[\r\n"]/g, "");
  return base.slice(0, 200) || "file";
}

function extensionOf(name) {
  return path.extname(sanitizeOriginalName(name)).toLowerCase();
}

class UploadError extends Error {}

// Validates one incoming {name, data} pair and writes it to disk under a
// generated name. The original name is never used as a path, so a crafted
// name like "../../server.js" cannot escape the upload folder.
function storeFile(file, policy = {}) {
  const {
    allowed = ALLOWED_EXTENSIONS,
    blocked = null,
    maxBytes = MAX_FILE_BYTES,
  } = policy;

  const originalName = sanitizeOriginalName(file && file.name);
  const ext = extensionOf(originalName);

  // Handouts use a whitelist; student uploads on free-form assignments are
  // arbitrary by definition, so they use a blocklist instead.
  if (blocked) {
    if (!ext) {
      throw new UploadError(`"${originalName}": the file needs an extension`);
    }
    if (blocked.includes(ext)) {
      throw new UploadError(
        `"${originalName}": ${ext} files are not accepted. Archives (zip, rar, …) and programs (exe, bat, …) are blocked — send the documents themselves.`
      );
    }
  } else if (!allowed.includes(ext)) {
    throw new UploadError(
      `"${originalName}": file type not allowed. Allowed: ${allowed.join(", ")}`
    );
  }

  const base64 = typeof file.data === "string" ? file.data : "";
  // Browsers send data URLs ("data:application/pdf;base64,....") - drop the prefix.
  const payload = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;

  let buffer;
  try {
    buffer = Buffer.from(payload, "base64");
  } catch {
    throw new UploadError(`"${originalName}": could not decode file contents`);
  }

  if (buffer.length === 0) {
    throw new UploadError(`"${originalName}": file is empty`);
  }
  if (buffer.length > maxBytes) {
    throw new UploadError(
      `"${originalName}" is ${(buffer.length / 1024 / 1024).toFixed(1)} MB - the limit is ${maxBytes / 1024 / 1024} MB`
    );
  }

  ensureUploadDir();
  const storedName = `${crypto.randomBytes(16).toString("hex")}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), buffer);

  return { originalName, storedName, size: buffer.length };
}

// Stores a batch, cleaning up already-written files if a later one fails so
// we never leave half an upload behind.
function storeFiles(files, policy = {}) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const maxFiles = policy.maxFiles || MAX_FILES_PER_ASSIGNMENT;
  if (files.length > maxFiles) {
    throw new UploadError(`Too many files: ${files.length} (limit is ${maxFiles})`);
  }

  const stored = [];
  try {
    for (const file of files) stored.push(storeFile(file, policy));
    return stored;
  } catch (err) {
    stored.forEach((s) => removeFile(s.storedName));
    throw err;
  }
}

// Resolves a stored name to an absolute path, refusing anything that isn't a
// plain generated filename sitting directly inside the upload folder.
function pathForStoredName(storedName) {
  const name = path.basename(String(storedName || ""));
  const full = path.join(UPLOAD_DIR, name);
  if (path.dirname(full) !== UPLOAD_DIR) return null;
  return full;
}

function removeFile(storedName) {
  const full = pathForStoredName(storedName);
  if (full) fs.rm(full, { force: true }, () => {});
}

// Student attachments on free-form assignments.
function storeStudentFiles(files) {
  return storeFiles(files, {
    blocked: BLOCKED_STUDENT_EXTENSIONS,
    maxBytes: MAX_STUDENT_FILE_BYTES,
    maxFiles: MAX_STUDENT_FILES,
  });
}

module.exports = {
  UPLOAD_DIR,
  ALLOWED_EXTENSIONS,
  MAX_FILE_BYTES,
  MAX_FILES_PER_ASSIGNMENT,
  BLOCKED_STUDENT_EXTENSIONS,
  MAX_STUDENT_FILE_BYTES,
  MAX_STUDENT_FILES,
  UploadError,
  storeFiles,
  storeStudentFiles,
  pathForStoredName,
  removeFile,
};
