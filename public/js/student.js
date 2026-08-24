let currentUser = null;
let assignments = [];
let activeAssignment = null;
let versions = [];
let activeVersion = null; // the version currently loaded into the editor
let projectFiles = []; // [{ filename, content }] - the project in the editor
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
      <div class="meta">${
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
  activeAssignment = assignment;
  selectedVersionForMessage = null;
  activeVersion = null;
  await loadAssignments(); // re-render sidebar highlight
  await renderMainPanel(); // awaits the editor so loadVersions can fill it
  await Promise.all([loadVersions(), loadDiscussion(), loadAssignmentFiles()]);
}

async function renderMainPanel() {
  const main = document.getElementById("main-content");
  main.innerHTML = `
    <div class="card">
      <h2>${escapeHtml(activeAssignment.title)}</h2>
      <p class="muted">${escapeHtml(activeAssignment.description || "")}</p>
      <div id="deadline-notice">${renderDeadlineNotice(activeAssignment)}</div>
      <div id="assignment-files"></div>
      <p class="muted" style="font-size:12px">Note: a file's public class must match its file name — <code>Main.java</code> holds <code>public class Main</code>.</p>
    </div>

    <div class="card">
      <h3>Code editor</h3>
      <div class="editor-layout">
        <div class="file-tree">
          <div class="file-tree-header">Project</div>
          <div id="file-list"></div>
          <button class="secondary" id="new-file-btn">+ New file</button>
        </div>
        <div class="editor-wrap" id="editor-container"></div>
      </div>
      <div id="entry-hint" class="muted"></div>
      <div id="readonly-banner"></div>
      <div class="toolbar">
        <button id="run-btn">▶ Run</button>
        <button class="secondary" id="save-draft-btn">Save draft</button>
        <button id="submit-btn">Submit</button>
      </div>
      <div class="output-panel" id="output-panel">Output will appear here.</div>
    </div>

    <div class="card">
      <h3>Version history</h3>
      <div class="version-list" id="version-list"><p class="muted">Loading…</p></div>
    </div>

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

  await setupEditor();
  document.getElementById("new-file-btn").onclick = addFile;
  document.getElementById("run-btn").onclick = runCode;
  document.getElementById("save-draft-btn").onclick = () => saveVersion("draft");
  document.getElementById("submit-btn").onclick = () => saveVersion("submitted");
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
  renderFileTree();
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

// Loads a version's whole project into the editor and switches edit/read-only
// mode.
async function openVersion(v) {
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
  // The tree shows delete buttons only while the project is editable.
  renderFileTree();

  const saveBtn = document.getElementById("save-draft-btn");
  const submitBtn = document.getElementById("submit-btn");
  if (saveBtn) saveBtn.disabled = !editable;
  if (submitBtn) submitBtn.disabled = !editable;

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
  if (!activeVersion && versions.length > 0) {
    const latest = latestVersion();
    await editorReady;
    activeVersion = latest;
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
    div.textContent = `v${v.version_number} — ${v.status} — ${new Date(v.created_at).toLocaleString()}${tag}`;
    div.onclick = () => openVersion(v);
    list.appendChild(div);
  });
}

function renderOutput(stdout, stderr, status) {
  const panel = document.getElementById("output-panel");
  if (!panel) return;
  const hasError = stderr && stderr.trim().length > 0;
  panel.className = "output-panel" + (hasError ? " error" : "");
  panel.innerHTML = "";
  const statusLine = document.createElement("div");
  statusLine.className = "status-line";
  statusLine.textContent = `Status: ${status || "—"}`;
  panel.appendChild(statusLine);
  const pre = document.createElement("div");
  pre.textContent = (stdout || "") + (stderr ? "\n" + stderr : "") || "(no output)";
  panel.appendChild(pre);
}

async function runCode() {
  await editorReady;
  syncEditorToFile();
  const btn = document.getElementById("run-btn");
  btn.disabled = true;
  btn.textContent = "Running…";
  try {
    const result = await api("/api/submissions/run", {
      method: "POST",
      // Every file is compiled; the open one is the entry point.
      body: JSON.stringify({ files: projectFiles, entry: activeFile }),
    });
    renderOutput(result.stdout, result.stderr || result.compileOutput, result.status);
  } catch (err) {
    renderOutput("", err.message, "Error");
  } finally {
    btn.disabled = false;
    btn.textContent = "▶ Run";
  }
}

async function saveVersion(status) {
  await editorReady;
  if (!isEditable()) {
    alert("This is an older version and can't be saved or submitted. Go back to your latest version first.");
    return;
  }
  syncEditorToFile();
  const btn = status === "submitted" ? document.getElementById("submit-btn") : document.getElementById("save-draft-btn");
  btn.disabled = true;
  try {
    const { submission } = await api(`/api/submissions/assignment/${activeAssignment.id}`, {
      method: "POST",
      body: JSON.stringify({
        files: projectFiles,
        entry: activeFile,
        status,
        // Tells the server which version this edit is based on; it rejects
        // anything that isn't the latest one.
        baseVersionId: activeVersion ? activeVersion.id : null,
      }),
    });
    activeVersion = submission;
    renderOutput(submission.last_run_stdout, submission.last_run_stderr, submission.last_run_status);
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
