// /student/dashboard - where a student lands: who they are, and how they are
// doing across every assignment.
//
// The sidebar is the same as everywhere on the student's side; this file only
// fills the middle.

function timelinessCell(row) {
  if (!row.handedIn) return '<span class="muted">—</span>';
  if (!row.deadline) return '<span class="muted">без дедлайна</span>';
  if (row.timeliness === "onTime") return '<span class="on-time">в срок</span>';
  if (row.timeliness === "late") return '<span class="late">с опозданием</span>';
  return '<span class="muted">—</span>';
}

function statusCell(row) {
  if (row.handedIn) return '<span class="badge submitted">сдано</span>';
  if (row.started) return '<span class="badge draft">в работе</span>';
  return '<span class="badge">не начато</span>';
}

function scoreCell(row) {
  // A survey is never marked, so an empty cell there is the answer, not a gap.
  if (row.type === "test" && row.testKind === "survey") {
    return '<span class="muted">не оценивается</span>';
  }
  if (row.score === null || row.score === undefined) {
    return '<span class="muted">—</span>';
  }
  return `<strong>${row.score}</strong> <span class="muted">из ${row.maxScore}</span>`;
}

function summaryRow(row) {
  return `
    <tr class="summary-row" data-id="${row.assignmentId}">
      <td>${escapeHtml(row.title)}</td>
      <td>${typeBadge(row.type)}</td>
      <td>${row.deadline ? escapeHtml(formatDeadline(row.deadline)) : '<span class="muted">—</span>'}</td>
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

function totals(summary) {
  const scored = summary.filter(
    (row) => row.score !== null && row.score !== undefined
  );
  const earned = scored.reduce((sum, row) => sum + row.score, 0);
  const possible = scored.reduce((sum, row) => sum + (row.maxScore || 0), 0);
  const late = summary.filter((row) => row.timeliness === "late").length;
  const handedIn = summary.filter((row) => row.handedIn).length;

  const parts = [`сдано работ: ${handedIn} из ${summary.length}`];
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
    tr.onclick = () => {
      window.location.href = `/student/work?id=${tr.dataset.id}`;
    };
  });
}

(async function initStudentDashboard() {
  await initStudentPage();
  await renderDashboard();
})();
