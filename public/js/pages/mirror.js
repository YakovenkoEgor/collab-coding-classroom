// /mirror - the "Файлы по сети" panel, unchanged; it just has a page of its
// own now instead of a button in the sidebar.

(async function initMirror() {
  await initTeacherPage();
  await renderMirrorPanel();
})();
