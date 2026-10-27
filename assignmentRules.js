// Per-group deadlines and top marks.
//
// An assignment carries nothing of its own here: a deadline and a maximum
// score exist only per study group, in assignment_group_rules - one row per
// (assignment, group), each field optional.
//
// No row, or a row with both fields empty, means the assignment is simply not
// given to that group: its students see it in their list, greyed out and not
// clickable, with "не требует выполнения" where the deadline would be. The
// same follows for a student who belongs to no group at all - there is no rule
// that could apply to them.
//
// Everything that shows or checks a deadline or a top mark resolves it through
// this module, so the two roles never disagree about which number applies.

const db = require("./db/database");

// A guard rail, not a real limit: a class has a handful of groups, and a
// runaway payload should not turn into thousands of rows.
const MAX_GROUP_RULES = 50;
const MAX_GROUP_NAME = 100;

// SQL: join the rule that applies to one student. Both fragments expect the
// student id as their single placeholder, and an `a` alias for assignments.
const RULE_JOIN_FOR_STUDENT = `
  LEFT JOIN assignment_group_rules r
    ON r.assignment_id = a.id
   AND r.group_name = (SELECT group_name FROM users WHERE id = ?)`;

// SQL: join the rule that applies to each row of a `users u` listing.
const RULE_JOIN_FOR_USERS = `
  LEFT JOIN assignment_group_rules r
    ON r.assignment_id = a.id AND r.group_name = u.group_name`;

// SQL: the resolved values, for use in a SELECT alongside either join above.
// `isActive` is the one thing every screen needs: whether this assignment has
// been given to this student's group at all.
const RESOLVED_COLUMNS = `
  r.deadline AS deadline,
  r.max_score AS maxScore,
  CASE WHEN r.deadline IS NOT NULL OR r.max_score IS NOT NULL
       THEN 1 ELSE 0 END AS isActive`;

function rulesForAssignment(assignmentId) {
  return db
    .prepare(
      `SELECT group_name AS groupName, deadline, max_score AS maxScore
       FROM assignment_group_rules WHERE assignment_id = ?
       ORDER BY group_name`
    )
    .all(assignmentId);
}

// The top mark that applies to one student on one assignment, or null when
// their group has none - which means the work cannot be marked.
function maxScoreFor(assignmentId, studentId) {
  const row = db
    .prepare(
      `SELECT r.max_score AS maxScore
       FROM assignments a ${RULE_JOIN_FOR_STUDENT}
       WHERE a.id = ?`
    )
    .get(studentId, assignmentId);
  return row ? row.maxScore : null;
}

// Whether one student has been given one assignment at all. Everything a
// student can do to an assignment - open it, run it, hand it in, sit the test -
// goes through this, so a direct request cannot get round the list.
function isActiveFor(assignmentId, studentId) {
  const row = db
    .prepare(
      `SELECT r.deadline AS deadline, r.max_score AS maxScore
       FROM assignments a ${RULE_JOIN_FOR_STUDENT}
       WHERE a.id = ?`
    )
    .get(studentId, assignmentId);
  if (!row) return false;
  return row.deadline !== null || row.maxScore !== null;
}

// The deadline that applies to one student, or null when they have none.
function deadlineFor(assignmentId, studentId) {
  const row = db
    .prepare(
      `SELECT r.deadline AS deadline
       FROM assignments a ${RULE_JOIN_FOR_STUDENT}
       WHERE a.id = ?`
    )
    .get(studentId, assignmentId);
  return row ? row.deadline : null;
}

// Every study group the class actually has, plus any group that already has a
// rule on this assignment (a group can be emptied out while its rule stands).
function knownGroups(assignmentId) {
  const rows = db
    .prepare(
      `SELECT DISTINCT group_name AS groupName FROM users
       WHERE role = 'student' AND group_name IS NOT NULL AND TRIM(group_name) <> ''
       UNION
       SELECT DISTINCT group_name FROM assignment_group_rules
       WHERE assignment_id = ?
       ORDER BY groupName`
    )
    .all(assignmentId === undefined || assignmentId === null ? -1 : assignmentId);
  return rows.map((r) => r.groupName);
}

// Replaces an assignment's rules with the given list. Call inside a
// transaction together with the rest of the save.
function replaceRules(assignmentId, rules) {
  db.prepare("DELETE FROM assignment_group_rules WHERE assignment_id = ?").run(
    assignmentId
  );
  const insert = db.prepare(
    `INSERT INTO assignment_group_rules (assignment_id, group_name, deadline, max_score)
     VALUES (?, ?, ?, ?)`
  );
  for (const rule of rules) {
    insert.run(assignmentId, rule.groupName, rule.deadline, rule.maxScore);
  }
}

module.exports = {
  MAX_GROUP_RULES,
  MAX_GROUP_NAME,
  RULE_JOIN_FOR_STUDENT,
  RULE_JOIN_FOR_USERS,
  RESOLVED_COLUMNS,
  rulesForAssignment,
  maxScoreFor,
  isActiveFor,
  deadlineFor,
  knownGroups,
  replaceRules,
};
