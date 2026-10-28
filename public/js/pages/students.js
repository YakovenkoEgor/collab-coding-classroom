// /students - the roster as a list, one student's page at ?id=N, and their
// details at ?id=N&edit=1.
//
// What a student's page shows (their work on every assignment, and the review
// screen behind each row) is the shared code in teacher-core.js, unchanged.
// This file is the list, the filters, and the form for their details.

let roster = [];
let showingRoster = false;

// What the list is filtered and sorted by right now. Kept here rather than
// read back off the inputs, so a redraw after a delete keeps the view.
const view = {
  lastName: "",
  firstName: "",
  username: "",
  groupName: "",
  sortBy: "lastName",
  direction: "asc",
};

const COLUMNS = [
  { key: "lastName", label: "Фамилия" },
  { key: "firstName", label: "Имя" },
  { key: "username", label: "Логин" },
  { key: "groupName", label: "Группа" },
];

function matchesFilters(student) {
  return COLUMNS.every((column) => {
    const needle = view[column.key].trim().toLowerCase();
    if (!needle) return true;
    return String(student[column.key] || "").toLowerCase().includes(needle);
  });
}

function compareStudents(a, b) {
  const key = view.sortBy;
  // Blank values sort last whichever way round the column is, so an unnamed
  // group never pushes real groups out of sight.
  const left = String(a[key] || "");
  const right = String(b[key] || "");
  if (left === "" && right !== "") return 1;
  if (right === "" && left !== "") return -1;
  const result = left.localeCompare(right, "ru");
  return view.direction === "asc" ? result : -result;
}

function sortArrow(key) {
  if (view.sortBy !== key) return '<span class="sort-arrow">↕</span>';
  return `<span class="sort-arrow active">${view.direction === "asc" ? "↑" : "↓"}</span>`;
}

async function loadRoster() {
  const { users } = await api("/api/auth/users");
  roster = users;
}

async function renderRoster() {
  showingRoster = true;
  setBackLink("/teacher/dashboard", "← Разделы");
  const shown = roster.filter(matchesFilters).sort(compareStudents);
  const groups = [...new Set(roster.map((s) => s.groupName || "").filter(Boolean))].sort(
    (a, b) => a.localeCompare(b, "ru")
  );

  mainContent().innerHTML = `
    <h2 class="page-title">Обучающиеся</h2>
    <div class="card">
      <table class="roster">
        <thead>
          <tr>
            ${COLUMNS.map(
              (column) =>
                `<th class="sortable" data-sort="${column.key}">${column.label} ${sortArrow(
                  column.key
                )}</th>`
            ).join("")}
            <th class="roster-actions">Действия</th>
          </tr>
          <tr class="filter-row">
            <th><input class="filter" data-filter="lastName" placeholder="фильтр"
                       value="${escapeHtml(view.lastName)}"></th>
            <th><input class="filter" data-filter="firstName" placeholder="фильтр"
                       value="${escapeHtml(view.firstName)}"></th>
            <th><input class="filter" data-filter="username" placeholder="фильтр"
                       value="${escapeHtml(view.username)}"></th>
            <th>
              <select class="filter" data-filter="groupName">
                <option value="">все группы</option>
                ${groups
                  .map(
                    (group) =>
                      `<option value="${escapeHtml(group)}"${
                        view.groupName === group ? " selected" : ""
                      }>${escapeHtml(group)}</option>`
                  )
                  .join("")}
              </select>
            </th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${
            shown.length === 0
              ? `<tr><td colspan="5" class="muted">${
                  roster.length === 0
                    ? "Учеников пока нет."
                    : "Под фильтр никто не подходит."
                }</td></tr>`
              : shown.map(rosterRow).join("")
          }
        </tbody>
      </table>
      <p class="muted" style="font-size:12px">Показано: ${shown.length} из ${roster.length}.</p>
    </div>`;

  wireRosterControls();
}

function rosterRow(student) {
  return `
    <tr class="roster-row" data-id="${student.id}">
      <td>${escapeHtml(student.lastName || "")}${reviewBadge(
        pendingReview.byStudent[student.id],
        "student"
      )}</td>
      <td>${escapeHtml(student.firstName || "")}</td>
      <td class="mono">${escapeHtml(student.username)}</td>
      <td>${escapeHtml(student.groupName || "—")}</td>
      <td class="roster-actions">
        <button class="secondary small" data-edit="${student.id}"
                title="Изменить данные ученика">Изменить</button>
        <button class="delete-file" data-delete="${student.id}"
                title="Удалить ученика">×</button>
      </td>
    </tr>`;
}

function wireRosterControls() {
  mainContent()
    .querySelectorAll("th.sortable")
    .forEach((th) => {
      th.onclick = () => {
        const key = th.dataset.sort;
        if (view.sortBy === key) {
          view.direction = view.direction === "asc" ? "desc" : "asc";
        } else {
          view.sortBy = key;
          view.direction = "asc";
        }
        renderRoster();
      };
    });

  mainContent()
    .querySelectorAll("input.filter")
    .forEach((input) => {
      input.oninput = () => {
        view[input.dataset.filter] = input.value;
        renderRoster();
        // Redrawing the table replaces the input, so put the cursor back where
        // the teacher was typing.
        const again = mainContent().querySelector(
          `input.filter[data-filter="${input.dataset.filter}"]`
        );
        if (again) {
          again.focus();
          again.setSelectionRange(again.value.length, again.value.length);
        }
      };
    });

  mainContent()
    .querySelectorAll("select.filter")
    .forEach((select) => {
      select.onchange = () => {
        view[select.dataset.filter] = select.value;
        renderRoster();
      };
    });

  mainContent()
    .querySelectorAll("button[data-edit]")
    .forEach((button) => {
      button.onclick = (event) => {
        event.stopPropagation(); // the row underneath opens the student's work
        window.location.href = `/students?id=${button.dataset.edit}&edit=1`;
      };
    });

  mainContent()
    .querySelectorAll("button[data-delete]")
    .forEach((button) => {
      button.onclick = (event) => {
        event.stopPropagation();
        deleteStudent(Number(button.dataset.delete));
      };
    });

  mainContent()
    .querySelectorAll("tr.roster-row")
    .forEach((tr) => {
      tr.onclick = () => {
        window.location.href = `/students?id=${tr.dataset.id}`;
      };
    });
}

// ---------- Deleting ----------

async function deleteStudent(studentId) {
  const student = roster.find((s) => s.id === studentId);
  if (!student) return;

  let impact = null;
  try {
    const details = await api(`/api/auth/users/${studentId}`);
    impact = (details.assignments || []).filter((row) => row.latestVersion || row.score !== null);
  } catch {
    /* the warning below is still worth showing without the count */
  }

  const lines = [
    `Удалить ученика ${studentName(student)} (${student.username})?`,
    "",
    "Вместе с ним удалятся все его работы, оценки, обсуждения,",
    "пройденные тесты и записи о его действиях на платформе.",
    ...(impact && impact.length > 0 ? ["", `Заданий с его работами или оценками: ${impact.length}.`] : []),
    "",
    "Отменить это будет нельзя. Для подтверждения введите логин ученика.",
  ];

  const answer = prompt(lines.join("\n"), "");
  if (answer === null) return;

  try {
    await api(`/api/auth/users/${studentId}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmUsername: answer.trim() }),
    });
    await loadRoster();
    await loadPendingReview();
    await renderRoster();
  } catch (err) {
    alert("Не удалось удалить: " + err.message);
  }
}

// ---------- The details form ----------

function studentFormMessage(text, kind) {
  const box = document.getElementById("student-form-message");
  if (box) box.innerHTML = `<div class="form-message ${kind}">${escapeHtml(text)}</div>`;
}

async function renderStudentForm(studentId) {
  showingRoster = false;
  setBackLink("/students", "← Ко всем обучающимся");
  const { student } = await api(`/api/auth/users/${studentId}`);

  mainContent().innerHTML = `
    <div class="card">
      <a class="back-link" href="/students?id=${student.id}">← К работам ученика</a>
      <h2 style="margin-top:10px">Данные ученика</h2>
      <div id="student-form-message"></div>

      <div class="form-row">
        <label for="st-last">Фамилия</label>
        <input id="st-last" value="${escapeHtml(student.lastName || "")}">
      </div>
      <div class="form-row">
        <label for="st-first">Имя</label>
        <input id="st-first" value="${escapeHtml(student.firstName || "")}">
      </div>
      <div class="form-row">
        <label for="st-login">Логин</label>
        <input id="st-login" value="${escapeHtml(student.username)}">
        <span class="muted" style="font-size:12px">
          Без пробелов. Если изменить — ученик входит уже по новому логину.
        </span>
      </div>
      <div class="form-row">
        <label for="st-group">Учебная группа</label>
        <input id="st-group" value="${escapeHtml(student.groupName || "")}"
               placeholder="например: ИП-21">
        <span class="muted" style="font-size:12px">
          По группе назначаются отдельные сроки и баллы за задания.
        </span>
      </div>
      <div class="form-row">
        <label for="st-email">Почта (необязательно)</label>
        <input id="st-email" type="email" value="${escapeHtml(student.email || "")}">
      </div>
      <div class="form-row">
        <label for="st-password">Новый пароль</label>
        <input id="st-password" placeholder="оставьте пустым, чтобы не менять">
        <span class="muted" style="font-size:12px">
          Не короче 6 символов. Текущий пароль: <code>${escapeHtml(
            student.initialPassword || "неизвестен — был изменён учеником"
          )}</code>
        </span>
      </div>

      <div class="button-row">
        <button id="st-save">Сохранить</button>
        <a class="button-link secondary" href="/students">Отмена</a>
      </div>
    </div>`;

  document.getElementById("st-save").onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api(`/api/auth/users/${student.id}`, {
        method: "PUT",
        body: JSON.stringify({
          lastName: document.getElementById("st-last").value,
          firstName: document.getElementById("st-first").value,
          username: document.getElementById("st-login").value,
          groupName: document.getElementById("st-group").value,
          email: document.getElementById("st-email").value,
          password: document.getElementById("st-password").value,
        }),
      });
      window.location.href = `/students?id=${student.id}`;
    } catch (err) {
      studentFormMessage(err.message, "error");
      button.disabled = false;
    }
  };
}

// ---------- Choosing what the page shows ----------

async function openStudentFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const id = parseInt(params.get("id"), 10);

  if (Number.isNaN(id)) {
    await renderRoster();
    return;
  }
  if (params.get("edit") === "1") {
    await renderStudentForm(id);
    return;
  }

  showingRoster = false;
  setBackLink("/students", "← Ко всем обучающимся");
  // The profile's rows are matched against the assignment list, so the shared
  // code loads it itself; this only has to ask for the student.
  await selectStudentProfile(id);
}

async function refreshRosterIfShown() {
  if (showingRoster) {
    await loadRoster();
    await renderRoster();
  }
}

(async function initStudents() {
  // Reviewing a student's work shows code in a Monaco editor.
  await initTeacherPage({ withEditor: true, dataChanged: refreshRosterIfShown });
  await loadRoster();
  await openStudentFromUrl();
})();
