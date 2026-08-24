// Shared deadline logic, used by both the teacher's view of a student and the
// student's own assignment list, so the two can't drift apart.

// Work is "at risk" when nothing has been handed in and the deadline is less
// than this many days away; once the deadline has passed it becomes "overdue".
const DEADLINE_WARNING_DAYS = 2;

// Takes a row carrying `deadline`, `archived` and `hasSubmitted`, and adds
// `deadlineState` ("due-soon" | "overdue" | null) plus `hoursLeft`.
function withDeadlineState(row) {
  const result = {
    ...row,
    hasSubmitted: !!row.hasSubmitted,
    deadlineState: null,
    hoursLeft: null,
  };
  if (!row.deadline || result.hasSubmitted || row.archived) return result;

  // Stored as "YYYY-MM-DD HH:MM" in local time; make that explicit for Date.
  const due = new Date(String(row.deadline).replace(" ", "T"));
  if (Number.isNaN(due.getTime())) return result;

  const hoursLeft = (due.getTime() - Date.now()) / 36e5;
  result.hoursLeft = Math.round(hoursLeft);
  if (hoursLeft < 0) result.deadlineState = "overdue";
  else if (hoursLeft <= DEADLINE_WARNING_DAYS * 24) result.deadlineState = "due-soon";
  return result;
}

module.exports = { DEADLINE_WARNING_DAYS, withDeadlineState };
