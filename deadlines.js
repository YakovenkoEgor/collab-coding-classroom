// Shared deadline logic, used by both the teacher's view of a student and the
// student's own assignment list, so the two can't drift apart.

// A date and time as the app stores them: "YYYY-MM-DD HH:MM" in local time,
// which compares correctly with datetime('now') and sorts as a string.
// The browser sends datetime-local as "YYYY-MM-DDTHH:MM"; the T becomes a
// space here. Shared by assignment deadlines and notifications.
class DeadlineError extends Error {}

function normalizeDeadline(deadline) {
  if (typeof deadline !== "string" || deadline.trim() === "") return null;
  const normalized = deadline.trim().replace("T", " ").slice(0, 16);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(normalized)) {
    throw new DeadlineError("Deadline must look like 2026-09-01 18:00");
  }
  return normalized;
}

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

module.exports = {
  DEADLINE_WARNING_DAYS,
  withDeadlineState,
  DeadlineError,
  normalizeDeadline,
};
