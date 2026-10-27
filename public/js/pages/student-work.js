// /student/work?id=N - one assignment: the editor (or the answer box, the
// attachments, or the test), its versions, the mark and the discussion.
//
// Everything on the screen is the shared code in student-core.js, unchanged
// from when it lived behind a sidebar click. This file only picks which
// assignment to open.

async function openAssignmentFromUrl() {
  const id = parseInt(new URLSearchParams(window.location.search).get("id"), 10);
  const main = document.getElementById("main-content");

  if (Number.isNaN(id)) {
    main.innerHTML = `
      <div class="card">
        <p class="muted">Задание не выбрано.</p>
        <a class="button-link secondary" href="/student/dashboard">К моей успеваемости</a>
      </div>`;
    return;
  }

  const assignment = assignments.find((a) => a.id === id);
  if (!assignment) {
    main.innerHTML = `
      <div class="card">
        <p class="muted">Задание не найдено — возможно, преподаватель его удалил.</p>
        <a class="button-link secondary" href="/student/dashboard">К моей успеваемости</a>
      </div>`;
    return;
  }

  // Mark it in the sidebar before the screen is built: the list was drawn on
  // load, when nothing was open yet.
  activeAssignment = assignment;
  await loadAssignments();

  await selectAssignment(assignment);
}

(async function initStudentWork() {
  // The working screen is built around the code editor.
  await initStudentPage({ withEditor: true });
  await openAssignmentFromUrl();
})();
