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
function storeFile(file) {
  const originalName = sanitizeOriginalName(file && file.name);
  const ext = extensionOf(originalName);

  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new UploadError(
      `"${originalName}": file type not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}`
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
  if (buffer.length > MAX_FILE_BYTES) {
    throw new UploadError(
      `"${originalName}" is ${(buffer.length / 1024 / 1024).toFixed(1)} MB - the limit is ${MAX_FILE_BYTES / 1024 / 1024} MB`
    );
  }

  ensureUploadDir();
  const storedName = `${crypto.randomBytes(16).toString("hex")}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), buffer);

  return { originalName, storedName, size: buffer.length };
}

// Stores a batch, cleaning up already-written files if a later one fails so
// we never leave half an upload behind.
function storeFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return [];
  if (files.length > MAX_FILES_PER_ASSIGNMENT) {
    throw new UploadError(
      `Too many files: ${files.length} (limit is ${MAX_FILES_PER_ASSIGNMENT})`
    );
  }

  const stored = [];
  try {
    for (const file of files) stored.push(storeFile(file));
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

module.exports = {
  UPLOAD_DIR,
  ALLOWED_EXTENSIONS,
  MAX_FILE_BYTES,
  MAX_FILES_PER_ASSIGNMENT,
  UploadError,
  storeFiles,
  pathForStoredName,
  removeFile,
};
