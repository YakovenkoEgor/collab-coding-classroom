let currentUser = null;
let assignments = [];
let activeAssignment = null;
let activeStudent = null; // {studentId, displayName}
let activeProfile = null; // student whose profile page is open, if any
// Counts of submitted-but-ungraded work, keyed by assignment id and student id.
let pendingReview = { byAssignment: {}, byStudent: {} };
let versions = [];
let activeVersion = null;
let editingAssignmentId = null; // set while the form is editing, null when creating
let existingHandouts = []; // handouts already attached to the assignment being edited
let removedHandoutIds = []; // marked for removal, applied on save
let starterFiles = []; // starter project being authored in the new-assignment form
let starterActive = null; // starter file shown in the textarea
let starterEntry = null; // starter file the student's Run will start from
let viewerFiles = []; // files of the version being reviewed
let viewerFile = null; // which of them is shown in the editor
let viewerEditor = null;
let editorReady = null;

// Grading scale: whole numbers from 0 up to the assignment's own maximum,
// which the teacher sets when creating it (mirrored in routes/assignments.js
// and routes/grades.js).
const MIN_SCORE = 0;
const MIN_MAX_SCORE = 1;
const MAX_MAX_SCORE = 100;
const DEFAULT_MAX_SCORE = 15;

// Top mark that applies right now. While one student's work is open it is
// their study group's maximum (groups can have their own - see
// assignmentRules.js); otherwise the assignment's own.
function currentMaxScore() {
  const forStudent = activeStudent && activeStudent.maxScore;
  if (Number.isInteger(forStudent) && forStudent > 0) return forStudent;
  const value = activeAssignment && activeAssignment.max_score;
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_SCORE;
}

// ---------- Student names ----------
//
// Students are listed the way a register lists them: surname first, then given
// name. display_name is stored as "Имя Фамилия", so it is only a fallback for
// rows that predate the split name fields.
function studentName(row) {
  if (!row) return "";
  const last = (row.lastName || "").trim();
  const first = (row.firstName || "").trim();
  if (last && first) return `${last} ${first}`;
  return last || first || row.displayName || "";
}

// Surname-first comparison, so "Ёлкина" and "елкина" land where a teacher
// expects them to.
function byStudentName(a, b) {
  return studentName(a).localeCompare(studentName(b), "ru", { sensitivity: "base" });
}

// Assignment kinds, mirrored from routes/assignments.js
const ASSIGNMENT_TYPES = [
  { value: "code", label: "Code", hint: "a Java project the student runs" },
  { value: "text", label: "Text", hint: "a written answer, versioned the same way" },
  { value: "freeform", label: "Free-form", hint: "the student attaches files" },
];
const TYPE_LABEL = {
  code: "Code",
  text: "Text",
  freeform: "Free-form",
};

// Student attachment limits, mirrored from storage.js
const MAX_STUDENT_FILES = 3;
const MAX_STUDENT_MB = 5;

// A small tag showing an assignment's kind.
function typeBadge(type) {
  const label = TYPE_LABEL[type] || TYPE_LABEL.code;
  return `<span class="type-badge type-${type || "code"}">${label}</span>`;
}

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
      <div class="meta">${typeBadge(a.type)} ${new Date(a.created_at).toLocaleDateString()}</div>`;
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

async function renderNewAssignmentForm() {
  // The study groups the form can set separate rules for. A failure here only
  // costs the group table, so the form still opens - but it says what went
  // wrong instead of claiming there are no groups.
  let groups = null;
  let groupsError = null;
  try {
    ({ groups } = await api("/api/assignments/groups"));
  } catch (err) {
    groupsError = err.message;
  }
  renderAssignmentForm(null, groups, groupsError);
}

// One form for both creating and editing. `existing` is null when creating,
// otherwise { assignment, files, starterFiles, groupRules, groups } as
// returned by the API; `groups` is passed separately when creating.
function renderAssignmentForm(existing, newGroups, groupsError) {
  const editing = !!existing;
  const assignment = editing ? existing.assignment : null;
  editingAssignmentId = editing ? assignment.id : null;
  removedHandoutIds = [];

  // One row per study group, pre-filled with the exception it already has.
  // A missing list (rather than an empty one) means the server didn't send it:
  // usually a server still running a version older than this page's script.
  const groups = editing ? existing.groups : newGroups;
  const groupsProblem =
    groupsError ||
    (Array.isArray(groups)
      ? null
      : "the server did not return the list of study groups — it may still be running an older version (restart it), while the browser already has the new page");
  const ruleByGroup = new Map(
    ((editing && existing.groupRules) || []).map((rule) => [rule.groupName, rule])
  );

  const main = document.getElementById("main-content");
  main.innerHTML = `
    <div class="card">
      ${editing ? '<button class="secondary" id="cancel-edit-btn">← Back</button>' : ""}
      <h2 style="${editing ? "margin-top:10px" : ""}">${
        editing ? "Edit assignment" : "New assignment"
      }</h2>
      <div class="form-row">
        <label>Title</label>
        <input id="a-title" placeholder="e.g. Loops: FizzBuzz" value="${
          editing ? escapeHtml(assignment.title) : ""
        }">
      </div>
      <div class="form-row">
        <label>Assignment type</label>
        <select id="a-type" ${editing ? "" : ""}>
          ${ASSIGNMENT_TYPES.map(
            (t) =>
              `<option value="${t.value}"${
                (editing ? assignment.type : "code") === t.value ? " selected" : ""
              }>${t.label} — ${t.hint}</option>`
          ).join("")}
        </select>
        ${
          editing
            ? '<span class="muted" style="font-size:12px">The type can only be changed while no student has started working.</span>'
            : ""
        }
      </div>
      <div class="form-row">
        <label>Description / instructions</label>
        <textarea id="a-desc" rows="4" placeholder="Explain the task...">${
          editing ? escapeHtml(assignment.description || "") : ""
        }</textarea>
      </div>
      <div class="form-row">
        <label>Maximum score</label>
        <input type="number" id="a-max-score" min="${MIN_MAX_SCORE}" max="${MAX_MAX_SCORE}" step="1"
               value="${editing ? assignment.max_score : DEFAULT_MAX_SCORE}">
        <span class="muted" style="font-size:12px">
          Whole number from ${MIN_MAX_SCORE} to ${MAX_MAX_SCORE}. The grade box
          counts up to it for every group without its own value below.
        </span>
      </div>
      <div class="form-row">
        <label>Deadline (optional)</label>
        <input type="datetime-local" id="a-deadline" value="${
          editing && assignment.deadline
            ? escapeHtml(String(assignment.deadline).replace(" ", "T"))
            : ""
        }">
        <span class="muted" style="font-size:12px">
          Students who haven't submitted are flagged once fewer than two days
          remain. Applies to every group without its own date below.
        </span>
      </div>
      <div class="form-row">
        <label>Per-group deadlines and scores (optional)</label>
        ${renderGroupRuleEditor(groups || [], ruleByGroup, groupsProblem)}
      </div>
      <div class="form-row" id="starter-code-row">
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
      <div class="form-row" id="starter-text-row" style="display:none">
        <label>Starting text (optional)</label>
        <span class="muted" style="font-size:12px">
          Text the student's answer box opens with — a template or a prompt.
        </span>
        <textarea id="a-starter-text" rows="6" style="margin-top:6px">${
          editing && assignment.type === "text"
            ? escapeHtml(assignment.starter_code || "")
            : ""
        }</textarea>
      </div>
      <div class="form-row" id="freeform-note-row" style="display:none">
        <label>Student submissions</label>
        <span class="muted" style="font-size:12px">
          Students attach up to ${MAX_STUDENT_FILES} files, ${MAX_STUDENT_MB} MB each.
          Archives and programs (zip, rar, exe …) are refused. There is nothing
          to prepare here.
        </span>
      </div>
      ${
        editing
          ? `<div class="form-row">
               <label>Current handouts</label>
               <div id="existing-handouts"></div>
             </div>`
          : ""
      }
      <div class="form-row">
        <label>${editing ? "Add more handouts" : "Handouts (optional)"}</label>
        <input type="file" id="a-files" multiple accept="${ALLOWED_UPLOAD_EXTENSIONS.join(",")}">
        <span class="muted" style="font-size:12px">
          PDF, DOCX and similar documents — up to ${MAX_UPLOAD_MB} MB each,
          ${MAX_UPLOAD_FILES} files max. Students can download them from the assignment.
        </span>
        <div id="a-files-list"></div>
      </div>
      <button id="create-assignment-btn">${
        editing ? "Save changes" : "Create assignment"
      }</button>
    </div>
  `;

  const fileInput = document.getElementById("a-files");
  fileInput.onchange = () => renderChosenFiles(fileInput.files);

  // Only one of the three starter sections applies at a time.
  const typeSelect = document.getElementById("a-type");
  const applyTypeToForm = () => {
    const type = typeSelect.value;
    document.getElementById("starter-code-row").style.display =
      type === "code" ? "" : "none";
    document.getElementById("starter-text-row").style.display =
      type === "text" ? "" : "none";
    document.getElementById("freeform-note-row").style.display =
      type === "freeform" ? "" : "none";
  };
  typeSelect.onchange = applyTypeToForm;
  applyTypeToForm();

  if (editing) {
    document.getElementById("cancel-edit-btn").onclick = () => selectAssignment(assignment);
    existingHandouts = existing.files || [];
    renderExistingHandouts();

    starterFiles = (existing.starterFiles || []).map((f) => ({
      filename: f.filename,
      content: f.content,
    }));
    if (starterFiles.length === 0) {
      starterFiles = [{ filename: "Main.java", content: DEFAULT_STARTER }];
    }
    const entryRow = (existing.starterFiles || []).find((f) => f.isEntry);
    starterEntry = entryRow ? entryRow.filename : starterFiles[0].filename;
    starterActive = starterEntry;
  } else {
    // Start every new assignment from a one-file project.
    starterFiles = [{ filename: "Main.java", content: DEFAULT_STARTER }];
    starterEntry = "Main.java";
    starterActive = "Main.java";
  }

  document.getElementById("a-starter").value =
    (starterFiles.find((f) => f.filename === starterActive) || starterFiles[0]).content;
  document.getElementById("a-starter").addEventListener("input", syncStarterTextarea);
  document.getElementById("starter-new-file-btn").onclick = addStarterFile;
  renderStarterTree();

  document.getElementById("create-assignment-btn").onclick = async () => {
    const title = document.getElementById("a-title").value.trim();
    const description = document.getElementById("a-desc").value.trim();
    syncStarterTextarea();
    if (!title) return alert("Title is required");

    const btn = document.getElementById("create-assignment-btn");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = editing ? "Saving…" : "Creating…";
    try {
      const files = await readFilesAsBase64(fileInput.files);
      const body = JSON.stringify({
        title,
        description,
        type: typeSelect.value,
        maxScore: Number(document.getElementById("a-max-score").value),
        files,
        starterFiles,
        starterEntry,
        starterText: document.getElementById("a-starter-text").value,
        deadline: document.getElementById("a-deadline").value,
        groupRules: collectGroupRules(),
        removeFileIds: removedHandoutIds,
      });

      const result = editing
        ? await api(`/api/assignments/${editingAssignmentId}`, { method: "PUT", body })
        : await api("/api/assignments", { method: "POST", body });

      await loadAssignments();
      selectAssignment(result.assignment);
    } catch (err) {
      alert(
        (editing ? "Could not save the assignment: " : "Could not create assignment: ") +
          err.message
      );
      btn.disabled = false;
      btn.textContent = label;
    }
  };
}

// Handouts already attached to the assignment being edited, with a way to
// mark them for removal. Nothing is deleted until the form is saved.
function renderExistingHandouts() {
  const box = document.getElementById("existing-handouts");
  if (!box) return;
  if (existingHandouts.length === 0) {
    box.innerHTML = '<p class="muted" style="font-size:12px">No handouts attached.</p>';
    return;
  }
  box.innerHTML = "";
  existingHandouts.forEach((file) => {
    const marked = removedHandoutIds.includes(file.id);
    const div = document.createElement("div");
    div.className = "file-item";
    div.innerHTML = `
      <span class="${marked ? "muted" : ""}" style="${
        marked ? "text-decoration: line-through" : ""
      }">${escapeHtml(file.originalName)}</span>
      <span class="muted">${formatSize(file.size)}</span>`;
    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.type = "button";
    btn.style.padding = "2px 8px";
    btn.style.fontSize = "12px";
    btn.textContent = marked ? "Keep" : "Remove";
    btn.onclick = () => {
      removedHandoutIds = marked
        ? removedHandoutIds.filter((id) => id !== file.id)
        : [...removedHandoutIds, file.id];
      renderExistingHandouts();
    };
    div.appendChild(btn);
    box.appendChild(div);
  });
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
  const [{ students: roster, groupRules }, { files }] = await Promise.all([
    api(`/api/assignments/${activeAssignment.id}/overview`),
    api(`/api/assignments/${activeAssignment.id}/files`),
  ]);
  const main = document.getElementById("main-content");
  main.innerHTML = `
    <div class="card">
      <h2>${escapeHtml(activeAssignment.title)} ${typeBadge(activeAssignment.type)}</h2>
      <p class="muted">${escapeHtml(activeAssignment.description || "")}</p>
      <p class="muted">
        ${
          activeAssignment.deadline
            ? `Deadline: <strong>${escapeHtml(
                formatDeadline(activeAssignment.deadline)
              )}</strong> · `
            : "No deadline · "
        }max score: <strong>${currentMaxScore()}</strong>
      </p>
      ${renderGroupRuleSummary(groupRules)}
      ${renderFileLinks(activeAssignment.id, files)}
      <div class="toolbar">
        <button class="secondary" id="edit-assignment-btn">Edit assignment</button>
        <button class="secondary danger" id="delete-assignment-btn">Delete assignment</button>
      </div>
    </div>
    <div class="card">
      <h3>Student submissions</h3>
      <table>
        <thead>
          <tr><th>Student</th><th>Group</th><th>Latest version</th><th>Status</th><th>Last activity</th><th>Grade</th></tr>
        </thead>
        <tbody id="student-rows"></tbody>
      </table>
    </div>
  `;
  document.getElementById("edit-assignment-btn").onclick = editActiveAssignment;
  document.getElementById("delete-assignment-btn").onclick = deleteActiveAssignment;

  const tbody = document.getElementById("student-rows");
  if (roster.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">No students yet — add some in the sidebar.</td></tr>';
    return;
  }
  const isFreeform = activeAssignment.type === "freeform";

  // Work that is waiting to be looked at comes first: handed in, then started
  // but not handed in, then untouched - each block alphabetical by surname.
  const handInRank = (s) => {
    if (isFreeform) return s.fileCount > 0 ? 0 : 2;
    if (s.status === "submitted") return 0;
    return s.status ? 1 : 2;
  };
  roster.sort((a, b) => handInRank(a) - handInRank(b) || byStudentName(a, b));

  roster.forEach((s) => {
    // Free-form work has no versions - what a student has is a set of files.
    const handedIn = isFreeform ? s.fileCount > 0 : !!s.status;
    const activity = isFreeform ? s.lastUpload : s.lastActivity;
    const tr = document.createElement("tr");
    tr.className = "student-row";
    tr.innerHTML = `
      <td>${escapeHtml(studentName(s))}${deadlineMark(s)}</td>
      <td class="muted">${escapeHtml(s.groupName || "—")}</td>
      <td>${
        isFreeform
          ? s.fileCount
            ? `${s.fileCount} file${s.fileCount > 1 ? "s" : ""}`
            : "—"
          : s.latestVersion
            ? "v" + s.latestVersion
            : "—"
      }</td>
      <td>${
        handedIn
          ? `<span class="badge ${isFreeform ? "submitted" : s.status}">${
              isFreeform ? "attached" : s.status
            }</span>`
          : '<span class="badge">not started</span>'
      }</td>
      <td class="muted">${activity ? new Date(activity).toLocaleString() : "—"}</td>
      <td>${
        s.score !== null && s.score !== undefined
          ? `${s.score} / ${s.maxScore ?? currentMaxScore()}`
          : "—"
      }</td>
    `;
    tr.onclick = () => selectStudent(s.studentId, studentName(s), s.maxScore);
    tbody.appendChild(tr);
  });
}

// ---------- Per-group deadlines and maximum scores ----------

// The table inside the assignment form. Every study group gets a row; an
// empty field means the group follows the assignment's own value, so clearing
// both fields removes the exception on save.
function renderGroupRuleEditor(groups, ruleByGroup, problem) {
  // Told apart on purpose: "the class has no groups" is a normal state, while
  // "the list could not be read" is a fault worth naming.
  if (problem) {
    return `<div class="form-message error">
        Could not load the study groups: ${escapeHtml(problem)}.
      </div>`;
  }
  if (groups.length === 0) {
    return `<span class="muted" style="font-size:12px">
        There are no study groups yet. Add students with a group and you can
        give each group its own deadline and maximum score here.
      </span>`;
  }

  const rows = groups
    .map((groupName) => {
      const rule = ruleByGroup.get(groupName) || {};
      const deadline = rule.deadline
        ? escapeHtml(String(rule.deadline).replace(" ", "T"))
        : "";
      const maxScore =
        rule.maxScore === null || rule.maxScore === undefined ? "" : rule.maxScore;
      return `<tr data-group="${escapeHtml(groupName)}">
          <td>${escapeHtml(groupName)}</td>
          <td><input type="datetime-local" class="group-deadline" value="${deadline}"></td>
          <td><input type="number" class="group-max-score" step="1"
                     min="${MIN_MAX_SCORE}" max="${MAX_MAX_SCORE}"
                     placeholder="—" value="${maxScore}"></td>
        </tr>`;
    })
    .join("");

  return `<span class="muted" style="font-size:12px">
        Leave a field empty to keep the assignment's own value for that group.
      </span>
      <table class="group-rules">
        <thead><tr><th>Study group</th><th>Deadline</th><th>Max score</th></tr></thead>
        <tbody id="group-rules-body">${rows}</tbody>
      </table>`;
}

// What the group table is currently showing, in the shape the API expects.
// Rows that override nothing are dropped by the server.
function collectGroupRules() {
  return Array.from(document.querySelectorAll("#group-rules-body tr")).map((tr) => ({
    groupName: tr.dataset.group,
    deadline: tr.querySelector(".group-deadline").value,
    maxScore: tr.querySelector(".group-max-score").value,
  }));
}

// The exceptions in force, shown under the assignment's own dates so it is
// clear at a glance which group is on a different schedule or scale.
function renderGroupRuleSummary(groupRules) {
  if (!Array.isArray(groupRules) || groupRules.length === 0) return "";
  const lines = groupRules
    .map((rule) => {
      const deadline = rule.deadline
        ? `deadline ${escapeHtml(formatDeadline(rule.deadline))}`
        : "same deadline";
      const max =
        rule.maxScore !== null && rule.maxScore !== undefined
          ? `max score ${rule.maxScore}`
          : "same max score";
      return `<li><strong>${escapeHtml(rule.groupName)}</strong> — ${deadline}, ${max}</li>`;
    })
    .join("");
  return `<div class="group-rules-summary">
      <span class="muted">Group exceptions:</span>
      <ul>${lines}</ul>
    </div>`;
}

async function editActiveAssignment() {
  try {
    // Fetch the full record: the sidebar list doesn't carry starter files.
    const existing = await api(`/api/assignments/${activeAssignment.id}`);
    renderAssignmentForm(existing);
  } catch (err) {
    alert("Could not open the assignment for editing: " + err.message);
  }
}

async function deleteActiveAssignment() {
  const assignment = activeAssignment;
  let impact;
  try {
    impact = await api(`/api/assignments/${assignment.id}/impact`);
  } catch (err) {
    return alert("Could not check what would be deleted: " + err.message);
  }

  // Spell out what goes with it - this cannot be undone from the UI.
  const lines = [
    `Delete "${assignment.title}"?`,
    "",
    "This also deletes, for every student:",
    `  • ${impact.submissions} saved version(s) from ${impact.students} student(s)`,
    `  • ${impact.grades} grade(s)`,
    `  • ${impact.messages} discussion message(s)`,
    "  • the starter project and any handouts",
    "",
    "This cannot be undone.",
  ];
  if (!confirm(lines.join("\n"))) return;

  try {
    await api(`/api/assignments/${assignment.id}`, { method: "DELETE" });
    activeAssignment = null;
    activeStudent = null;
    await loadPendingReview();
    await loadAssignments();
    document.getElementById("main-content").innerHTML =
      `<div class="card"><p class="muted">Assignment "${escapeHtml(
        assignment.title
      )}" was deleted.</p></div>`;
  } catch (err) {
    alert("Could not delete the assignment: " + err.message);
  }
}

// ---------- Student review ----------

// maxScore is the one that applies to this student (their group's, or the
// assignment's); it is what the grade box counts up to.
async function selectStudent(studentId, displayName, maxScore) {
  activeStudent = { studentId, displayName, maxScore };
  activeVersion = null;
  renderStudentPanel();
  await Promise.all([
    activeAssignment.type === "freeform" ? loadStudentUploads() : loadVersions(),
    loadDiscussion(),
    loadGrade(),
  ]);
}

function renderStudentPanel() {
  const main = document.getElementById("main-content");
  main.innerHTML = `
    <button class="secondary" id="back-to-overview">← Back to overview</button>
    <div class="card" style="margin-top:10px">
      <h2>${escapeHtml(activeStudent.displayName)} — ${escapeHtml(activeAssignment.title)}</h2>
    </div>

    ${
      activeAssignment.type === "freeform"
        ? `<div class="card">
             <h3>Attached files</h3>
             <div id="student-uploads"><p class="muted">Loading…</p></div>
           </div>`
        : `<div class="card">
             <h3>Version history</h3>
             <div class="version-list" id="version-list"><p class="muted">Loading…</p></div>
           </div>

           <div class="card">
             <h3>${activeAssignment.type === "text" ? "Answer" : "Code"}</h3>
             ${
               activeAssignment.type === "text"
                 ? '<div class="text-view" id="text-view">Select a version to read it.</div>'
                 : `<div class="editor-layout" id="editor-layout">
                      <div class="file-tree">
                        <div class="file-tree-header">Project</div>
                        <div id="file-list"><p class="muted" style="font-size:12px">—</p></div>
                      </div>
                      <div class="editor-wrap" id="editor-container"></div>
                    </div>
                    <div id="stdin-used"></div>
                    <div class="output-panel" id="output-panel">Select a version to view its output.</div>`
             }
           </div>`
    }

    <div class="card">
      <h3>Grade</h3>
      <div class="grade-box">
        <label class="muted">Score (0–${currentMaxScore()}):</label>
        <!-- No min/max on purpose: they would stop the stepper dead at the
             bounds, and we want it to wrap around instead. The range is
             enforced in wrapScore(), in saveGrade() and on the server. -->
        <input type="number" id="grade-score" step="1" value="${currentMaxScore()}">
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
  // Only code assignments need the Monaco viewer.
  if (activeAssignment.type === "code") setupViewer();
}

// Free-form work: the student's attachments, downloadable but not editable.
async function loadStudentUploads() {
  const box = document.getElementById("student-uploads");
  if (!box) return;
  try {
    const { files } = await api(
      `/api/uploads/assignment/${activeAssignment.id}?studentId=${activeStudent.studentId}`
    );
    if (files.length === 0) {
      box.innerHTML = '<p class="muted">This student hasn\'t attached anything yet.</p>';
      return;
    }
    box.innerHTML = files
      .map(
        (f) => `<div class="file-item">
            <a href="/api/uploads/${f.id}/download">${escapeHtml(f.originalName)}</a>
            <span class="muted">${formatSize(f.size)} · ${new Date(
              f.createdAt
            ).toLocaleString()}</span>
          </div>`
      )
      .join("");
  } catch (err) {
    box.innerHTML = `<p class="muted">Could not load the files: ${escapeHtml(err.message)}</p>`;
  }
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
  // Same drag-to-resize grip the student has, so long files can be read
  // without scrolling a short window.
  makeEditorResizable(document.getElementById("editor-layout"));
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
    // The student may have named the version; show that name next to its number.
    const name = v.title ? ` «${v.title}»` : "";
    div.textContent = `v${v.version_number}${name} — ${v.status} — ${new Date(v.created_at).toLocaleString()}`;
    div.onclick = () => openVersion(v);
    list.appendChild(div);
    if (idx === 0 && !activeVersion) div.click(); // auto-select latest
  });
}

// Opens a version: loads its files into the read-only tree and shows the
// entry file first.
async function openVersion(v) {
  // A text answer is just read - no editor, no file tree.
  if (activeAssignment.type === "text") {
    activeVersion = v;
    const box = document.getElementById("text-view");
    if (box) box.textContent = v.code || "(empty)";
    loadVersions();
    return;
  }

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
  renderStdinUsed(v.stdin);
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

// Shows the console input the student ran this version against, so output
// that depends on Scanner input can be read in context.
function renderStdinUsed(stdin) {
  const box = document.getElementById("stdin-used");
  if (!box) return;
  if (!stdin || stdin.trim() === "") {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `<div class="stdin-used">
      <div class="stdin-used-title">Ввод программы</div>
      <pre>${escapeHtml(stdin)}</pre>
    </div>`;
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
// from the maximum gives 0, stepping down from 0 gives the maximum. Anything
// further out of range (typed by hand) is clamped rather than wrapped, so
// typing "99" doesn't silently become something else.
function wrapScore(input) {
  const raw = input.value.trim();
  if (raw === "") return; // empty means "no grade" - leave it alone
  const value = Number(raw);
  if (!Number.isInteger(value)) return;

  const max = currentMaxScore();
  if (value > max) {
    input.value = value === max + 1 ? MIN_SCORE : max;
  } else if (value < MIN_SCORE) {
    input.value = value === MIN_SCORE - 1 ? max : MIN_SCORE;
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
      : currentMaxScore();
}

async function saveGrade() {
  const raw = document.getElementById("grade-score").value.trim();
  let score = null;
  if (raw !== "") {
    score = Number(raw);
    const max = currentMaxScore();
    if (!Number.isInteger(score) || score < MIN_SCORE || score > max) {
      alert(`Score must be a whole number between ${MIN_SCORE} and ${max}.`);
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

    members.sort(byStudentName);
    members.forEach((u) => {
      const div = document.createElement("div");
      div.className =
        "assignment-item" +
        (activeProfile && activeProfile.id === u.id ? " active" : "");
      div.innerHTML = `<div class="title">${escapeHtml(studentName(u))}${reviewBadge(pendingReview.byStudent[u.id], "student")}</div>
        <div class="meta">${escapeHtml(u.username)}</div>`;
      div.onclick = () => selectStudentProfile(u.id);
      container.appendChild(div);
    });
  });
}

// ---------- Deadlines ----------

function formatDeadline(deadline) {
  const date = new Date(String(deadline).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? deadline : date.toLocaleString();
}

// Wording for how much time is left (or how long it's been overdue).
function deadlineHint(row) {
  const hours = row.hoursLeft;
  if (hours === null || hours === undefined) return "";
  if (row.deadlineState === "overdue") {
    const late = Math.abs(hours);
    return late < 48
      ? `overdue by ${late} h`
      : `overdue by ${Math.round(late / 24)} d`;
  }
  return hours < 24 ? `${hours} h left` : `${Math.round(hours / 24)} d left`;
}

function deadlineMark(row) {
  if (!row.deadlineState) return "";
  const cls = row.deadlineState === "overdue" ? "deadline-flag overdue" : "deadline-flag";
  const label = row.deadlineState === "overdue" ? "overdue" : "due soon";
  return ` <span class="${cls}" title="${escapeHtml(deadlineHint(row))}">${label}</span>`;
}

// A summary banner above the table, so an at-risk student is obvious without
// reading every row.
function renderDeadlineWarnings(rows) {
  const box = document.getElementById("deadline-warnings");
  if (!box) return;
  const flagged = rows.filter((r) => r.deadlineState);
  if (flagged.length === 0) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `
    <div class="warning-banner">
      <strong>Not handed in yet:</strong>
      <ul>
        ${flagged
          .map(
            (r) =>
              `<li>${escapeHtml(r.title)} — ${escapeHtml(formatDeadline(r.deadline))} (${escapeHtml(deadlineHint(r))})</li>`
          )
          .join("")}
      </ul>
    </div>`;
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
      <h2>${escapeHtml(studentName(student))}</h2>
      <table class="profile-table">
        <tr><td class="muted">Username</td><td>${escapeHtml(student.username)}</td></tr>
        <tr><td class="muted">First name</td><td>${escapeHtml(student.firstName || "—")}</td></tr>
        <tr><td class="muted">Last name</td><td>${escapeHtml(student.lastName || "—")}</td></tr>
        <tr><td class="muted">Study group</td><td>${escapeHtml(student.groupName || "—")}</td></tr>
        <tr><td class="muted">Email</td><td>${escapeHtml(student.email || "—")}</td></tr>
        <tr>
          <td class="muted">Password</td>
          <td>${
            student.initialPassword
              ? `<code>${escapeHtml(student.initialPassword)}</code>
                 <span class="muted" style="font-size:12px">— the password this account was created with</span>`
              : '<span class="muted">not recorded</span>'
          }</td>
        </tr>
      </table>
    </div>
    <div class="card">
      <h3>Assignments</h3>
      <div id="deadline-warnings"></div>
      <table>
        <thead>
          <tr><th>Assignment</th><th>Deadline</th><th>Latest version</th><th>Status</th><th>Last activity</th><th>Grade</th></tr>
        </thead>
        <tbody id="profile-rows"></tbody>
      </table>
    </div>
  `;

  renderDeadlineWarnings(rows);

  const tbody = document.getElementById("profile-rows");
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">No assignments yet.</td></tr>';
    return;
  }
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.className = "student-row";
    tr.innerHTML = `
      <td>${escapeHtml(r.title)}${r.archived ? ' <span class="muted">(archived)</span>' : ""}${deadlineMark(r)}</td>
      <td class="muted">${r.deadline ? formatDeadline(r.deadline) : "—"}</td>
      <td>${r.latestVersion ? "v" + r.latestVersion : "—"}</td>
      <td>${r.status ? `<span class="badge ${r.status}">${r.status}</span>` : '<span class="badge">not started</span>'}</td>
      <td class="muted">${r.lastActivity ? new Date(r.lastActivity).toLocaleString() : "—"}</td>
      <td>${
        r.score !== null && r.score !== undefined
          ? `${r.score} / ${r.maxScore ?? DEFAULT_MAX_SCORE}`
          : "—"
      }</td>
    `;
    // Jump straight to reviewing this student's work on that assignment.
    tr.onclick = async () => {
      const assignment = assignments.find((a) => a.id === r.assignmentId);
      if (!assignment) return;
      activeProfile = null;
      activeAssignment = assignment;
      await loadAssignments();
      await loadStudentManage();
      await selectStudent(student.id, studentName(student), r.maxScore);
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
