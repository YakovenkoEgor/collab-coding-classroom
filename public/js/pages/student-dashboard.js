// /student/dashboard - where a student lands: who they are, and how they are
// doing across every assignment.
//
// The sidebar is the same as everywhere on the student's side; this file only
// fills the middle.

function timelinessCell(row) {
  if (!row.isActive || !row.handedIn) return '<span class="muted">—</span>';
  if (!row.deadline) return '<span class="muted">без дедлайна</span>';
  if (row.timeliness === "onTime") return '<span class="on-time">в срок</span>';
  if (row.timeliness === "late") return '<span class="late">с опозданием</span>';
  return '<span class="muted">—</span>';
}

function statusCell(row) {
  if (!row.isActive) return '<span class="muted">не требует выполнения</span>';
  if (row.handedIn) return '<span class="badge submitted">сдано</span>';
  if (row.started) return '<span class="badge draft">в работе</span>';
  return '<span class="badge">не начато</span>';
}

function scoreCell(row) {
  // A mark already given is a fact, so it is shown even if the assignment was
  // later withdrawn from the group.
  if (!row.isActive && (row.score === null || row.score === undefined)) {
    return '<span class="muted">—</span>';
  }
  // A survey is never marked, so an empty cell there is the answer, not a gap.
  if (row.type === "test" && row.testKind === "survey") {
    return '<span class="muted">не оценивается</span>';
  }
  if (row.score === null || row.score === undefined) {
    return '<span class="muted">—</span>';
  }
  // "из N" needs an N: a withdrawn assignment keeps its mark but loses the
  // scale it was marked on.
  return row.maxScore
    ? `<strong>${row.score}</strong> <span class="muted">из ${row.maxScore}</span>`
    : `<strong>${row.score}</strong>`;
}

function summaryRow(row) {
  // A row for an assignment the group was not given is shown but does not
  // open: there is nothing behind it.
  return `
    <tr class="summary-row${row.isActive ? "" : " is-inactive"}"
        data-id="${row.assignmentId}" data-active="${row.isActive ? "1" : "0"}">
      <td>${escapeHtml(row.title)}</td>
      <td>${typeBadge(row.type)}</td>
      <td>${
        !row.isActive
          ? '<span class="muted">не требует выполнения</span>'
          : row.deadline
            ? escapeHtml(formatDeadline(row.deadline))
            : '<span class="muted">—</span>'
      }</td>
      <td>${statusCell(row)}</td>
      <td>${timelinessCell(row)}</td>
      <td>${scoreCell(row)}</td>
    </tr>`;
}

// What the teacher sees about a student, as the student themselves sees it.
// Their password is not repeated here: they already know it, and a dashboard
// is the one screen likely to be on display to a room.
function profileCard(user) {
  const rows = [
    ["Фамилия", user.lastName],
    ["Имя", user.firstName],
    ["Логин", user.username],
    ["Учебная группа", user.groupName],
    ["Почта", user.email],
  ];
  return `
    <div class="card">
      <h2>${escapeHtml(studentFullName(user))}</h2>
      <table class="profile-table">
        ${rows
          .map(
            ([label, value]) => `
          <tr>
            <td class="muted">${label}</td>
            <td>${value ? escapeHtml(value) : '<span class="muted">не указано</span>'}</td>
          </tr>`
          )
          .join("")}
      </table>
    </div>`;
}

function studentFullName(user) {
  const full = [user.lastName, user.firstName].filter(Boolean).join(" ");
  return full || user.displayName || user.username;
}

function totals(all) {
  // Two different populations: what has to be done is the active assignments,
  // while marks include anything already graded - a withdrawn assignment keeps
  // the mark it was given.
  const active = all.filter((row) => row.isActive);
  const scored = all.filter(
    (row) => row.score !== null && row.score !== undefined && row.maxScore
  );

  const earned = scored.reduce((sum, row) => sum + row.score, 0);
  const possible = scored.reduce((sum, row) => sum + row.maxScore, 0);
  const handedIn = active.filter((row) => row.handedIn).length;
  const late = active.filter((row) => row.timeliness === "late").length;

  const parts = [
    active.length === 0
      ? "заданий к выполнению нет"
      : `сдано работ: ${handedIn} из ${active.length}`,
  ];
  if (scored.length > 0) parts.push(`баллов: ${earned} из ${possible}`);
  if (late > 0) parts.push(`с опозданием: ${late}`);
  return parts.join(" · ");
}

async function renderDashboard() {
  const main = document.getElementById("main-content");

  const [{ user }, { summary }] = await Promise.all([
    api("/api/auth/me"),
    api("/api/assignments/summary/me"),
  ]);

  main.innerHTML = `
    ${profileCard(user)}

    <div class="card">
      <h3>Успеваемость</h3>
      ${
        summary.length === 0
          ? '<p class="muted">Заданий пока нет.</p>'
          : `<table class="summary-table">
               <thead>
                 <tr>
                   <th>Задание</th><th>Тип</th><th>Дедлайн</th>
                   <th>Статус</th><th>Сдача</th><th>Балл</th>
                 </tr>
               </thead>
               <tbody>${summary.map(summaryRow).join("")}</tbody>
             </table>
             <p class="muted" style="font-size:12px">${totals(summary)}</p>`
      }
    </div>`;

  main.querySelectorAll("tr.summary-row").forEach((tr) => {
    if (tr.dataset.active !== "1") return;
    tr.onclick = () => {
      window.location.href = `/student/work?id=${tr.dataset.id}`;
    };
  });
}

(async function initStudentDashboard() {
  await initStudentPage();
  await renderDashboard();
})();
