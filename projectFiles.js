// Data files inside a project.
//
// A project used to be Java sources only. It can now also hold data files -
// the input a program reads and the output it writes - so labs about streams
// and serialisation are possible. They live alongside the sources: they are
// part of a saved version, shown in the file tree, and snapshotted with the
// rest when a version is saved.
//
// Two separate rules apply to a data file name:
//
//   isSafeDataFilename   always enforced, on the server. The name becomes a
//                        path inside a mounted directory, so a slash, a ".."
//                        or an odd character must never get through. This is
//                        the security boundary.
//   hasAllowedExtension  enforced where a human supplies the file (the "Add
//                        local file" dialog and "New file"). It keeps the
//                        project to text data a student can actually read in
//                        the editor. A file the student's own program writes
//                        is not filtered this way - a serialised object is
//                        binary by nature, and the program could create it in
//                        any case.

// Text data formats, plus "no extension at all" (a bare `input` is a common
// thing to hand out). Deliberately no .html/.js/.sh and friends: those are
// programs, not data, and they have no business in a Java project.
const DATA_EXTENSIONS = [
  "txt", "text", "log", "md", "markdown",
  "csv", "tsv", "psv", "tab",
  "dat", "data", "in", "inp", "out", "rec", "asc",
  "json", "xml", "yaml", "yml",
  "ini", "cfg", "conf", "config", "properties", "props", "env",
  "lst", "list",
];

// No directories, no dot-files, no leading dash; printable ASCII only. Length
// is capped well below any filesystem limit.
const DATA_FILENAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

const MAX_DATA_FILES = 15;
const MAX_DATA_FILE_BYTES = 256 * 1024;
const MAX_DATA_TOTAL_BYTES = 1024 * 1024;

function isJavaFile(name) {
  return /\.java$/i.test(String(name || ""));
}

function isSafeDataFilename(name) {
  const text = String(name || "");
  if (!DATA_FILENAME.test(text)) return false;
  // Reserved on Windows, where the server may well be running in development.
  return !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(text);
}

function extensionOf(name) {
  const base = String(name || "");
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

// A name a person is allowed to add by hand: a text data format, or no
// extension at all.
function hasAllowedExtension(name) {
  const ext = extensionOf(name);
  return ext === "" || DATA_EXTENSIONS.includes(ext);
}

// ---------------------------------------------------------------------
// Text or binary
//
// Text files are stored as they are, so they can be read and edited in the
// browser. Anything else is stored base64 in the same column, marked with
// encoding "base64" - the editor then shows it as a binary file instead of
// mangling it.
// ---------------------------------------------------------------------

function isProbablyText(buffer) {
  if (buffer.includes(0)) return false;
  const text = buffer.toString("utf8");
  // A byte sequence that isn't valid UTF-8 comes back with replacement
  // characters, and re-encoding it then gives a different length.
  return Buffer.byteLength(text, "utf8") === buffer.length;
}

function encodeContent(buffer) {
  return isProbablyText(buffer)
    ? { content: buffer.toString("utf8"), encoding: "text" }
    : { content: buffer.toString("base64"), encoding: "base64" };
}

// The bytes of a stored file, whichever way it was stored.
function decodeContent(file) {
  return file.encoding === "base64"
    ? Buffer.from(file.content || "", "base64")
    : Buffer.from(file.content ?? "", "utf8");
}

function normalizeEncoding(value) {
  return value === "base64" ? "base64" : "text";
}

module.exports = {
  DATA_EXTENSIONS,
  MAX_DATA_FILES,
  MAX_DATA_FILE_BYTES,
  MAX_DATA_TOTAL_BYTES,
  isJavaFile,
  isSafeDataFilename,
  hasAllowedExtension,
  extensionOf,
  isProbablyText,
  encodeContent,
  decodeContent,
  normalizeEncoding,
};
