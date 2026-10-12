// Test assignments: questions, attempts, and the checking of answers.
//
// Two kinds of test, chosen when the assignment is created:
//   graded  - choice questions carry correct answers, open ones may; the
//             teacher sees how many came out right and marks the work
//   survey  - no correct answers anywhere, nothing is checked or scored
//
// A test is open for solving inside a window: available_from (defaults to
// "right away") .. deadline. A student always sees that the test exists; the
// questions themselves only appear once the window is open and they have
// started their attempt. From that moment the clock runs: time_limit_minutes
// after started_at the attempt closes, with whatever answers were recorded -
// answers are saved as the student works, not at the end.

const db = require("./db/database");

const TEST_KINDS = ["graded", "survey"];
const QUESTION_KINDS = ["single", "multiple", "open"];

const MAX_QUESTIONS = 100;
const MAX_OPTIONS = 20;
const MAX_BODY = 2000;
const MIN_TIME_LIMIT = 1;
const MAX_TIME_LIMIT = 600;
const DEFAULT_TIME_LIMIT = 15;

class TestError extends Error {}

function normalizeKind(raw) {
  const kind = String(raw || "graded").trim();
  if (!TEST_KINDS.includes(kind)) {
    throw new TestError(`Неизвестный вид теста «${kind}»`);
  }
  return kind;
}

function normalizeTimeLimit(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_TIME_LIMIT;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value) || value < MIN_TIME_LIMIT || value > MAX_TIME_LIMIT) {
    throw new TestError(
      `Время на решение — целое число минут от ${MIN_TIME_LIMIT} до ${MAX_TIME_LIMIT}`
    );
  }
  return value;
}

function text(raw, what) {
  const value = String(raw === undefined || raw === null ? "" : raw).trim();
  if (value.length > MAX_BODY) {
    throw new TestError(`${what}: текст длиннее ${MAX_BODY} символов`);
  }
  return value;
}

// The questions as they come from the teacher's form. A survey never keeps
// correct answers, whatever the form happened to send.
function readQuestions(raw, testKind) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new TestError("В тесте должен быть хотя бы один вопрос");
  }
  if (raw.length > MAX_QUESTIONS) {
    throw new TestError(`В тесте не больше ${MAX_QUESTIONS} вопросов`);
  }

  return raw.map((item, index) => {
    const number = index + 1;
    const kind = String((item && item.kind) || "single").trim();
    if (!QUESTION_KINDS.includes(kind)) {
      throw new TestError(`Вопрос ${number}: неизвестный тип «${kind}»`);
    }
    const body = text(item && item.body, `Вопрос ${number}`);
    if (!body) throw new TestError(`Вопрос ${number}: не заполнен текст`);

    if (kind === "open") {
      return {
        kind,
        body,
        // Optional, and only on a graded test: with an expected answer the
        // question is checked automatically, without one the teacher reads it.
        expectedAnswer: testKind === "survey" ? "" : text(item.expectedAnswer, "Ответ"),
        options: [],
      };
    }

    const options = (Array.isArray(item.options) ? item.options : []).map((opt, i) => ({
      body: text(opt && opt.body, `Вопрос ${number}, вариант ${i + 1}`),
      isCorrect: testKind === "survey" ? false : !!(opt && opt.isCorrect),
    }));
    if (options.length < 2) {
      throw new TestError(`Вопрос ${number}: нужно хотя бы два варианта ответа`);
    }
    if (options.length > MAX_OPTIONS) {
      throw new TestError(`Вопрос ${number}: больше ${MAX_OPTIONS} вариантов ответа`);
    }
    if (options.some((o) => !o.body)) {
      throw new TestError(`Вопрос ${number}: пустой вариант ответа`);
    }

    if (testKind === "graded") {
      const correct = options.filter((o) => o.isCorrect).length;
      if (correct === 0) {
        throw new TestError(`Вопрос ${number}: отметьте правильный вариант`);
      }
      if (kind === "single" && correct > 1) {
        throw new TestError(
          `Вопрос ${number}: должен быть один правильный вариант, а отмечено ${correct}`
        );
      }
    }
    return { kind, body, expectedAnswer: "", options };
  });
}

// Replaces a test's questions wholesale. Call inside a transaction with the
// rest of the save.
function replaceQuestions(assignmentId, questions) {
  db.prepare(
    `DELETE FROM test_options WHERE question_id IN
       (SELECT id FROM test_questions WHERE assignment_id = ?)`
  ).run(assignmentId);
  db.prepare("DELETE FROM test_questions WHERE assignment_id = ?").run(assignmentId);

  const insertQuestion = db.prepare(
    `INSERT INTO test_questions (assignment_id, position, kind, body, expected_answer)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insertOption = db.prepare(
    `INSERT INTO test_options (question_id, position, body, is_correct)
     VALUES (?, ?, ?, ?)`
  );

  questions.forEach((question, index) => {
    const info = insertQuestion.run(
      assignmentId,
      index,
      question.kind,
      question.body,
      question.expectedAnswer || ""
    );
    question.options.forEach((option, optionIndex) => {
      insertOption.run(
        info.lastInsertRowid,
        optionIndex,
        option.body,
        option.isCorrect ? 1 : 0
      );
    });
  });
}

// withAnswers=false is what a student is allowed to see: the same questions
// with the correct-answer markings stripped out.
function questionsFor(assignmentId, { withAnswers = false } = {}) {
  const questions = db
    .prepare(
      `SELECT id, kind, body, expected_answer AS expectedAnswer
       FROM test_questions WHERE assignment_id = ? ORDER BY position, id`
    )
    .all(assignmentId);

  const options = db
    .prepare(
      `SELECT o.id, o.question_id AS questionId, o.body, o.is_correct AS isCorrect
       FROM test_options o
       JOIN test_questions q ON q.id = o.question_id
       WHERE q.assignment_id = ? ORDER BY o.position, o.id`
    )
    .all(assignmentId);

  return questions.map((question) => ({
    id: question.id,
    kind: question.kind,
    body: question.body,
    ...(withAnswers ? { expectedAnswer: question.expectedAnswer } : {}),
    options: options
      .filter((o) => o.questionId === question.id)
      .map((o) => ({
        id: o.id,
        body: o.body,
        ...(withAnswers ? { isCorrect: !!o.isCorrect } : {}),
      })),
  }));
}

function questionCount(assignmentId) {
  return db
    .prepare("SELECT COUNT(*) c FROM test_questions WHERE assignment_id = ?")
    .get(assignmentId).c;
}

// ---------------------------------------------------------------------
// The window a test can be solved in
// ---------------------------------------------------------------------

// The window is made of local-time strings the teacher typed, so they are
// read as local time.
function toDate(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : date;
}

// Timestamps the database wrote are UTC (datetime('now')), so they need the
// Z to be read as such - without it they would be taken for local time and
// the clock would be out by the timezone offset.
function toStoredDate(value) {
  if (!value) return null;
  const date = new Date(`${String(value).replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

// `deadline` is passed in rather than read from the row: a study group may
// have one of its own (see assignmentRules.js).
function availabilityOf({ availableFrom, deadline }, now = new Date()) {
  const from = toDate(availableFrom);
  const to = toDate(deadline);
  const window = { from: availableFrom || null, to: deadline || null };
  if (from && now < from) return { ...window, open: false, reason: "early" };
  if (to && now > to) return { ...window, open: false, reason: "late" };
  return { ...window, open: true, reason: null };
}

function attemptFor(assignmentId, studentId) {
  return db
    .prepare(
      `SELECT id, assignment_id AS assignmentId, student_id AS studentId,
              started_at AS startedAt, submitted_at AS submittedAt
       FROM test_attempts WHERE assignment_id = ? AND student_id = ?`
    )
    .get(assignmentId, studentId);
}

// Seconds left on the clock, or 0 once it has run out.
function secondsLeft(attempt, timeLimitMinutes, now = new Date()) {
  const started = toStoredDate(attempt.startedAt);
  if (!started) return 0;
  const ends = started.getTime() + (timeLimitMinutes || DEFAULT_TIME_LIMIT) * 60_000;
  return Math.max(0, Math.round((ends - now.getTime()) / 1000));
}

// Closes an attempt whose time is up, keeping whatever was answered. The
// server does this on its own so a student who closed the browser still has
// their work handed in.
function closeIfExpired(attempt, timeLimitMinutes, now = new Date()) {
  if (!attempt || attempt.submittedAt) return attempt;
  if (secondsLeft(attempt, timeLimitMinutes, now) > 0) return attempt;
  db.prepare(
    "UPDATE test_attempts SET submitted_at = datetime('now') WHERE id = ?"
  ).run(attempt.id);
  return attemptFor(attempt.assignmentId, attempt.studentId);
}

function answersFor(attemptId) {
  return db
    .prepare(
      `SELECT question_id AS questionId, option_ids AS optionIds, text_answer AS textAnswer
       FROM test_answers WHERE attempt_id = ?`
    )
    .all(attemptId)
    .map((row) => ({
      questionId: row.questionId,
      optionIds: row.optionIds
        ? row.optionIds.split(",").map((n) => parseInt(n, 10))
        : [],
      textAnswer: row.textAnswer || "",
    }));
}

// ---------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------

// Open answers are compared leniently: case and spacing are not what the
// question is about. Anything subtler is a judgement call, which is why a
// question without an expected answer goes to the teacher instead.
function sameText(a, b) {
  const tidy = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return tidy(a) === tidy(b);
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const left = [...a].sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  return left.every((value, i) => value === right[i]);
}

// Per-question verdicts plus the tally the teacher sees first.
// verdict: 'correct' | 'incorrect' | 'manual' (needs a human) | 'none' (a
// survey question - there is nothing to be right about).
function checkAttempt(questions, answers, testKind) {
  const byQuestion = new Map(answers.map((a) => [a.questionId, a]));

  const checked = questions.map((question) => {
    const answer = byQuestion.get(question.id) || { optionIds: [], textAnswer: "" };
    const given = {
      optionIds: answer.optionIds,
      textAnswer: answer.textAnswer,
      answered:
        question.kind === "open"
          ? answer.textAnswer.trim() !== ""
          : answer.optionIds.length > 0,
    };

    if (testKind === "survey") return { ...question, given, verdict: "none" };

    if (question.kind === "open") {
      const expected = (question.expectedAnswer || "").trim();
      if (expected === "") return { ...question, given, verdict: "manual" };
      return {
        ...question,
        given,
        verdict: sameText(given.textAnswer, expected) ? "correct" : "incorrect",
      };
    }

    const correctIds = question.options.filter((o) => o.isCorrect).map((o) => o.id);
    return {
      ...question,
      given,
      verdict: sameSet(correctIds, given.optionIds) ? "correct" : "incorrect",
    };
  });

  const total = checked.length;
  const count = (verdict) => checked.filter((q) => q.verdict === verdict).length;
  const percent = (n) => (total === 0 ? 0 : Math.round((n / total) * 100));
  const correct = count("correct");
  const incorrect = count("incorrect");
  const manual = count("manual");

  return {
    questions: checked,
    summary: {
      total,
      correct,
      incorrect,
      manual,
      answered: checked.filter((q) => q.given.answered).length,
      percentCorrect: percent(correct),
      percentIncorrect: percent(incorrect),
      percentManual: percent(manual),
    },
  };
}

// Everything belonging to a test, for when the assignment is deleted.
function deleteTestData(assignmentId) {
  db.prepare(
    `DELETE FROM test_answers WHERE attempt_id IN
       (SELECT id FROM test_attempts WHERE assignment_id = ?)`
  ).run(assignmentId);
  db.prepare("DELETE FROM test_attempts WHERE assignment_id = ?").run(assignmentId);
  db.prepare(
    `DELETE FROM test_options WHERE question_id IN
       (SELECT id FROM test_questions WHERE assignment_id = ?)`
  ).run(assignmentId);
  db.prepare("DELETE FROM test_questions WHERE assignment_id = ?").run(assignmentId);
}

module.exports = {
  TEST_KINDS,
  QUESTION_KINDS,
  MAX_QUESTIONS,
  MAX_OPTIONS,
  MIN_TIME_LIMIT,
  MAX_TIME_LIMIT,
  DEFAULT_TIME_LIMIT,
  TestError,
  normalizeKind,
  normalizeTimeLimit,
  readQuestions,
  replaceQuestions,
  questionsFor,
  questionCount,
  availabilityOf,
  attemptFor,
  secondsLeft,
  closeIfExpired,
  answersFor,
  checkAttempt,
  deleteTestData,
};
