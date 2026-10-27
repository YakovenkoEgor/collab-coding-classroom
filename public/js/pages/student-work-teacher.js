// /student-assignment-work?student=S&assignment=A - one student's work on one
// assignment, as a page of its own.
//
// The same page is reached two ways: from an assignment's roster, and from a
// student's list of assignments. `from` only decides where the back link goes.
//
// The panel itself - versions, the code viewer, the mark, the discussion, the
// test review - is the shared code in teacher-core.js, unchanged.

// The shared panel checks for this function: its presence is what tells the
// panel it is on a page of its own, so it leaves out its own back button.
function backFromWorkPage() {
  const params = new URLSearchParams(window.location.search);
  const from = params.get("from");
  window.location.href =
    from === "student"
      ? `/students?id=${params.get("student")}`
      : `/assignments?id=${params.get("assignment")}`;
}

function notFound(message) {
  mainContent().innerHTML = `
    <div class="card">
      <p class="muted">${escapeHtml(message)}</p>
      <div class="button-row">
        <a class="button-link secondary" href="/assignments">Ко всем заданиям</a>
        <a class="button-link secondary" href="/students">Ко всем обучающимся</a>
      </div>
    </div>`;
}

async function openWorkFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const studentId = parseInt(params.get("student"), 10);
  const assignmentId = parseInt(params.get("assignment"), 10);

  if (Number.isNaN(studentId) || Number.isNaN(assignmentId)) {
    return notFound("Не указано, чью работу и по какому заданию открыть.");
  }

  setBackLink(
    params.get("from") === "student"
      ? `/students?id=${studentId}`
      : `/assignments?id=${assignmentId}`,
    params.get("from") === "student" ? "← К ученику" : "← К заданию"
  );

  await loadAssignments();
  const assignment = assignments.find((a) => a.id === assignmentId);
  if (!assignment) return notFound("Задание не найдено — возможно, оно удалено.");
  activeAssignment = assignment;

  // The roster carries the two things this page needs beyond the assignment
  // itself: the student's name, and the top mark their study group gets.
  let row = null;
  try {
    const { students } = await api(`/api/assignments/${assignmentId}/overview`);
    row = students.find((s) => s.studentId === studentId) || null;
  } catch (err) {
    return notFound("Не удалось получить список учеников: " + err.message);
  }
  if (!row) return notFound("Этот ученик не числится в задании — возможно, он удалён.");

  await selectStudent(studentId, studentName(row), row.maxScore);
}

(async function initStudentWorkTeacher() {
  await initTeacherPage({ withEditor: true });
  await openWorkFromUrl();
})();
