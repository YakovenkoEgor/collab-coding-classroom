let currentUser = null;
let assignments = [];
let activeAssignment = null;
let versions = [];
let activeVersion = null; // the version currently loaded into the editor
let projectFiles = []; // [{ filename, content }] - the project in the editor
let uploadedFiles = []; // free-form assignments: the student's attachments
let runStream = null; // EventSource carrying a running program's output
let runSessionId = null; // id of that program, while it lives
let typedThisRun = []; // lines the student typed into the console this run
let activeFile = null; // file open in the editor; Run starts from this one
let editor = null;
let editorReady = null; // promise
let selectedVersionForMessage = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 401) {
    window.location.href = "/login.html";
    throw new Error("Not logged in");
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function initEditor() {
  editorReady = new Promise((resolve) => {
    require.config({ paths: { vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.47.0/min/vs" } });
    require(["vs/editor/editor.main"], () => {
      resolve();
    });
  });
}

async function loadMe() {
  const { user } = await api("/api/auth/me");
  if (!user) { window.location.href = "/login.html"; return; }
  currentUser = user;
  document.getElementById("whoami").textContent = `${user.displayName} (student)`;
}

async function loadAssignments() {
  const { assignments: list } = await api("/api/assignments");
  assignments = list;
  const container = document.getElementById("assignment-list");
  container.innerHTML = "";
  if (list.length === 0) {
    container.innerHTML = '<p class="muted">No assignments yet.</p>';
    return;
  }
  list.forEach((a) => {
    const div = document.createElement("div");
    div.className = "assignment-item" + (activeAssignment && activeAssignment.id === a.id ? " active" : "");
    div.innerHTML = `<div class="title">${escapeHtml(a.title)}${deadlineMark(a)}</div>
      <div class="meta">${typeBadge(a.type)} ${
        a.deadline
          ? "due " + formatDeadline(a.deadline)
          : new Date(a.created_at).toLocaleDateString()
      }</div>`;
    div.onclick = () => selectAssignment(a);
    container.appendChild(div);
  });
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ---------------------------------------------------------------------
// Assignment types
// ---------------------------------------------------------------------

const TYPE_LABEL = { code: "Code", text: "Text", freeform: "Free-form" };

// Version names, mirrored from routes/submissions.js
const MAX_VERSION_TITLE = 80;

// Student attachment limits, mirrored from storage.js
const MAX_STUDENT_FILES = 3;
const MAX_STUDENT_MB = 5;
const BLOCKED_EXTENSIONS = [
  ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".cab", ".iso", ".dmg",
  ".exe", ".msi", ".dll", ".so", ".dylib", ".app", ".apk", ".deb", ".rpm",
  ".com", ".scr", ".pif", ".jar", ".bin",
  ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf",
  ".wsh", ".sh", ".reg", ".lnk", ".hta", ".msc", ".chm",
];

function assignmentType() {
  return (activeAssignment && activeAssignment.type) || "code";
}

function typeBadge(type) {
  const label = TYPE_LABEL[type] || TYPE_LABEL.code;
  return `<span class="type-badge type-${type || "code"}">${label}</span>`;
}

// Code and text assignments: an editor plus the version history.
function renderWorkCard() {
  const isText = assignmentType() === "text";
  return `
    <div class="card">
      <h3>${isText ? "Your answer" : "Code editor"}</h3>
      ${
        isText
          ? '<textarea id="text-editor" class="text-editor" placeholder="Write your answer here…"></textarea>'
          : `<div class="editor-layout" id="editor-layout">
               <div class="file-tree">
                 <div class="file-tree-header">Project</div>
                 <div id="file-list"></div>
                 <button class="secondary" id="new-file-btn">+ New file</button>
               </div>
               <div class="editor-wrap" id="editor-container"></div>
             </div>
             <div id="entry-hint" class="muted"></div>`
      }
      <div id="readonly-banner"></div>
      <div class="toolbar">
        ${isText ? "" : '<button id="run-btn">▶ Run</button>'}
        ${isText ? "" : '<button class="secondary" id="console-stop" hidden>■ Стоп</button>'}
        <input id="version-title" maxlength="${MAX_VERSION_TITLE}" style="flex:1;min-width:140px"
               placeholder="Название версии (необязательно)">
        <button class="secondary" id="rename-version-btn" hidden>Переименовать</button>
        <button class="secondary" id="save-draft-btn">Save draft</button>
        <button id="submit-btn">Submit</button>
      </div>
      ${
        isText
          ? ""
          : // One console for everything: program output, errors and what the
            // student types, in the order it happened - the input line lives
            // inside the panel so the caret sits right after the prompt.
            `<div class="output-panel terminal" id="output-panel"><span id="terminal-text">Здесь появится вывод программы.</span><input
                 id="console-line" class="terminal-input" autocomplete="off"
                 spellcheck="false" hidden></div>`
      }
    </div>

    <div class="card">
      <h3>Version history</h3>
      <div class="version-list" id="version-list"><p class="muted">Loading…</p></div>
    </div>`;
}

// Free-form assignments: attachments, no versions.
function renderUploadCard() {
  return `
    <div class="card">
      <h3>Your files</h3>
      <p class="muted" style="font-size:13px">
        Attach up to ${MAX_STUDENT_FILES} files, ${MAX_STUDENT_MB} MB each.
        Uploading a file with a name you already used replaces it.
        Archives and programs (zip, rar, exe …) are not accepted.
      </p>
      <div id="upload-list"><p class="muted">Loading…</p></div>
      <div class="toolbar">
        <input type="file" id="upload-input" multiple>
        <button id="upload-btn" disabled>Attach</button>
      </div>
      <div id="upload-message"></div>
    </div>`;
}

// ---------------------------------------------------------------------
// Deadlines (mirrors what the teacher sees in a student's profile)
// ---------------------------------------------------------------------

function formatDeadline(deadline) {
  const date = new Date(String(deadline).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? deadline : date.toLocaleString();
}

function deadlineHint(row) {
  const hours = row.hoursLeft;
  if (hours === null || hours === undefined) return "";
  if (row.deadlineState === "overdue") {
    const late = Math.abs(hours);
    return late < 48 ? `просрочено на ${late} ч` : `просрочено на ${Math.round(late / 24)} дн`;
  }
  return hours < 24 ? `осталось ${hours} ч` : `осталось ${Math.round(hours / 24)} дн`;
}

function deadlineMark(row) {
  if (!row.deadlineState) return "";
  const cls = row.deadlineState === "overdue" ? "deadline-flag overdue" : "deadline-flag";
  const label = row.deadlineState === "overdue" ? "просрочено" : "скоро срок";
  return ` <span class="${cls}" title="${escapeHtml(deadlineHint(row))}">${label}</span>`;
}

// Re-reads the assignment list (which carries the deadline state) and updates
// both the sidebar and the notice on the open assignment.
async function refreshDeadlineState() {
  await loadAssignments();
  const fresh = assignments.find((a) => a.id === activeAssignment.id);
  if (fresh) activeAssignment = fresh;
  const box = document.getElementById("deadline-notice");
  if (box) box.innerHTML = renderDeadlineNotice(activeAssignment);
}

// The line shown on the open assignment: the due date, plus a warning box
// while the work is unsubmitted and the deadline is close or gone.
function renderDeadlineNotice(assignment) {
  if (!assignment.deadline) return "";

  const due = `<p class="muted" style="font-size:13px">
      Срок сдачи: <strong>${escapeHtml(formatDeadline(assignment.deadline))}</strong>
    </p>`;

  if (!assignment.deadlineState) return due;

  const overdue = assignment.deadlineState === "overdue";
  return `${due}
    <div class="warning-banner${overdue ? " overdue" : ""}">
      <strong>${overdue ? "Срок сдачи истёк." : "Срок сдачи близко."}</strong>
      Работа ещё не сдана — ${escapeHtml(deadlineHint(assignment))}.
      Нажмите «Submit», когда будете готовы.
    </div>`;
}

async function selectAssignment(assignment) {
  // Leaving the assignment abandons whatever was running on it.
  stopRun();
  closeRunStream();
  activeAssignment = assignment;
  selectedVersionForMessage = null;
  activeVersion = null;
  await loadAssignments(); // re-render sidebar highlight
  await renderMainPanel(); // awaits the editor so loadVersions can fill it
  await Promise.all([
    // Free-form work has no versions - its files are loaded by setupUploads().
    assignmentType() === "freeform" ? Promise.resolve() : loadVersions(),
    loadDiscussion(),
    loadAssignmentFiles(),
    loadGrade(),
  ]);
}

// ---------------------------------------------------------------------
// The grade for this assignment
//
// The teacher's mark, shown on the assignment itself so a student doesn't have
// to go looking for it in the discussion.
// ---------------------------------------------------------------------

function maxScore() {
  const value = activeAssignment && activeAssignment.max_score;
  return Number.isInteger(value) && value > 0 ? value : 15;
}

async function loadGrade() {
  const box = document.getElementById("grade-box");
  if (!box) return;
  let grade = null;
  try {
    ({ grade } = await api(`/api/grades/assignment/${activeAssignment.id}`));
  } catch {
    box.innerHTML = "";
    return;
  }

  // A row can exist with the score cleared - that still counts as ungraded.
  const scored = grade && grade.score !== null && grade.score !== undefined;
  const feedback = grade && grade.feedback ? grade.feedback.trim() : "";

  if (!scored && !feedback) {
    box.innerHTML = `<div class="grade-panel">
        <span class="muted">Оценка: ещё не выставлена. Максимум за задание — ${maxScore()}.</span>
      </div>`;
    return;
  }

  box.innerHTML = `<div class="grade-panel graded">
      <div>Оценка: <span class="score">${
        scored ? escapeHtml(String(grade.score)) : "—"
      }</span> из ${maxScore()}</div>
      ${
        feedback
          ? `<div class="feedback"><strong>Комментарий преподавателя:</strong>\n${escapeHtml(feedback)}</div>`
          : ""
      }
    </div>`;
}

async function renderMainPanel() {
  const main = document.getElementById("main-content");
  main.innerHTML = `
    <div class="card">
      <h2>${escapeHtml(activeAssignment.title)} ${typeBadge(activeAssignment.type)}</h2>
      <p class="muted">${escapeHtml(activeAssignment.description || "")}</p>
      <div id="deadline-notice">${renderDeadlineNotice(activeAssignment)}</div>
      <div id="grade-box"></div>
      <div id="assignment-files"></div>
      ${
        assignmentType() === "code"
          ? '<p class="muted" style="font-size:12px">Note: a file\'s public class must match its file name — <code>Main.java</code> holds <code>public class Main</code>.</p>'
          : ""
      }
    </div>

    ${assignmentType() === "freeform" ? renderUploadCard() : renderWorkCard()}

    <div class="card">
      <h3>Discussion with teacher</h3>
      <div id="linked-version-banner"></div>
      <div class="discussion" id="discussion-list"></div>
      <div class="toolbar">
        <input id="message-input" placeholder="Write a message…" style="flex:1">
        <button id="send-message-btn">Send</button>
      </div>
    </div>
  `;

  const type = assignmentType();
  if (type === "code") {
    await setupEditor();
    document.getElementById("new-file-btn").onclick = addFile;
    document.getElementById("run-btn").onclick = runCode;

    const line = document.getElementById("console-line");
    const submitLine = () => {
      sendConsoleLine(line.value);
      line.value = "";
    };
    document.getElementById("console-stop").onclick = stopRun;
    line.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitLine();
    });
    // Clicking anywhere in the console puts the caret back on the input,
    // the way a terminal behaves.
    document.getElementById("output-panel").addEventListener("click", () => {
      if (!line.hidden && !window.getSelection().toString()) line.focus();
    });
  } else if (type === "text") {
    setupTextEditor();
  } else {
    setupUploads();
  }

  if (type !== "freeform") {
    document.getElementById("save-draft-btn").onclick = () => saveVersion("draft");
    document.getElementById("submit-btn").onclick = () => saveVersion("submitted");
    document.getElementById("rename-version-btn").onclick = renameVersion;
  }
  document.getElementById("send-message-btn").onclick = sendMessage;
  document.getElementById("message-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendMessage();
  });
}

async function setupEditor() {
  await editorReady;
  const container = document.getElementById("editor-container");

  // The assignment's starter project - possibly several files the teacher
  // prepared. Falls back to a bare Main.java if it can't be loaded.
  const fallback =
    activeAssignment.starter_code ||
    "public class Main {\n    public static void main(String[] args) {\n        \n    }\n}\n";
  try {
    const starter = await api(`/api/assignments/${activeAssignment.id}/starter`);
    projectFiles = starter.files.length
      ? starter.files.map((f) => ({ filename: f.filename, content: f.content }))
      : [{ filename: "Main.java", content: fallback }];
    activeFile = starter.entry || projectFiles[0].filename;
  } catch {
    projectFiles = [{ filename: "Main.java", content: fallback }];
    activeFile = "Main.java";
  }

  editor = monaco.editor.create(container, {
    value: currentFile().content,
    language: "java",
    theme: "vs-dark",
    automaticLayout: true,
    fontSize: 14,
    minimap: { enabled: false },
  });
  // The grip under the editor; Monaco's automaticLayout follows the height.
  makeEditorResizable(document.getElementById("editor-layout"));
  renderFileTree();
}

// ---------------------------------------------------------------------
// Text assignments
// ---------------------------------------------------------------------

// The starter text is whatever the teacher prepared; a saved version wins.
function setupTextEditor() {
  const box = document.getElementById("text-editor");
  if (box) box.value = activeAssignment.starter_code || "";
}

function textAnswer() {
  const box = document.getElementById("text-editor");
  return box ? box.value : "";
}

// ---------------------------------------------------------------------
// Console input (what java.util.Scanner reads)
// ---------------------------------------------------------------------

// Everything the student typed into the console during the current run. The
// submitted version is replayed against exactly this, so the result the
// teacher sees matches what the student saw.
function consoleInput() {
  return typedThisRun.length > 0 ? typedThisRun.join("\n") + "\n" : "";
}

// ---------------------------------------------------------------------
// Free-form assignments: attached files
// ---------------------------------------------------------------------

function extensionOf(name) {
  const dot = String(name).lastIndexOf(".");
  return dot === -1 ? "" : String(name).slice(dot).toLowerCase();
}

function showUploadMessage(text, kind) {
  const box = document.getElementById("upload-message");
  if (!box) return;
  box.className = text ? (kind === "error" ? "form-message error" : "form-message success") : "";
  box.textContent = text || "";
}

function setupUploads() {
  const input = document.getElementById("upload-input");
  const button = document.getElementById("upload-btn");

  input.onchange = () => {
    // Warn about a blocked file before anything is sent to the server.
    const rejected = Array.from(input.files).filter((f) =>
      BLOCKED_EXTENSIONS.includes(extensionOf(f.name))
    );
    const tooBig = Array.from(input.files).filter(
      (f) => f.size > MAX_STUDENT_MB * 1024 * 1024
    );

    if (rejected.length > 0) {
      showUploadMessage(
        `Нельзя прикрепить ${rejected
          .map((f) => f.name)
          .join(", ")}: архивы и программы (zip, rar, exe и подобные) не принимаются. Приложите сам документ.`,
        "error"
      );
      input.value = "";
      button.disabled = true;
      return;
    }
    if (tooBig.length > 0) {
      showUploadMessage(
        `Слишком большой файл: ${tooBig
          .map((f) => f.name)
          .join(", ")}. Максимум ${MAX_STUDENT_MB} МБ.`,
        "error"
      );
      input.value = "";
      button.disabled = true;
      return;
    }
    if (input.files.length > MAX_STUDENT_FILES) {
      showUploadMessage(`Можно приложить не больше ${MAX_STUDENT_FILES} файлов.`, "error");
      input.value = "";
      button.disabled = true;
      return;
    }

    showUploadMessage("", null);
    button.disabled = input.files.length === 0;
  };

  button.onclick = uploadFiles;
  loadUploads();
}

async function loadUploads() {
  const box = document.getElementById("upload-list");
  if (!box) return;
  try {
    const { files } = await api(`/api/uploads/assignment/${activeAssignment.id}`);
    uploadedFiles = files;
    if (files.length === 0) {
      box.innerHTML = '<p class="muted">Пока ничего не приложено.</p>';
      return;
    }
    box.innerHTML = "";
    files.forEach((file) => {
      const div = document.createElement("div");
      div.className = "file-item";
      div.innerHTML = `
        <a href="/api/uploads/${file.id}/download">${escapeHtml(file.originalName)}</a>
        <span class="muted">${formatSize(file.size)}</span>`;
      const del = document.createElement("button");
      del.className = "secondary";
      del.style.padding = "2px 8px";
      del.style.fontSize = "12px";
      del.textContent = "Удалить";
      del.onclick = () => deleteUpload(file);
      div.appendChild(del);
      box.appendChild(div);
    });
  } catch (err) {
    box.innerHTML = `<p class="muted">Не удалось загрузить список: ${escapeHtml(err.message)}</p>`;
  }
}

async function uploadFiles() {
  const input = document.getElementById("upload-input");
  const button = document.getElementById("upload-btn");
  const chosen = Array.from(input.files);
  if (chosen.length === 0) return;

  button.disabled = true;
  button.textContent = "Загрузка…";
  try {
    const files = await Promise.all(
      chosen.map(
        (file) =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve({ name: file.name, data: reader.result });
            reader.onerror = () => reject(new Error(`Не удалось прочитать "${file.name}"`));
            reader.readAsDataURL(file);
          })
      )
    );
    await api(`/api/uploads/assignment/${activeAssignment.id}`, {
      method: "POST",
      body: JSON.stringify({ files }),
    });
    input.value = "";
    showUploadMessage("Файлы приложены.", "success");
    await loadUploads();
    await refreshDeadlineState();
  } catch (err) {
    showUploadMessage(err.message, "error");
  } finally {
    button.disabled = true;
    button.textContent = "Attach";
  }
}

async function deleteUpload(file) {
  if (!confirm(`Удалить "${file.originalName}"?`)) return;
  try {
    await api(`/api/uploads/${file.id}`, { method: "DELETE" });
    showUploadMessage("", null);
    await loadUploads();
    await refreshDeadlineState();
  } catch (err) {
    showUploadMessage(err.message, "error");
  }
}

// ---------------------------------------------------------------------
// Project files
// ---------------------------------------------------------------------

const JAVA_FILENAME = /^[A-Za-z_][A-Za-z0-9_]*\.java$/;

function currentFile() {
  return projectFiles.find((f) => f.filename === activeFile) || projectFiles[0];
}

// The editor is the single source of truth while a file is open, so its text
// has to be written back before anything reads the project.
function syncEditorToFile() {
  if (!editor) return;
  const file = currentFile();
  if (file) file.content = editor.getValue();
}

function renderFileTree() {
  const list = document.getElementById("file-list");
  if (!list) return;
  list.innerHTML = "";

  projectFiles.forEach((file) => {
    const div = document.createElement("div");
    div.className = "file-node" + (file.filename === activeFile ? " active" : "");

    const name = document.createElement("span");
    name.className = "file-node-name";
    name.textContent = file.filename;
    name.title = file.filename; // full name stays readable when ellipsized
    name.onclick = () => openFile(file.filename);
    div.appendChild(name);

    // The open file is the one Run starts from - mark it the way an IDE does.
    if (file.filename === activeFile) {
      const badge = document.createElement("span");
      badge.className = "entry-badge";
      badge.textContent = "main";
      badge.title = "Run starts from this file";
      div.appendChild(badge);
    } else if (isEditable() && projectFiles.length > 1) {
      const del = document.createElement("button");
      del.className = "delete-file";
      del.textContent = "×";
      del.title = "Delete file";
      del.onclick = (e) => {
        e.stopPropagation();
        deleteFile(file.filename);
      };
      div.appendChild(del);
    }

    list.appendChild(div);
  });

  const newBtn = document.getElementById("new-file-btn");
  if (newBtn) newBtn.disabled = !isEditable();

  const hint = document.getElementById("entry-hint");
  if (hint) hint.textContent = `▶ Run compiles every file and starts from ${activeFile}`;
}

function openFile(filename) {
  syncEditorToFile();
  activeFile = filename;
  const file = currentFile();
  editor.setValue(file ? file.content : "");
  renderFileTree();
}

function addFile() {
  if (!isEditable()) return;
  const raw = prompt("New file name (e.g. Helper.java):", "Helper.java");
  if (!raw) return;
  const filename = raw.trim().endsWith(".java") ? raw.trim() : `${raw.trim()}.java`;

  if (!JAVA_FILENAME.test(filename)) {
    alert(
      "A Java file name must start with a letter or underscore, contain only letters, digits and underscores, and end with .java — for example Helper.java"
    );
    return;
  }
  if (projectFiles.some((f) => f.filename === filename)) {
    alert(`"${filename}" already exists in this project.`);
    return;
  }

  const className = filename.replace(/\.java$/, "");
  syncEditorToFile();
  projectFiles.push({
    filename,
    content: `public class ${className} {\n    \n}\n`,
  });
  openFile(filename);
}

function deleteFile(filename) {
  if (!isEditable()) return;
  if (projectFiles.length <= 1) return;
  if (!confirm(`Delete ${filename}? This only affects your unsaved project.`)) return;

  projectFiles = projectFiles.filter((f) => f.filename !== filename);
  if (activeFile === filename) {
    activeFile = projectFiles[0].filename;
    editor.setValue(projectFiles[0].content);
  }
  renderFileTree();
}

// Replaces the whole project - used when a saved version is opened.
function loadProject(files, entryFilename) {
  projectFiles = files.map((f) => ({ filename: f.filename, content: f.content }));
  const entry =
    entryFilename && projectFiles.some((f) => f.filename === entryFilename)
      ? entryFilename
      : projectFiles[0].filename;
  activeFile = entry;
  editor.setValue(currentFile().content);
  renderFileTree();
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Handouts the teacher attached to the assignment (PDF, DOCX, ...).
async function loadAssignmentFiles() {
  const { files } = await api(`/api/assignments/${activeAssignment.id}/files`);
  const box = document.getElementById("assignment-files");
  if (!box) return;
  if (!files || files.length === 0) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML =
    `<div class="file-list"><h4>Handouts</h4>` +
    files
      .map(
        (f) =>
          `<div class="file-item">
             <a href="/api/assignments/${activeAssignment.id}/files/${f.id}/download">${escapeHtml(f.originalName)}</a>
             <span class="muted">${formatSize(f.size)}</span>
           </div>`
      )
      .join("") +
    `</div>`;
}

// The newest version (the list comes back ordered by version_number DESC).
function latestVersion() {
  return versions.length > 0 ? versions[0] : null;
}

// Only the latest version is editable; older ones are read-only history.
function isEditable() {
  const latest = latestVersion();
  if (!latest) return true; // nothing saved yet - starter code is editable
  return activeVersion !== null && activeVersion.id === latest.id;
}

// ---------------------------------------------------------------------
// Version names
//
// A student may put a name on a version ("цикл наконец работает") so the
// history reads as something other than a list of numbers. The name is typed
// before saving; a draft can also be renamed afterwards.
// ---------------------------------------------------------------------

function versionTitleValue() {
  const box = document.getElementById("version-title");
  return box ? box.value.trim() : "";
}

function setVersionTitleField(value) {
  const box = document.getElementById("version-title");
  if (box) box.value = value || "";
}

// Shows the name next to the number, e.g. v3 «перед сдачей».
function versionLabel(v) {
  return `v${v.version_number}${v.title ? ` «${v.title}»` : ""}`;
}

async function renameVersion() {
  if (!activeVersion) return;
  const button = document.getElementById("rename-version-btn");
  button.disabled = true;
  try {
    const { submission } = await api(`/api/submissions/${activeVersion.id}/title`, {
      method: "PATCH",
      body: JSON.stringify({ title: versionTitleValue() }),
    });
    activeVersion = { ...activeVersion, title: submission.title };
    setVersionTitleField(submission.title);
    await loadVersions();
  } catch (err) {
    alert("Не удалось переименовать версию: " + err.message);
  } finally {
    button.disabled = false;
  }
}

// Loads a version's whole project into the editor and switches edit/read-only
// mode.
async function openVersion(v) {
  setVersionTitleField(v.title);
  // A text answer is a single blob - no editor, no project tree.
  if (assignmentType() === "text") {
    activeVersion = v;
    const box = document.getElementById("text-editor");
    if (box) box.value = v.code || "";
    await loadVersions();
    return;
  }

  await editorReady;
  activeVersion = v;
  try {
    const { files } = await api(`/api/submissions/${v.id}/files`);
    const entry = (files.find((f) => f.isEntry) || files[0] || {}).filename;
    loadProject(files.length ? files : [{ filename: "Main.java", content: v.code }], entry);
  } catch {
    // Fall back to the single-file view rather than leaving the editor blank.
    loadProject([{ filename: "Main.java", content: v.code }], "Main.java");
  }
  renderOutput(v.last_run_stdout, v.last_run_stderr, v.last_run_status);
  await loadVersions();
}

// Reflects the current mode in the UI: Monaco read-only flag, the save/submit
// buttons, and a banner offering a way back to the latest version.
function applyEditMode() {
  const editable = isEditable();
  if (editor) editor.updateOptions({ readOnly: !editable });
  const textBox = document.getElementById("text-editor");
  if (textBox) textBox.readOnly = !editable;
  // The tree shows delete buttons only while the project is editable.
  if (assignmentType() === "code") renderFileTree();

  const saveBtn = document.getElementById("save-draft-btn");
  const submitBtn = document.getElementById("submit-btn");
  if (saveBtn) saveBtn.disabled = !editable;
  if (submitBtn) submitBtn.disabled = !editable;

  // A version's name can still be changed while it is a draft, including an
  // older one - the name is a label, not part of the work.
  const isDraft = !!activeVersion && activeVersion.status === "draft";
  const renameBtn = document.getElementById("rename-version-btn");
  const titleBox = document.getElementById("version-title");
  if (renameBtn) renameBtn.hidden = !isDraft;
  if (titleBox) titleBox.disabled = !editable && !isDraft;

  const banner = document.getElementById("readonly-banner");
  if (!banner) return;
  if (editable) {
    banner.innerHTML = "";
    return;
  }
  const latest = latestVersion();
  banner.innerHTML = `<p class="muted" style="font-size:12px">
      Viewing v${activeVersion.version_number} — older versions are read-only.
      Continue from v${latest.version_number} to keep working.
    </p>
    <button class="secondary" id="back-to-latest-btn">Back to latest (v${latest.version_number})</button>`;
  document.getElementById("back-to-latest-btn").onclick = () => openVersion(latest);
}

async function loadVersions() {
  const { submissions } = await api(`/api/submissions/assignment/${activeAssignment.id}`);
  versions = submissions;

  // On first load, start the student off on their latest version rather than
  // the starter code - that's the only version they're allowed to build on.
  if (!activeVersion && versions.length > 0 && assignmentType() === "text") {
    const latest = latestVersion();
    activeVersion = latest;
    setVersionTitleField(latest.title);
    const box = document.getElementById("text-editor");
    if (box) box.value = latest.code || "";
  } else if (!activeVersion && versions.length > 0) {
    const latest = latestVersion();
    await editorReady;
    activeVersion = latest;
    setVersionTitleField(latest.title);
    try {
      const { files } = await api(`/api/submissions/${latest.id}/files`);
      const entry = (files.find((f) => f.isEntry) || files[0] || {}).filename;
      loadProject(
        files.length ? files : [{ filename: "Main.java", content: latest.code }],
        entry
      );
    } catch {
      loadProject([{ filename: "Main.java", content: latest.code }], "Main.java");
    }
    renderOutput(latest.last_run_stdout, latest.last_run_stderr, latest.last_run_status);
  }

  const list = document.getElementById("version-list");
  if (!list) return;
  applyEditMode();
  if (versions.length === 0) {
    list.innerHTML = '<p class="muted">No versions saved yet.</p>';
    return;
  }
  list.innerHTML = "";
  versions.forEach((v, idx) => {
    const div = document.createElement("div");
    div.className = "version-item" + (activeVersion && activeVersion.id === v.id ? " active" : "");
    const tag = idx === 0 ? " — latest" : " — read-only";
    div.textContent = `${versionLabel(v)} — ${v.status} — ${new Date(v.created_at).toLocaleString()}${tag}`;
    div.onclick = () => openVersion(v);
    list.appendChild(div);
  });
}

// Shows the recorded result of a saved version, or a compile error.
//
// Writes into the transcript span rather than replacing the panel: the live
// console's input field lives inside this same panel, and clearing its
// innerHTML would delete it - leaving a run with nowhere to print and nowhere
// to type.
function renderOutput(stdout, stderr, status) {
  const panel = document.getElementById("output-panel");
  const target = document.getElementById("terminal-text");
  if (!panel || !target) return;

  const hasError = stderr && stderr.trim().length > 0;
  panel.className = "output-panel terminal" + (hasError ? " error" : "");

  target.textContent = "";
  const statusLine = document.createElement("div");
  statusLine.className = "status-line";
  statusLine.textContent = `Status: ${status || "—"}`;
  target.appendChild(statusLine);
  const body = document.createElement("div");
  body.textContent = (stdout || "") + (stderr ? "\n" + stderr : "") || "(no output)";
  target.appendChild(body);
}

// ---------------------------------------------------------------------
// Running the program interactively
//
// The program stays alive while it runs: output appears as it is printed and
// the student types values when the program asks for them, exactly like a
// console. Anything in the "prepared input" box is sent the moment it starts.
// ---------------------------------------------------------------------

// Appends a chunk to the console transcript, keeping it scrolled to the end.
function appendConsole(type, text) {
  const panel = document.getElementById("output-panel");
  const target = document.getElementById("terminal-text");
  if (!panel || !target) return;
  const span = document.createElement("span");
  span.className = `console-${type}`;
  span.textContent = text;
  target.appendChild(span);
  panel.scrollTop = panel.scrollHeight;
}

function setConsoleRunning(running) {
  const line = document.getElementById("console-line");
  const stop = document.getElementById("console-stop");
  const btn = document.getElementById("run-btn");
  if (line) {
    line.hidden = !running;
    if (running) {
      line.value = "";
      line.focus();
    }
  }
  if (stop) stop.hidden = !running;
  if (btn) {
    btn.disabled = running;
    btn.textContent = running ? "Running…" : "▶ Run";
  }
}

function closeRunStream() {
  if (runStream) {
    runStream.close();
    runStream = null;
  }
  runSessionId = null;
}

async function runCode() {
  await editorReady;
  syncEditorToFile();
  closeRunStream();

  const panel = document.getElementById("output-panel");
  const target = document.getElementById("terminal-text");
  if (panel) panel.className = "output-panel terminal";
  if (target) target.textContent = "";
  // Everything typed during this run becomes the input the submitted version
  // is replayed with, so the teacher sees the same result.
  typedThisRun = [];
  setConsoleRunning(true);

  let started;
  try {
    started = await api("/api/submissions/interactive", {
      method: "POST",
      // Every file is compiled; the open one is the entry point.
      body: JSON.stringify({ files: projectFiles, entry: activeFile }),
    });
  } catch (err) {
    setConsoleRunning(false);
    renderOutput("", err.message, "Error");
    return;
  }

  // A program that doesn't compile never starts - show the errors as before.
  if (started.compileFailed) {
    setConsoleRunning(false);
    const r = started.result;
    renderOutput(r.stdout, r.stderr || r.compileOutput, r.status);
    return;
  }

  runSessionId = started.sessionId;
  runStream = new EventSource(`/api/submissions/interactive/${runSessionId}/stream`);

  runStream.onmessage = (event) => {
    const chunk = JSON.parse(event.data);
    if (chunk.type === "exit") {
      appendConsole("status", `\n— ${chunk.text}\n`);
      closeRunStream();
      setConsoleRunning(false);
      return;
    }
    appendConsole("output", chunk.text);
  };

  runStream.onerror = () => {
    // The stream ends on its own when the program exits; anything else means
    // the connection dropped.
    if (runSessionId) {
      appendConsole("status", "\n— Соединение с программой потеряно.\n");
      closeRunStream();
      setConsoleRunning(false);
    }
  };

}

async function sendConsoleLine(text) {
  if (!runSessionId) return;
  typedThisRun.push(text);
  try {
    await api(`/api/submissions/interactive/${runSessionId}/input`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    appendConsole("status", `\n— ${err.message}\n`);
  }
}

async function stopRun() {
  if (!runSessionId) return;
  try {
    await api(`/api/submissions/interactive/${runSessionId}/stop`, { method: "POST" });
  } catch {
    // The run may have finished on its own between click and request.
  }
}

async function saveVersion(status) {
  const isText = assignmentType() === "text";
  if (!isText) await editorReady;
  if (!isEditable()) {
    alert("This is an older version and can't be saved or submitted. Go back to your latest version first.");
    return;
  }
  if (isText && textAnswer().trim() === "") {
    alert("Напишите ответ, прежде чем сохранять.");
    return;
  }
  if (!isText) syncEditorToFile();
  const btn = status === "submitted" ? document.getElementById("submit-btn") : document.getElementById("save-draft-btn");
  btn.disabled = true;
  try {
    const { submission } = await api(`/api/submissions/assignment/${activeAssignment.id}`, {
      method: "POST",
      body: JSON.stringify({
        // A text answer travels as a single blob; code sends the project
        // together with the console input it should be run against.
        ...(isText
          ? { code: textAnswer() }
          : { files: projectFiles, entry: activeFile, stdin: consoleInput() }),
        status,
        // Optional name for this version, shown in the history instead of a
        // bare number.
        title: versionTitleValue(),
        // Tells the server which version this edit is based on; it rejects
        // anything that isn't the latest one.
        baseVersionId: activeVersion ? activeVersion.id : null,
      }),
    });
    activeVersion = submission;
    setVersionTitleField(submission.title);
    if (!isText) {
      renderOutput(
        submission.last_run_stdout,
        submission.last_run_stderr,
        submission.last_run_status
      );
    }
    await loadVersions();
    // Submitting clears the deadline warning, so refresh what depends on it.
    if (status === "submitted") await refreshDeadlineState();
  } catch (err) {
    alert("Could not save: " + err.message);
    await loadVersions(); // re-sync in case another tab added a newer version
  } finally {
    applyEditMode();
  }
}

async function loadDiscussion() {
  const { messages } = await api(`/api/discussions/assignment/${activeAssignment.id}`);
  const list = document.getElementById("discussion-list");
  if (!list) return;
  list.innerHTML = "";
  if (messages.length === 0) {
    list.innerHTML = '<p class="muted">No messages yet. Ask a question or share a note about your code.</p>';
    return;
  }
  messages.forEach((m) => {
    const div = document.createElement("div");
    div.className = "message " + (m.authorRole === "teacher" ? "teacher" : "student");
    let linked = "";
    if (m.linkedVersion) {
      linked = `<span class="linked-version" data-submission="${m.submission_id}">→ referring to v${m.linkedVersion}</span>`;
    }
    // A student may delete only their own messages.
    const canDelete = currentUser && m.author_id === currentUser.id;
    const deleteBtn = canDelete
      ? `<button class="delete-message" data-message="${m.id}" title="Delete message">×</button>`
      : "";
    div.innerHTML = `<div class="meta">${escapeHtml(m.authorName)} · ${new Date(m.created_at).toLocaleString()}${deleteBtn}</div>
      <div class="body">${escapeHtml(m.body)}</div>${linked}`;
    list.appendChild(div);
  });
  list.scrollTop = list.scrollHeight;

  list.querySelectorAll(".delete-message").forEach((el) => {
    el.onclick = async () => {
      if (!confirm("Delete this message? This can't be undone.")) return;
      try {
        await api(`/api/discussions/messages/${el.dataset.message}`, { method: "DELETE" });
        await loadDiscussion();
      } catch (err) {
        alert("Could not delete message: " + err.message);
      }
    };
  });

  list.querySelectorAll(".linked-version").forEach((el) => {
    el.onclick = async () => {
      const subId = parseInt(el.dataset.submission, 10);
      const v = versions.find((x) => x.id === subId);
      if (v) await openVersion(v); // may switch the editor to read-only mode
    };
  });
}

async function sendMessage() {
  const input = document.getElementById("message-input");
  const body = input.value.trim();
  if (!body) return;
  try {
    await api(`/api/discussions/assignment/${activeAssignment.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body, submissionId: activeVersion ? activeVersion.id : null }),
    });
    input.value = "";
    await loadDiscussion();
  } catch (err) {
    alert("Could not send message: " + err.message);
  }
}

document.getElementById("logout-btn").onclick = async () => {
  await api("/api/auth/logout", { method: "POST" });
  window.location.href = "/login.html";
};

(async function init() {
  initEditor();
  await loadMe();
  await loadAssignments();
})();
