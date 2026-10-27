// /notifications - announcements as tiles, and one of them at ?id=N.
//
// The form itself (writing, editing, deleting) is renderNotificationForm in
// teacher-core.js, unchanged.

let notificationList = [];
let showingNotificationTiles = false;

function notificationTile(item) {
  // The tile keeps the teacher's line breaks, but not the blank lines between
  // paragraphs: it shows four lines at most, and a gap would eat one of them.
  const preview = item.body.replace(/\n{2,}/g, "\n");
  const text = preview.length > 140 ? `${preview.slice(0, 140)}…` : preview;
  return `
    <a class="tile ${item.active ? "" : "is-dismissed"}" href="/notifications?id=${item.id}">
      <span class="tile-title">${escapeHtml(text)}</span>
      <span class="tile-meta muted">${
        item.authorName ? escapeHtml(item.authorName) : "&nbsp;"
      }</span>
      <span class="tile-foot ${item.active ? "has-pending" : "muted"}">${
        item.active
          ? "активно до " + escapeHtml(formatDeadline(item.activeUntil))
          : "истекло " + escapeHtml(formatDeadline(item.activeUntil))
      }</span>
    </a>`;
}

async function renderNotificationTiles() {
  const { notifications: list } = await api("/api/notifications/all");
  notificationList = list;
  showingNotificationTiles = true;
  setBackLink("/teacher/dashboard", "← Разделы");

  const main = mainContent();
  if (list.length === 0) {
    main.innerHTML = `
      <div class="card">
        <p class="muted">Уведомлений пока нет. Напишите первое — ученики увидят
          его плашкой над рабочей областью.</p>
      </div>`;
    return;
  }

  main.innerHTML = `
    <h2 class="page-title">Уведомления</h2>
    <div class="tiles">${list.map(notificationTile).join("")}</div>`;
}

async function openNotificationFromUrl() {
  const id = parseInt(new URLSearchParams(window.location.search).get("id"), 10);
  if (Number.isNaN(id)) {
    await renderNotificationTiles();
    return;
  }

  showingNotificationTiles = false;
  setBackLink("/notifications", "← Ко всем уведомлениям");
  const { notifications: list } = await api("/api/notifications/all");
  notificationList = list;
  const item = list.find((n) => n.id === id);
  if (!item) {
    mainContent().innerHTML = `
      <div class="card">
        <p class="muted">Уведомление не найдено — возможно, оно удалено.</p>
        <a class="button-link secondary" href="/notifications">Ко всем уведомлениям</a>
      </div>`;
    return;
  }
  renderNotificationForm(item);
}

async function refreshNotificationTilesIfShown() {
  if (showingNotificationTiles) await renderNotificationTiles();
}

(async function initNotifications() {
  await initTeacherPage({ dataChanged: refreshNotificationTilesIfShown });
  await openNotificationFromUrl();
})();
