// The teacher's front page: where to go, and the two exports that used to be
// command-line scripts only.

// A one-line summary under each tile, so the page says something about the
// course rather than just offering four links. A failure here is silent: the
// links work regardless of whether the counts arrived.
async function loadTileCounts() {
  const pendingTotal = Object.values(pendingReview.byAssignment || {}).reduce(
    (sum, n) => sum + n,
    0
  );

  try {
    const { assignments: list } = await api("/api/assignments");
    document.getElementById("nav-assignments-note").textContent =
      list.length === 0
        ? "пока ни одного"
        : `${list.length} ${plural(list.length, "задание", "задания", "заданий")}` +
          (pendingTotal > 0 ? `, на проверку: ${pendingTotal}` : "");
  } catch {
    /* ignored */
  }

  try {
    const { users } = await api("/api/auth/users");
    const groups = new Set(users.map((u) => u.groupName || "").filter(Boolean));
    document.getElementById("nav-students-note").textContent =
      users.length === 0
        ? "пока никого"
        : `${users.length} ${plural(users.length, "ученик", "ученика", "учеников")}` +
          (groups.size > 0
            ? `, ${groups.size} ${plural(groups.size, "группа", "группы", "групп")}`
            : "");
  } catch {
    /* ignored */
  }

  try {
    const { notifications } = await api("/api/notifications/all");
    const active = notifications.filter((n) => n.active).length;
    document.getElementById("nav-notifications-note").textContent =
      notifications.length === 0 ? "пока ни одного" : `активных: ${active}`;
  } catch {
    /* ignored */
  }

  try {
    const { files } = await api("/api/mirror");
    document.getElementById("nav-mirror-note").textContent =
      files.length === 0
        ? "ничего не раздаётся"
        : `${files.length} ${plural(files.length, "файл", "файла", "файлов")}`;
  } catch {
    /* ignored */
  }
}

// Russian counts need three forms; this is the usual 1 / 2-4 / 5-20 split.
function plural(count, one, few, many) {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = count % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function maintenanceMessage(text, kind) {
  document.getElementById("maintenance-result").innerHTML =
    `<div class="form-message ${kind}" style="white-space:pre-wrap">${escapeHtml(text)}</div>`;
}

// Both buttons run a script on the server and wait for it. A backup of a
// classroom-sized database takes a second or two; the button says what is
// happening meanwhile, because an unexplained pause looks like a hang.
async function runMaintenance(button, path, startedText) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Выполняется…";
  maintenanceMessage(startedText, "");
  try {
    const result = await api(path, { method: "POST" });
    maintenanceMessage(result.output || "Готово.", "success");
  } catch (err) {
    maintenanceMessage(err.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

(async function initDashboard() {
  await initTeacherPage();

  document.getElementById("backup-btn").onclick = (event) =>
    runMaintenance(
      event.currentTarget,
      "/api/maintenance/backup",
      "Делаем копию базы и файлов…"
    );

  document.getElementById("progsnap-btn").onclick = (event) =>
    runMaintenance(
      event.currentTarget,
      "/api/maintenance/progsnap-export",
      "Собираем набор данных…"
    );

  await loadTileCounts();
})();
