let currentUser = null;
let assignments = [];
let activeAssignment = null;
let activeStudent = null; // {studentId, displayName}
let versions = [];
let activeVersion = null;
let viewerEditor = null;
let editorReady = null;

// Grading scale: whole numbers 0-15 (mirrored by validation in routes/grades.js)
const MIN_SCORE = 0;
const MAX_SCORE = 15;

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
    div.innerHTML = `<div class="title">${escapeHtml(a.title)}</div>
      <div class="meta">${new Date(a.created_at).toLocaleDateString()}</div>`;
    div.onclick = () => selectAssignment(a);
    container.appendChild(div);
  });
}

document.getElementById("new-assignment-btn").onclick = () => {
  activeAssignment = null;
  activeStudent = null;
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
        <label>Starter code (optional)</label>
        <textarea id="a-starter" rows="6" style="font-family: var(--font-mono)"
          placeholder="public class Main {\n    public static void main(String[] args) {\n\n    }\n}"></textarea>
      </div>
      <button id="create-assignment-btn">Create assignment</button>
    </div>
  `;
  document.getElementById("create-assignment-btn").onclick = async () => {
    const title = document.getElementById("a-title").value.trim();
    const description = document.getElementById("a-desc").value.trim();
    const starterCode = document.getElementById("a-starter").value;
    if (!title) return alert("Title is required");
    try {
      const { assignment } = await api("/api/assignments", {
        method: "POST",
        body: JSON.stringify({ title, description, starterCode }),
      });
      await loadAssignments();
      selectAssignment(assignment);
    } catch (err) {
      alert("Could not create assignment: " + err.message);
    }
  };
}

async function selectAssignment(assignment) {
  activeAssignment = assignment;
  activeStudent = null;
  await loadAssignments();
  await renderOverview();
}

async function renderOverview() {
  const { students } = await api(`/api/assignments/${activeAssignment.id}/overview`);
  const main = document.getElementById("main-content");
  main.innerHTML = `
    <div class="card">
      <h2>${escapeHtml(activeAssignment.title)}</h2>
      <p class="muted">${escapeHtml(activeAssignment.description || "")}</p>
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
  if (students.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">No students yet — add some in the sidebar.</td></tr>';
    return;
  }
  students.forEach((s) => {
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
      <div class="editor-wrap" id="editor-container"></div>
      <div class="output-panel" id="output-panel">Select a version to view its output.</div>
    </div>

    <div class="card">
      <h3>Grade</h3>
      <div class="grade-box">
        <label class="muted">Score (0–${MAX_SCORE}):</label>
        <input type="number" id="grade-score" min="${MIN_SCORE}" max="${MAX_SCORE}" step="1">
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
    div.onclick = async () => {
      await editorReady;
      viewerEditor.setValue(v.code);
      activeVersion = v;
      renderOutput(v.last_run_stdout, v.last_run_stderr, v.last_run_status);
      loadVersions();
    };
    list.appendChild(div);
    if (idx === 0 && !activeVersion) div.click(); // auto-select latest
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

async function loadGrade() {
  const { grade } = await api(
    `/api/grades/assignment/${activeAssignment.id}?studentId=${activeStudent.studentId}`
  );
  const scoreInput = document.getElementById("grade-score");
  if (scoreInput && grade) scoreInput.value = grade.score ?? "";
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
    div.innerHTML = `<div class="meta">${escapeHtml(m.authorName)} · ${new Date(m.created_at).toLocaleString()}</div>
      <div class="body">${escapeHtml(m.body)}</div>${linked}`;
    list.appendChild(div);
  });
  list.scrollTop = list.scrollHeight;

  list.querySelectorAll(".linked-version").forEach((el) => {
    el.onclick = async () => {
      const subId = parseInt(el.dataset.submission, 10);
      const v = versions.find((x) => x.id === subId);
      if (v) {
        await editorReady;
        viewerEditor.setValue(v.code);
        activeVersion = v;
        renderOutput(v.last_run_stdout, v.last_run_stderr, v.last_run_status);
      }
    };
  });
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
  if (users.length === 0) {
    container.innerHTML = '<p class="muted">No students yet.</p>';
    return;
  }
  container.innerHTML = users
    .map((u) => `<div class="meta" style="margin-bottom:4px">${escapeHtml(u.displayName)} <span class="muted">(${escapeHtml(u.username)})</span></div>`)
    .join("");
}

document.getElementById("new-student-btn").onclick = async () => {
  const displayName = prompt("Student's display name (e.g. Alex Chen):");
  if (!displayName) return;
  const username = prompt("Login username for this student (e.g. alexc):");
  if (!username) return;
  const password = prompt("Temporary password for this student:");
  if (!password) return;
  try {
    await api("/api/auth/users", {
      method: "POST",
      body: JSON.stringify({ displayName, username, password, role: "student" }),
    });
    await loadStudentManage();
  } catch (err) {
    alert("Could not add student: " + err.message);
  }
};

document.getElementById("logout-btn").onclick = async () => {
  await api("/api/auth/logout", { method: "POST" });
  window.location.href = "/login.html";
};

(async function init() {
  initEditor();
  await loadMe();
  await loadAssignments();
  await loadStudentManage();
})();
