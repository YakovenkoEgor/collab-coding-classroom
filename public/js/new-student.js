// Standalone page for creating a student account (teacher only).

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

async function loadMe() {
  const { user } = await api("/api/auth/me");
  if (!user || user.role !== "teacher") {
    window.location.href = "/login.html";
    return;
  }
  document.getElementById("whoami").textContent = `${user.displayName} (teacher)`;
}

function showMessage(text, kind) {
  const box = document.getElementById("form-message");
  box.className = kind === "error" ? "form-message error" : "form-message success";
  box.textContent = text;
}

function fields() {
  return {
    firstName: document.getElementById("s-first").value.trim(),
    lastName: document.getElementById("s-last").value.trim(),
    groupName: document.getElementById("s-group").value.trim(),
    username: document.getElementById("s-username").value.trim(),
    email: document.getElementById("s-email").value.trim(),
    password: document.getElementById("s-password").value,
  };
}

function clearForm(keepGroup) {
  const group = document.getElementById("s-group").value;
  ["s-first", "s-last", "s-username", "s-password", "s-group", "s-email"].forEach((id) => {
    document.getElementById(id).value = "";
  });
  // Adding a whole group in one go is the common case, so the group sticks.
  if (keepGroup) document.getElementById("s-group").value = group;
  document.getElementById("s-first").focus();
}

async function createStudent(stayOnPage) {
  const data = fields();

  if (!data.firstName || !data.lastName || !data.username || !data.password) {
    showMessage("First name, last name, username and password are required.", "error");
    return;
  }
  if (data.password.length < 6) {
    showMessage("Password must be at least 6 characters.", "error");
    return;
  }

  const buttons = [
    document.getElementById("create-btn"),
    document.getElementById("create-another-btn"),
  ];
  buttons.forEach((b) => (b.disabled = true));

  try {
    const { user } = await api("/api/auth/users", {
      method: "POST",
      body: JSON.stringify({ ...data, role: "student" }),
    });
    if (stayOnPage) {
      showMessage(
        `Created ${studentName(user)}${user.groupName ? " (" + user.groupName + ")" : ""} — username "${user.username}".`,
        "success"
      );
      clearForm(true);
    } else {
      window.location.href = "/teacher.html";
    }
  } catch (err) {
    showMessage("Could not create student: " + err.message, "error");
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

// ---------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str === null || str === undefined ? "" : String(str);
  return d.innerHTML;
}

// Students are listed surname first, as in teacher.js.
function studentName(row) {
  const last = (row.lastName || "").trim();
  const first = (row.firstName || "").trim();
  if (last && first) return `${last} ${first}`;
  return last || first || row.displayName || "";
}

function showImportMessage(text, kind) {
  const box = document.getElementById("import-message");
  box.className = kind === "error" ? "form-message error" : "form-message success";
  box.textContent = text;
}

const fileInput = document.getElementById("i-file");
fileInput.onchange = () => {
  document.getElementById("import-btn").disabled = fileInput.files.length === 0;
};

document.getElementById("import-btn").onclick = async () => {
  const file = fileInput.files[0];
  if (!file) return;

  const btn = document.getElementById("import-btn");
  btn.disabled = true;
  btn.textContent = "Importing…";
  try {
    const csv = await file.text();
    const result = await api("/api/auth/users/import", {
      method: "POST",
      body: JSON.stringify({ csv, groupName: document.getElementById("i-group").value.trim() }),
    });
    renderImportResult(result);
  } catch (err) {
    showImportMessage("Import failed: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Import students";
  }
};

function renderImportResult({ created, errors, total }) {
  showImportMessage(
    `Read ${total} row(s): ${created.length} student(s) created, ${errors.length} skipped.`,
    errors.length > 0 && created.length === 0 ? "error" : "success"
  );

  const box = document.getElementById("import-result");
  box.innerHTML = "";

  if (created.length > 0) {
    box.innerHTML += `
      <h3>Created accounts</h3>
      <p class="muted" style="font-size:12px">
        Write these down or copy them now — they are also kept in each student's profile.
      </p>
      <table>
        <thead><tr><th>Student</th><th>Login</th><th>Password</th><th>Email</th></tr></thead>
        <tbody>
          ${created
            .map(
              (c) => `<tr>
                <td>${escapeHtml(studentName(c))}</td>
                <td><code>${escapeHtml(c.username)}</code></td>
                <td><code>${escapeHtml(c.password)}</code></td>
                <td class="muted">${escapeHtml(c.email || "—")}</td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
  }

  if (errors.length > 0) {
    box.innerHTML += `
      <h3>Skipped rows</h3>
      <table>
        <thead><tr><th>Line</th><th>Value</th><th>Reason</th></tr></thead>
        <tbody>
          ${errors
            .map(
              (e) => `<tr>
                <td>${e.line}</td>
                <td>${escapeHtml(e.value)}</td>
                <td class="muted">${escapeHtml(e.error)}</td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
  }
}

// A ready-made file so the expected column order is obvious.
document.getElementById("sample-link").onclick = (e) => {
  e.preventDefault();
  const sample =
    "﻿фамилия;имя;логин;почта\r\n" +
    "Иванов;Иван;ivanov;ivanov@example.com\r\n" +
    "Петрова;Мария;petrova;\r\n";
  const url = URL.createObjectURL(new Blob([sample], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "students-sample.csv";
  a.click();
  URL.revokeObjectURL(url);
};

document.getElementById("create-btn").onclick = () => createStudent(false);
document.getElementById("create-another-btn").onclick = () => createStudent(true);

// Only the single-student form submits on Enter - the import fields below
// have their own button.
document.querySelectorAll('input[id^="s-"]').forEach((input) => {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") createStudent(false);
  });
});

document.getElementById("logout-btn").onclick = async () => {
  await api("/api/auth/logout", { method: "POST" });
  window.location.href = "/login.html";
};

loadMe();
