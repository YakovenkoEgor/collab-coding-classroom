let currentUser = null;
let assignments = [];
let activeAssignment = null;
let activeStudent = null; // {studentId, displayName}
let activeProfile = null; // student whose profile page is open, if any
// Counts of submitted-but-ungraded work, keyed by assignment id and student id.
let pendingReview = { byAssignment: {}, byStudent: {} };
let versions = [];
let activeVersion = null;
let starterFiles = []; // starter project being authored in the new-assignment form
let starterActive = null; // starter file shown in the textarea
let starterEntry = null; // starter file the student's Run will start from
let viewerFiles = []; // files of the version being reviewed
let viewerFile = null; // which of them is shown in the editor
let viewerEditor = null;
let editorReady = null;

// Grading scale: whole numbers 0-15 (mirrored by validation in routes/grades.js)
const MIN_SCORE = 0;
const MAX_SCORE = 15;

// Upload limits, mirrored from storage.js
const MAX_UPLOAD_MB = 10;
const MAX_UPLOAD_FILES = 10;
const ALLOWED_UPLOAD_EXTENSIONS = [
  ".pdf", ".doc", ".docx", ".odt", ".rtf", ".txt", ".md",
  ".ppt", ".pptx", ".xls", ".xlsx", ".csv", ".png", ".jpg", ".jpeg",
];

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

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}

function initEditor() {
  editorReady = new Promise((resolve) => {
    require.config({ paths: { vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.47.0/min/vs" } });
    require(["vs/editor/editor.main"], () => resolve());
  });
}

async function loadMe() {
  const { user } = await api("/api/auth/me");
  if (!user || user.role !== "teacher") { window.location.href = "/login.html"; return; }
  currentUser = user;
  document.getElementById("whoami").textContent = `${user.displayName} (teacher)`;
}

// ---------- Ungraded work indicator ----------

async function loadPendingReview() {
  try {
    pendingReview = await api("/api/assignments/review/pending");
  } catch {
    // A failure here must not blank out the dashboard - just show no badges.
    pendingReview = { byAssignment: {}, byStudent: {} };
  }
}

// The "!" badge shown next to an assignment title or a student's name.
function reviewBadge(count, what) {
  if (!count) return "";
  const label =
    what === "assignment"
      ? `${count} submission(s) waiting to be graded`
      : `${count} submitted assignment(s) waiting to be graded`;
  return `<span class="needs-review" title="${label}">!</span>`;
}

// ---------- Assignments ----------

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
    div.innerHTML = `<div class="title">${escapeHtml(a.title)}${reviewBadge(pendingReview.byAssignment[a.id], "assignment")}</div>
      <div class="meta">${new Date(a.created_at).toLocaleDateString()}</div>`;
    div.onclick = () => selectAssignment(a);
    container.appendChild(div);
  });
}

document.getElementById("new-assignment-btn").onclick = async () => {
  activeAssignment = null;
  activeStudent = null;
  activeProfile = null;
  await loadAssignments();
  await loadStudentManage();
  renderNewAssignmentForm();
};

function renderNewAssignmentForm() {
  const main = document.getElementById("main-content");
  main.innerHTML = `
    <div class="card">
      <h2>New assignment</h2>
      <div class="form-row">
        <label>Title</label>
        <input id="a-title" placeholder="e.g. Loops: FizzBuzz">
      </div>
      <div class="form-row">
        <label>Description / instructions</label>
        <textarea id="a-desc" rows="4" placeholder="Explain the task..."></textarea>
      </div>
      <div class="form-row">
        <label>Starter project</label>
        <span class="muted" style="font-size:12px">
          The files a student's editor opens with. The one marked
          <span class="entry-badge">main</span> is where their Run starts.
        </span>
        <div class="editor-layout" style="margin-top:6px">
          <div class="file-tree wide" style="height:260px">
            <div class="file-tree-header">Files</div>
            <div id="starter-file-list"></div>
            <button class="secondary" id="starter-new-file-btn" type="button">+ New file</button>
          </div>
          <textarea id="a-starter" style="font-family: var(--font-mono); flex:1; height:260px; resize:vertical"></textarea>
        </div>
      </div>
      <div class="form-row">
        <label>Handouts (optional)</label>
        <input type="file" id="a-files" multiple accept="${ALLOWED_UPLOAD_EXTENSIONS.join(",")}">
        <span class="muted" style="font-size:12px">
          PDF, DOCX and similar documents — up to ${MAX_UPLOAD_MB} MB each,
          ${MAX_UPLOAD_FILES} files max. Students can download them from the assignment.
        </span>
        <div id="a-files-list"></div>
      </div>
      <button id="create-assignment-btn">Create assignment</button>
    </div>
  `;

  const fileInput = document.getElementById("a-files");
  fileInput.onchange = () => renderChosenFiles(fileInput.files);

  // Start every new assignment from a one-file project.
  starterFiles = [{ filename: "Main.java", content: DEFAULT_STARTER }];
  starterActive = "Main.java";
  starterEntry = "Main.java";
  document.getElementById("a-starter").value = DEFAULT_STARTER;
  document.getElementById("a-starter").addEventListener("input", syncStarterTextarea);
  document.getElementById("starter-new-file-btn").onclick = addStarterFile;
  renderStarterTree();

  document.getElementById("create-assignment-btn").onclick = async () => {
    const title = document.getElementById("a-title").value.trim();
    const description = document.getElementById("a-desc").value.trim();
    syncStarterTextarea();
    if (!title) return alert("Title is required");

    const btn = document.getElementById("create-assignment-btn");
    btn.disabled = true;
    btn.textContent = "Creating…";
    try {
      const files = await readFilesAsBase64(fileInput.files);
      const { assignment } = await api("/api/assignments", {
        method: "POST",
        body: JSON.stringify({
          title,
          description,
          files,
          starterFiles,
          starterEntry,
        }),
      });
      await loadAssignments();
      selectAssignment(assignment);
    } catch (err) {
      alert("Could not create assignment: " + err.message);
      btn.disabled = false;
      btn.textContent = "Create assignment";
    }
  };
}

// ---------- Starter project in the new-assignment form ----------

const JAVA_FILENAME = /^[A-Za-z_][A-Za-z0-9_]*\.java$/;
const DEFAULT_STARTER =
  "public class Main {\n    public static void main(String[] args) {\n        \n    }\n}\n";

// The textarea holds whichever starter file is selected, so its text has to be
// written back before the selection changes or the form is submitted.
function syncStarterTextarea() {
  const box = document.getElementById("a-starter");
  if (!box) return;
  const file = starterFiles.find((f) => f.filename === starterActive);
  if (file) file.content = box.value;
}

function openStarterFile(filename) {
  syncStarterTextarea();
  starterActive = filename;
  const file = starterFiles.find((f) => f.filename === filename);
  document.getElementById("a-starter").value = file ? file.content : "";
  renderStarterTree();
}

function renderStarterTree() {
  const list = document.getElementById("starter-file-list");
  if (!list) return;
  list.innerHTML = "";

  starterFiles.forEach((file) => {
    const div = document.createElement("div");
    div.className = "file-node" + (file.filename === starterActive ? " active" : "");

    const name = document.createElement("span");
    name.className = "file-node-name";
    name.textContent = file.filename;
    name.title = file.filename; // full name stays readable when ellipsized
    name.onclick = () => openStarterFile(file.filename);
    div.appendChild(name);

    if (file.filename === starterEntry) {
      const badge = document.createElement("span");
      badge.className = "entry-badge";
      badge.textContent = "main";
      badge.title = "The student's Run starts from this file";
      div.appendChild(badge);
    } else {
      // Unlike the student's editor, the entry file here is chosen explicitly -
      // the teacher is authoring the project, not running it.
      const setEntry = document.createElement("button");
      setEntry.className = "set-entry";
      setEntry.type = "button";
      setEntry.textContent = "set main";
      setEntry.title = "Make this the file the student's Run starts from";
      setEntry.onclick = (e) => {
        e.stopPropagation();
        starterEntry = file.filename;
        renderStarterTree();
      };
      div.appendChild(setEntry);

      const del = document.createElement("button");
      del.className = "delete-file";
      del.type = "button";
      del.textContent = "×";
      del.title = "Remove file";
      del.onclick = (e) => {
        e.stopPropagation();
        removeStarterFile(file.filename);
      };
      div.appendChild(del);
    }

    list.appendChild(div);
  });
}

function addStarterFile() {
  const raw = prompt("New file name (e.g. Helper.java):", "Helper.java");
  if (!raw) return;
  const filename = raw.trim().endsWith(".java") ? raw.trim() : `${raw.trim()}.java`;

  if (!JAVA_FILENAME.test(filename)) {
    alert(
      "A Java file name must start with a letter or underscore, contain only letters, digits and underscores, and end with .java — for example Helper.java"
    );
    return;
  }
  if (starterFiles.some((f) => f.filename === filename)) {
    alert(`"${filename}" already exists in this starter project.`);
    return;
  }

  const className = filename.replace(/\.java$/, "");
  syncStarterTextarea();
  starterFiles.push({ filename, content: `public class ${className} {\n    \n}\n` });
  openStarterFile(filename);
}

function removeStarterFile(filename) {
  if (starterFiles.length <= 1) return;
  if (filename === starterEntry) return; // the entry file can't be removed
  starterFiles = starterFiles.filter((f) => f.filename !== filename);
  if (starterActive === filename) {
    openStarterFile(starterEntry);
  } else {
    renderStarterTree();
  }
}

function renderChosenFiles(fileList) {
  const box = document.getElementById("a-files-list");
  if (!box) return;
  const files = Array.from(fileList || []);
  if (files.length === 0) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = files
    .map(
      (f) =>
        `<div class="file-item"><span class="file-name">${escapeHtml(f.name)}</span>
         <span class="muted">${formatSize(f.size)}</span></div>`
    )
    .join("");
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Reads the picked files into base64 so they can travel inside the JSON body.
// Validation is repeated on the server - this only gives faster feedback.
function readFilesAsBase64(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return Promise.resolve([]);
  if (files.length > MAX_UPLOAD_FILES) {
    return Promise.reject(new Error(`At most ${MAX_UPLOAD_FILES} files can be attached`));
  }
  const tooBig = files.find((f) => f.size > MAX_UPLOAD_MB * 1024 * 1024);
  if (tooBig) {
    return Promise.reject(
      new Error(`"${tooBig.name}" is larger than ${MAX_UPLOAD_MB} MB`)
    );
  }

  return Promise.all(
    files.map(
      (file) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve({ name: file.name, data: reader.result });
          reader.onerror = () => reject(new Error(`Could not read "${file.name}"`));
          reader.readAsDataURL(file);
        })
    )
  );
}

// Renders the download list shown on an existing assignment.
function renderFileLinks(assignmentId, files) {
  if (!files || files.length === 0) return "";
  const items = files
    .map(
      (f) =>
        `<div class="file-item">
           <a href="/api/assignments/${assignmentId}/files/${f.id}/download">${escapeHtml(f.originalName)}</a>
           <span class="muted">${formatSize(f.size)}</span>
         </div>`
    )
    .join("");
  return `<div class="file-list"><h4>Handouts</h4>${items}</div>`;
}

async function selectAssignment(assignment) {
  activeAssignment = assignment;
  activeStudent = null;
  activeProfile = null;
  await loadAssignments();
  await loadStudentManage(); // drop the profile highlight in the sidebar
  await renderOverview();
}

async function renderOverview() {
  // `roster` rather than `students` so it doesn't shadow the sidebar list.
  const [{ students: roster }, { files }] = await Promise.all([
    api(`/api/assignments/${activeAssignment.id}/overview`),
    api(`/api/assignments/${activeAssignment.id}/files`),
  ]);
  const main = document.getElementById("main-content");
  main.innerHTML = `
    <div class="card">
      <h2>${escapeHtml(activeAssignment.title)}</h2>
      <p class="muted">${escapeHtml(activeAssignment.description || "")}</p>
      ${renderFileLinks(activeAssignment.id, files)}
    </div>
    <div class="card">
      <h3>Student submissions</h3>
      <table>
        <thead>
          <tr><th>Student</th><th>Latest version</th><th>Status</th><th>Last activity</th><th>Grade</th></tr>
        </thead>
        <tbody id="student-rows"></tbody>
      </table>
    </div>
  `;
  const tbody = document.getElementById("student-rows");
  if (roster.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">No students yet — add some in the sidebar.</td></tr>';
    return;
  }
  roster.forEach((s) => {
    const tr = document.createElement("tr");
    tr.className = "student-row";
    tr.innerHTML = `
      <td>${escapeHtml(s.displayName)}</td>
      <td>${s.latestVersion ? "v" + s.latestVersion : "—"}</td>
      <td>${s.status ? `<span class="badge ${s.status}">${s.status}</span>` : '<span class="badge">not started</span>'}</td>
      <td class="muted">${s.lastActivity ? new Date(s.lastActivity).toLocaleString() : "—"}</td>
      <td>${s.score !== null && s.score !== undefined ? s.score : "—"}</td>
    `;
    tr.onclick = () => selectStudent(s.studentId, s.displayName);
    tbody.appendChild(tr);
  });
}

// ---------- Student review ----------

async function selectStudent(studentId, displayName) {
  activeStudent = { studentId, displayName };
  activeVersion = null;
  renderStudentPanel();
  await Promise.all([loadVersions(), loadDiscussion(), loadGrade()]);
}

function renderStudentPanel() {
  const main = document.getElementById("main-content");
  main.innerHTML = `
    <button class="secondary" id="back-to-overview">← Back to overview</button>
    <div class="card" style="margin-top:10px">
      <h2>${escapeHtml(activeStudent.displayName)} — ${escapeHtml(activeAssignment.title)}</h2>
    </div>

    <div class="card">
      <h3>Version history</h3>
      <div class="version-list" id="version-list"><p class="muted">Loading…</p></div>
    </div>

    <div class="card">
      <h3>Code</h3>
      <div class="editor-layout">
        <div class="file-tree">
          <div class="file-tree-header">Project</div>
          <div id="file-list"><p class="muted" style="font-size:12px">—</p></div>
        </div>
        <div class="editor-wrap" id="editor-container"></div>
      </div>
      <div class="output-panel" id="output-panel">Select a version to view its output.</div>
    </div>

    <div class="card">
      <h3>Grade</h3>
      <div class="grade-box">
        <label class="muted">Score (0–${MAX_SCORE}):</label>
        <!-- No min/max on purpose: they would stop the stepper dead at the
             bounds, and we want it to wrap around instead. The range is
             enforced in wrapScore(), in saveGrade() and on the server. -->
        <input type="number" id="grade-score" step="1" value="${MAX_SCORE}">
        <button id="save-grade-btn">Save grade</button>
      </div>
    </div>

    <div class="card">
      <h3>Discussion</h3>
      <div class="discussion" id="discussion-list"></div>
      <div class="toolbar">
        <input id="message-input" placeholder="Write feedback or a question…" style="flex:1">
        <button id="send-message-btn">Send</button>
      </div>
    </div>
  `;
  document.getElementById("back-to-overview").onclick = () => {
    activeStudent = null;
    renderOverview();
  };
  document.getElementById("save-grade-btn").onclick = saveGrade;
  // Covers the stepper arrows, the up/down keys and the scroll wheel - all of
  // them fire "input" after the value changes.
  document.getElementById("grade-score").addEventListener("input", (e) => wrapScore(e.target));
  document.getElementById("send-message-btn").onclick = sendMessage;
  document.getElementById("message-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendMessage();
  });
  setupViewer();
}

async function setupViewer() {
  await editorReady;
  const container = document.getElementById("editor-container");
  viewerEditor = monaco.editor.create(container, {
    value: "// Select a version from the list above",
    language: "java",
    theme: "vs-dark",
    automaticLayout: true,
    fontSize: 14,
    minimap: { enabled: false },
    readOnly: true,
  });
}

async function loadVersions() {
  const { submissions } = await api(
    `/api/submissions/assignment/${activeAssignment.id}?studentId=${activeStudent.studentId}`
  );
  versions = submissions;
  const list = document.getElementById("version-list");
  if (!list) return;
  if (versions.length === 0) {
    list.innerHTML = '<p class="muted">This student hasn\'t saved any code yet.</p>';
    return;
  }
  list.innerHTML = "";
  versions.forEach((v, idx) => {
    const div = document.createElement("div");
    div.className = "version-item" + (activeVersion && activeVersion.id === v.id ? " active" : "");
    div.textContent = `v${v.version_number} — ${v.status} — ${new Date(v.created_at).toLocaleString()}`;
    div.onclick = () => openVersion(v);
    list.appendChild(div);
    if (idx === 0 && !activeVersion) div.click(); // auto-select latest
  });
}

// Opens a version: loads its files into the read-only tree and shows the
// entry file first.
async function openVersion(v) {
  await editorReady;
  activeVersion = v;
  try {
    const { files } = await api(`/api/submissions/${v.id}/files`);
    viewerFiles = files.length
      ? files
      : [{ filename: "Main.java", content: v.code, isEntry: 1 }];
  } catch {
    viewerFiles = [{ filename: "Main.java", content: v.code, isEntry: 1 }];
  }
  const entry = viewerFiles.find((f) => f.isEntry) || viewerFiles[0];
  showFile(entry.filename);
  renderOutput(v.last_run_stdout, v.last_run_stderr, v.last_run_status);
  loadVersions();
}

function showFile(filename) {
  const file = viewerFiles.find((f) => f.filename === filename) || viewerFiles[0];
  if (!file) return;
  viewerFile = file.filename;
  viewerEditor.setValue(file.content);
  renderViewerTree();
}

function renderViewerTree() {
  const list = document.getElementById("file-list");
  if (!list) return;
  list.innerHTML = "";
  viewerFiles.forEach((file) => {
    const div = document.createElement("div");
    div.className = "file-node" + (file.filename === viewerFile ? " active" : "");
    const name = document.createElement("span");
    name.className = "file-node-name";
    name.textContent = file.filename;
    name.title = file.filename; // full name stays readable when ellipsized
    div.appendChild(name);
    // Shows which file the student ran, so the reviewer starts in the right place.
    if (file.isEntry) {
      const badge = document.createElement("span");
      badge.className = "entry-badge";
      badge.textContent = "main";
      badge.title = "The student ran the program from this file";
      div.appendChild(badge);
    }
    div.onclick = () => showFile(file.filename);
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

// ---------- Grading ----------

// Makes the score wrap around instead of stopping at the ends: stepping up
// from 15 gives 0, stepping down from 0 gives 15. Anything further out of
// range (typed by hand) is clamped rather than wrapped, so typing "99"
// doesn't silently become 3.
function wrapScore(input) {
  const raw = input.value.trim();
  if (raw === "") return; // empty means "no grade" - leave it alone
  const value = Number(raw);
  if (!Number.isInteger(value)) return;

  if (value > MAX_SCORE) {
    input.value = value === MAX_SCORE + 1 ? MIN_SCORE : MAX_SCORE;
  } else if (value < MIN_SCORE) {
    input.value = value === MIN_SCORE - 1 ? MAX_SCORE : MIN_SCORE;
  }
}

async function loadGrade() {
  const { grade } = await api(
    `/api/grades/assignment/${activeAssignment.id}?studentId=${activeStudent.studentId}`
  );
  const scoreInput = document.getElementById("grade-score");
  if (!scoreInput) return;
  // Ungraded work starts at the top of the scale; an existing grade wins.
  scoreInput.value =
    grade && grade.score !== null && grade.score !== undefined
      ? grade.score
      : MAX_SCORE;
}

async function saveGrade() {
  const raw = document.getElementById("grade-score").value.trim();
  let score = null;
  if (raw !== "") {
    score = Number(raw);
    if (!Number.isInteger(score) || score < MIN_SCORE || score > MAX_SCORE) {
      alert(`Score must be a whole number between ${MIN_SCORE} and ${MAX_SCORE}.`);
      return;
    }
  }
  try {
    await api(`/api/grades/assignment/${activeAssignment.id}`, {
      method: "PUT",
      body: JSON.stringify({
        studentId: activeStudent.studentId,
        score,
      }),
    });
    // Grading is what clears a badge, so refresh both sidebar lists.
    await loadPendingReview();
    await loadAssignments();
    await loadStudentManage();
    alert("Grade saved");
  } catch (err) {
    alert("Could not save grade: " + err.message);
  }
}

// ---------- Discussion ----------

async function loadDiscussion() {
  const { messages } = await api(
    `/api/discussions/assignment/${activeAssignment.id}?studentId=${activeStudent.studentId}`
  );
  const list = document.getElementById("discussion-list");
  if (!list) return;
  list.innerHTML = "";
  if (messages.length === 0) {
    list.innerHTML = '<p class="muted">No messages yet.</p>';
    return;
  }
  messages.forEach((m) => {
    const div = document.createElement("div");
    div.className = "message " + (m.authorRole === "teacher" ? "teacher" : "student");
    let linked = "";
    if (m.linkedVersion) {
      linked = `<span class="linked-version" data-submission="${m.submission_id}">→ referring to v${m.linkedVersion}</span>`;
    }
    // A teacher may delete any message in the thread - their own and the student's.
    div.innerHTML = `<div class="meta">${escapeHtml(m.authorName)} · ${new Date(m.created_at).toLocaleString()}
        <button class="delete-message" data-message="${m.id}" title="Delete message">×</button>
      </div>
      <div class="body">${escapeHtml(m.body)}</div>${linked}`;
    list.appendChild(div);
  });
  list.scrollTop = list.scrollHeight;

  list.querySelectorAll(".delete-message").forEach((el) => {
    el.onclick = () => deleteMessage(parseInt(el.dataset.message, 10));
  });

  list.querySelectorAll(".linked-version").forEach((el) => {
    el.onclick = async () => {
      const subId = parseInt(el.dataset.submission, 10);
      const v = versions.find((x) => x.id === subId);
      if (v) await openVersion(v);
    };
  });
}

async function deleteMessage(messageId) {
  if (!confirm("Delete this message? This can't be undone.")) return;
  try {
    await api(`/api/discussions/messages/${messageId}`, { method: "DELETE" });
    await loadDiscussion();
  } catch (err) {
    alert("Could not delete message: " + err.message);
  }
}

async function sendMessage() {
  const input = document.getElementById("message-input");
  const body = input.value.trim();
  if (!body) return;
  try {
    await api(`/api/discussions/assignment/${activeAssignment.id}/messages?studentId=${activeStudent.studentId}`, {
      method: "POST",
      body: JSON.stringify({ body, submissionId: activeVersion ? activeVersion.id : null }),
    });
    input.value = "";
    await loadDiscussion();
  } catch (err) {
    alert("Could not send message: " + err.message);
  }
}

// ---------- Student management ----------

async function loadStudentManage() {
  const { users } = await api("/api/auth/users");
  const container = document.getElementById("student-manage");
  container.innerHTML = "";
  if (users.length === 0) {
    container.innerHTML = '<p class="muted">No students yet.</p>';
    return;
  }

  // Group students under their study group heading; ungrouped ones last.
  const groups = new Map();
  users.forEach((u) => {
    const key = u.groupName || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(u);
  });

  groups.forEach((members, groupName) => {
    const heading = document.createElement("div");
    heading.className = "group-heading";
    heading.textContent = groupName || "No group";
    container.appendChild(heading);

    members.forEach((u) => {
      const div = document.createElement("div");
      div.className =
        "assignment-item" +
        (activeProfile && activeProfile.id === u.id ? " active" : "");
      div.innerHTML = `<div class="title">${escapeHtml(u.displayName)}${reviewBadge(pendingReview.byStudent[u.id], "student")}</div>
        <div class="meta">${escapeHtml(u.username)}</div>`;
      div.onclick = () => selectStudentProfile(u.id);
      container.appendChild(div);
    });
  });
}

// ---------- Student profile (all assignments for one student) ----------

async function selectStudentProfile(studentId) {
  activeAssignment = null;
  activeStudent = null;
  activeProfile = { id: studentId };
  await loadAssignments(); // clears the assignment highlight

  const { student, assignments: rows } = await api(`/api/auth/users/${studentId}`);
  activeProfile = student;
  await loadStudentManage(); // re-render sidebar highlight

  const main = document.getElementById("main-content");
  main.innerHTML = `
    <div class="card">
      <h2>${escapeHtml(student.displayName)}</h2>
      <table class="profile-table">
        <tr><td class="muted">Username</td><td>${escapeHtml(student.username)}</td></tr>
        <tr><td class="muted">First name</td><td>${escapeHtml(student.firstName || "—")}</td></tr>
        <tr><td class="muted">Last name</td><td>${escapeHtml(student.lastName || "—")}</td></tr>
        <tr><td class="muted">Study group</td><td>${escapeHtml(student.groupName || "—")}</td></tr>
      </table>
    </div>
    <div class="card">
      <h3>Assignments</h3>
      <table>
        <thead>
          <tr><th>Assignment</th><th>Latest version</th><th>Status</th><th>Last activity</th><th>Grade</th></tr>
        </thead>
        <tbody id="profile-rows"></tbody>
      </table>
    </div>
  `;

  const tbody = document.getElementById("profile-rows");
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">No assignments yet.</td></tr>';
    return;
  }
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.className = "student-row";
    tr.innerHTML = `
      <td>${escapeHtml(r.title)}${r.archived ? ' <span class="muted">(archived)</span>' : ""}</td>
      <td>${r.latestVersion ? "v" + r.latestVersion : "—"}</td>
      <td>${r.status ? `<span class="badge ${r.status}">${r.status}</span>` : '<span class="badge">not started</span>'}</td>
      <td class="muted">${r.lastActivity ? new Date(r.lastActivity).toLocaleString() : "—"}</td>
      <td>${r.score !== null && r.score !== undefined ? r.score : "—"}</td>
    `;
    // Jump straight to reviewing this student's work on that assignment.
    tr.onclick = async () => {
      const assignment = assignments.find((a) => a.id === r.assignmentId);
      if (!assignment) return;
      activeProfile = null;
      activeAssignment = assignment;
      await loadAssignments();
      await loadStudentManage();
      await selectStudent(student.id, student.displayName);
    };
    tbody.appendChild(tr);
  });
}

document.getElementById("logout-btn").onclick = async () => {
  await api("/api/auth/logout", { method: "POST" });
  window.location.href = "/login.html";
};

(async function init() {
  initEditor();
  await loadMe();
  await loadPendingReview();
  await loadAssignments();
  await loadStudentManage();
})();
