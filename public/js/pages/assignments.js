// /assignments - the tiles, and one assignment's own page at ?id=N.
//
// Everything that happens once an assignment is open (the roster, reviewing a
// student's work, the grade, the discussion, editing the assignment) is the
// shared code in teacher-core.js, unchanged from when it lived behind a
// sidebar. This file is only about choosing what to show.

function assignmentTile(a) {
  const pending = pendingReview.byAssignment[a.id] || 0;
  const created = new Date(a.created_at);
  return `
    <a class="tile" href="/assignments?id=${a.id}">
      <span class="tile-title">${escapeHtml(a.title)}</span>
      <span class="tile-meta">${typeBadge(a.type)}</span>
      <span class="tile-meta muted">создано ${created.toLocaleDateString()}</span>
      <span class="tile-foot ${pending > 0 ? "has-pending" : "muted"}">${
        pending > 0 ? `на проверку: ${pending}` : "на проверку ничего нет"
      }</span>
    </a>`;
}

// True while the tiles are what is on screen. Shared code calls the refresh
// hook after a mark is saved or an assignment changes; redrawing the tiles
// over an open review panel would throw the teacher out of it, so the hook
// only acts when the tiles are what they are looking at.
let showingTiles = false;

async function renderAssignmentTiles() {
  const list = await loadAssignments();
  const main = mainContent();
  showingTiles = true;
  setBackLink("/teacher/dashboard", "← Разделы");

  if (list.length === 0) {
    main.innerHTML = `
      <div class="card">
        <p class="muted">Заданий пока нет. Начните с кнопки «Новое задание».</p>
      </div>`;
    return;
  }

  main.innerHTML = `
    <h2 class="page-title">Задания</h2>
    <div class="tiles">${list.map(assignmentTile).join("")}</div>`;
}

// ?id=N opens that assignment; without it the page is the tiles.
async function openFromUrl() {
  const id = parseInt(new URLSearchParams(window.location.search).get("id"), 10);
  if (Number.isNaN(id)) {
    await renderAssignmentTiles();
    return;
  }

  showingTiles = false;
  setBackLink("/assignments", "← Ко всем заданиям");
  await loadAssignments();
  const assignment = assignments.find((a) => a.id === id);
  if (!assignment) {
    mainContent().innerHTML = `
      <div class="card">
        <p class="muted">Задание не найдено — возможно, оно удалено.</p>
        <a class="button-link secondary" href="/assignments">Ко всем заданиям</a>
      </div>`;
    return;
  }
  await selectAssignment(assignment);
}

async function refreshTilesIfShown() {
  if (showingTiles) await renderAssignmentTiles();
}

(async function initAssignments() {
  // The review screen shows code in a Monaco editor, so this page needs it.
  await initTeacherPage({ withEditor: true, dataChanged: refreshTilesIfShown });
  await openFromUrl();
})();
