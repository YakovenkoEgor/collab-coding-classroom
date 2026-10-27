// /assignments/new - the creation form, which is the same form the edit
// screen uses (renderAssignmentForm in teacher-core.js). On save it navigates
// to the new assignment's own page.

(async function initAssignmentNew() {
  await initTeacherPage();
  await renderNewAssignmentForm();
})();
