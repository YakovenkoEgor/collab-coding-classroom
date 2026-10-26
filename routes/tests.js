// Sitting a test, and reading the result.
//
// The student side is three steps: look at the test (which says whether it is
// open), start it (that is when the clock starts and the questions appear),
// then answer. Answers are saved as they go, so the attempt can be closed at
// any moment - by the student, or by the clock - with whatever is recorded.
//
// The teacher side is one call: the attempt with every question, the answer
// given, and the verdict, plus the tally shown above it.

const express = require("express");
const db = require("../db/database");
const { requireLogin, requireRole } = require("../middleware/auth");
const testing = require("../testing");
const progsnap = require("../progsnap");
const rules = require("../assignmentRules");

const router = express.Router();

// The assignment, with the deadline that applies to one student - a study
// group may have its own, and for a test that date is the end of the window.
function testAssignment(assignmentId, studentId) {
  const row = db
    .prepare(
      `SELECT a.id, a.title, a.type, a.archived,
              a.test_kind AS testKind,
              a.available_from AS availableFrom,
              a.time_limit_minutes AS timeLimitMinutes,
              COALESCE(r.deadline, a.deadline) AS deadline,
              COALESCE(r.max_score, a.max_score) AS maxScore
       FROM assignments a ${rules.RULE_JOIN_FOR_STUDENT}
       WHERE a.id = ?`
    )
    .get(studentId, assignmentId);
  return row && row.type === "test" ? row : null;
}

function resolveStudentId(req) {
  if (req.session.user.role === "student") return req.session.user.id;
  const studentId = parseInt(req.query.studentId, 10);
  return Number.isNaN(studentId) ? null : studentId;
}

// What the student's screen needs: the window, the state of their attempt,
// and - only once they have started inside an open window - the questions.
router.get("/assignment/:assignmentId", requireLogin, (req, res) => {
  const studentId = resolveStudentId(req);
  if (!studentId) return res.status(400).json({ error: "Не указан ученик" });

  const assignment = testAssignment(req.params.assignmentId, studentId);
  if (!assignment) return res.status(404).json({ error: "Это задание не является тестом" });

  const availability = testing.availabilityOf(assignment);
  let attempt = testing.attemptFor(assignment.id, studentId);
  if (attempt) {
    attempt = testing.closeIfExpired(attempt, assignment.timeLimitMinutes);
  }

  const state = !attempt
    ? "not-started"
    : attempt.submittedAt
      ? "submitted"
      : "in-progress";

  // The questions are not sent while the test is closed or unopened: a
  // student should not be able to read them ahead of time from the network
  // tab.
  const showQuestions = state !== "not-started";
  res.json({
    assignment: {
      id: assignment.id,
      title: assignment.title,
      testKind: assignment.testKind,
      timeLimitMinutes: assignment.timeLimitMinutes,
      maxScore: assignment.maxScore,
    },
    availability,
    state,
    startedAt: attempt ? attempt.startedAt : null,
    submittedAt: attempt ? attempt.submittedAt : null,
    secondsLeft:
      state === "in-progress"
        ? testing.secondsLeft(attempt, assignment.timeLimitMinutes)
        : 0,
    questionCount: testing.questionCount(assignment.id),
    questions: showQuestions ? testing.questionsFor(assignment.id) : [],
    answers: attempt ? testing.answersFor(attempt.id) : [],
  });
});

// Starting the attempt. This is the point of no return: the clock starts now
// and there is one attempt per student, so it is also where the questions
// first become visible.
router.post(
  "/assignment/:assignmentId/start",
  requireLogin,
  requireRole("student"),
  (req, res) => {
    const studentId = req.session.user.id;
    const assignment = testAssignment(req.params.assignmentId, studentId);
    if (!assignment) return res.status(404).json({ error: "Это задание не является тестом" });

    const availability = testing.availabilityOf(assignment);
    if (!availability.open) {
      return res.status(409).json({
        error:
          availability.reason === "early"
            ? "Тест ещё не доступен для решения"
            : "Дедлайн для решения уже истёк",
        availability,
      });
    }
    if (testing.questionCount(assignment.id) === 0) {
      return res.status(409).json({ error: "В тесте пока нет вопросов" });
    }

    const existing = testing.attemptFor(assignment.id, studentId);
    if (existing) {
      // Already sat, or already running: never a second attempt.
      return res.status(409).json({
        error: existing.submittedAt
          ? "Вы уже прошли этот тест"
          : "Попытка уже начата",
      });
    }

    db.prepare(
      "INSERT INTO test_attempts (assignment_id, student_id) VALUES (?, ?)"
    ).run(assignment.id, studentId);

    // Process data: sitting a test is not a programming event, so it carries
    // dataset-specific types. No answers are logged - only that it started.
    progsnap.logEvent({
      eventType: progsnap.EventType.X_TEST_START,
      subjectId: studentId,
      sessionId: req.sessionID,
      assignmentId: assignment.id,
      extra: { "X-TestKind": assignment.test_kind || "graded" },
    });

    const attempt = testing.attemptFor(assignment.id, studentId);
    res.json({
      state: "in-progress",
      startedAt: attempt.startedAt,
      secondsLeft: testing.secondsLeft(attempt, assignment.timeLimitMinutes),
      questions: testing.questionsFor(assignment.id),
      answers: [],
    });
  }
);

// One answer, saved the moment it changes. Returns the time left so the
// client's countdown stays honest even if the tab slept.
router.put(
  "/assignment/:assignmentId/answer",
  requireLogin,
  requireRole("student"),
  (req, res) => {
    const studentId = req.session.user.id;
    const assignment = testAssignment(req.params.assignmentId, studentId);
    if (!assignment) return res.status(404).json({ error: "Это задание не является тестом" });

    let attempt = testing.attemptFor(assignment.id, studentId);
    if (!attempt) return res.status(409).json({ error: "Тест не начат" });
    attempt = testing.closeIfExpired(attempt, assignment.timeLimitMinutes);
    if (attempt.submittedAt) {
      return res.status(409).json({
        error: "Время вышло, тест уже отправлен",
        state: "submitted",
      });
    }

    const questionId = parseInt(req.body.questionId, 10);
    const question = db
      .prepare(
        "SELECT id, kind FROM test_questions WHERE id = ? AND assignment_id = ?"
      )
      .get(questionId, assignment.id);
    if (!question) return res.status(400).json({ error: "Неизвестный вопрос" });

    let optionIds = "";
    let textAnswer = "";
    if (question.kind === "open") {
      textAnswer = String(req.body.textAnswer || "").slice(0, 4000);
    } else {
      // Only options that belong to this question, de-duplicated, and a
      // single-choice question keeps just one of them.
      const allowed = new Set(
        db
          .prepare("SELECT id FROM test_options WHERE question_id = ?")
          .all(question.id)
          .map((o) => o.id)
      );
      const chosen = (Array.isArray(req.body.optionIds) ? req.body.optionIds : [])
        .map((id) => parseInt(id, 10))
        .filter((id) => allowed.has(id));
      const unique = [...new Set(chosen)];
      optionIds = (question.kind === "single" ? unique.slice(0, 1) : unique).join(",");
    }

    db.prepare(
      `INSERT INTO test_answers (attempt_id, question_id, option_ids, text_answer, answered_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(attempt_id, question_id)
       DO UPDATE SET option_ids = excluded.option_ids,
                     text_answer = excluded.text_answer,
                     answered_at = excluded.answered_at`
    ).run(attempt.id, question.id, optionIds, textAnswer);

    res.json({
      ok: true,
      secondsLeft: testing.secondsLeft(attempt, assignment.timeLimitMinutes),
    });
  }
);

// Handing in - by the student, or by the client when the clock hits zero.
// Either way it only closes the attempt: the answers are already saved.
router.post(
  "/assignment/:assignmentId/submit",
  requireLogin,
  requireRole("student"),
  (req, res) => {
    const studentId = req.session.user.id;
    const assignment = testAssignment(req.params.assignmentId, studentId);
    if (!assignment) return res.status(404).json({ error: "Это задание не является тестом" });

    const attempt = testing.attemptFor(assignment.id, studentId);
    if (!attempt) return res.status(409).json({ error: "Тест не начат" });
    if (!attempt.submittedAt) {
      db.prepare(
        "UPDATE test_attempts SET submitted_at = datetime('now') WHERE id = ?"
      ).run(attempt.id);
    }
    const closed = testing.attemptFor(assignment.id, studentId);

    progsnap.logEvent({
      eventType: progsnap.EventType.X_TEST_SUBMIT,
      subjectId: studentId,
      sessionId: req.sessionID,
      assignmentId: assignment.id,
      extra: { "X-TestKind": assignment.test_kind || "graded" },
    });

    res.json({ state: "submitted", submittedAt: closed.submittedAt });
  }
);

// Teacher-only: one student's attempt, checked.
router.get(
  "/assignment/:assignmentId/attempt",
  requireLogin,
  requireRole("teacher"),
  (req, res) => {
    const studentId = parseInt(req.query.studentId, 10);
    if (Number.isNaN(studentId)) {
      return res.status(400).json({ error: "Не указан ученик" });
    }

    const assignment = testAssignment(req.params.assignmentId, studentId);
    if (!assignment) return res.status(404).json({ error: "Это задание не является тестом" });

    let attempt = testing.attemptFor(assignment.id, studentId);
    if (attempt) {
      attempt = testing.closeIfExpired(attempt, assignment.timeLimitMinutes);
    }

    const questions = testing.questionsFor(assignment.id, { withAnswers: true });
    const checked = testing.checkAttempt(
      questions,
      attempt ? testing.answersFor(attempt.id) : [],
      assignment.testKind
    );

    res.json({
      testKind: assignment.testKind,
      timeLimitMinutes: assignment.timeLimitMinutes,
      state: !attempt
        ? "not-started"
        : attempt.submittedAt
          ? "submitted"
          : "in-progress",
      startedAt: attempt ? attempt.startedAt : null,
      submittedAt: attempt ? attempt.submittedAt : null,
      // Only meaningful once there is an attempt; the client hides it
      // otherwise.
      summary: checked.summary,
      questions: checked.questions,
    });
  }
);

module.exports = router;
