// Автоматическая проверка работ: реестр проверяльщиков и запуск.
//
// Платформа не знает, как устроена конкретная проверка. Она знает, что у
// задания может быть включён проверяльщик с какой-то конфигурацией, что у
// задания могут лежать эталоны (учительские файлы, студенту не видимые), и
// что прогон проверки даёт вердикт, счёт и три представления отчёта. Всё
// остальное - дело модуля из этого каталога.
//
// Отсюда же растёт проверка кодовых заданий: новый модуль объявляет свой id,
// к каким типам заданий он применим, как проверить конфигурацию и как
// выполнить прогон - и попадает в CHECKERS. Ни таблицы, ни маршруты, ни
// интерфейс при этом не меняются.

const db = require("../db/database");
const progsnap = require("../progsnap");
const plantuml = require("../plantuml");
const { Limiter, QueueFullError } = require("../queue");
const umlClass = require("./umlClass");

const CHECKERS = [umlClass];

// Вердикты, одинаковые для всех проверок. "error" - не вердикт работы, а
// сообщение о том, что проверку выполнить не удалось.
const VERDICTS = ["accepted", "rejected", "needs_review", "error"];

const VERDICT_LABELS = {
  accepted: "принято",
  rejected: "не принято",
  needs_review: "на проверке у преподавателя",
  error: "проверка не выполнена",
};

// Проверка стоит дешевле запуска кода, но это всё равно внешний процесс:
// пусть их будет ограниченное число одновременно, остальные подождут.
const limiter = new Limiter(
  parseInt(process.env.CHECK_CONCURRENCY || "2", 10),
  parseInt(process.env.CHECK_QUEUE_LIMIT || "40", 10)
);

class CheckError extends Error {}

// --- реестр ----------------------------------------------------------------

function checkerById(id) {
  return CHECKERS.find((checker) => checker.ID === id) || null;
}

function checkersForType(assignmentType) {
  return CHECKERS.filter((checker) => checker.APPLIES_TO.includes(assignmentType));
}

function catalogFor(assignmentType) {
  return checkersForType(assignmentType).map((checker) => ({
    id: checker.ID,
    label: checker.LABEL,
    maxReferences: checker.MAX_REFERENCES,
  }));
}

// --- настройка на задании --------------------------------------------------

function settingsFor(assignmentId) {
  const row = db
    .prepare(
      `SELECT assignment_id AS assignmentId, checker, enabled, config,
              updated_at AS updatedAt
       FROM assignment_checks WHERE assignment_id = ?`
    )
    .get(assignmentId);
  if (!row) return null;
  let config = {};
  try {
    config = JSON.parse(row.config || "{}");
  } catch {
    config = {};
  }
  return { ...row, enabled: !!row.enabled, config };
}

function saveSettings(assignmentId, { checker, enabled, config }) {
  db.prepare(
    `INSERT INTO assignment_checks (assignment_id, checker, enabled, config, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(assignment_id) DO UPDATE SET
       checker = excluded.checker,
       enabled = excluded.enabled,
       config = excluded.config,
       updated_at = excluded.updated_at`
  ).run(assignmentId, checker, enabled ? 1 : 0, JSON.stringify(config || {}));
}

function clearSettings(assignmentId) {
  db.prepare("DELETE FROM assignment_checks WHERE assignment_id = ?").run(assignmentId);
}

// --- эталоны ---------------------------------------------------------------

function referencesFor(assignmentId) {
  return db
    .prepare(
      `SELECT id, slot, filename, content, encoding, svg,
              render_error AS renderError
       FROM assignment_reference_files
       WHERE assignment_id = ? ORDER BY slot`
    )
    .all(assignmentId);
}

function hasReferences(assignmentId) {
  return (
    db
      .prepare(
        "SELECT COUNT(*) c FROM assignment_reference_files WHERE assignment_id = ?"
      )
      .get(assignmentId).c > 0
  );
}

// Эталоны задаются целиком: пришедший список заменяет прежний. Отрисовки при
// этом сбрасываются - картинка должна соответствовать тексту.
function replaceReferences(assignmentId, references) {
  const insert = db.prepare(
    `INSERT INTO assignment_reference_files
       (assignment_id, slot, filename, content, encoding)
     VALUES (?, ?, ?, ?, 'text')`
  );
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM assignment_reference_files WHERE assignment_id = ?").run(
      assignmentId
    );
    for (const reference of references || []) {
      insert.run(assignmentId, reference.slot, reference.filename, reference.content);
    }
  });
  replace();
}

// Отрисовка эталонов - для экрана проверки: преподаватель видит работу и
// эталон рядом. Делается по запросу и переживает отсутствие Docker: если
// рендерить нечем, в строке остаётся причина, а проверка от этого не зависит.
async function renderReferences(assignmentId) {
  const pending = referencesFor(assignmentId).filter(
    (reference) => !reference.svg && !reference.renderError
  );
  if (pending.length === 0) return referencesFor(assignmentId);

  const update = db.prepare(
    "UPDATE assignment_reference_files SET svg = ?, render_error = ? WHERE id = ?"
  );
  for (const reference of pending) {
    try {
      const result = await plantuml.render(reference.content);
      update.run(result.svg || null, result.error || null, reference.id);
    } catch (err) {
      update.run(null, err.message, reference.id);
    }
  }
  return referencesFor(assignmentId);
}

// --- прогоны ---------------------------------------------------------------

const RUN_COLUMNS = `
  id, assignment_id AS assignmentId, student_id AS studentId,
  submission_id AS submissionId, checker, verdict, score,
  report, teacher_report AS teacherReport, student_report AS studentReport,
  config_hash AS configHash, tool_version AS toolVersion,
  initiated_by AS initiatedBy, error, duration_ms AS durationMs,
  created_at AS createdAt`;

function parseRun(row) {
  if (!row) return null;
  let report = null;
  try {
    report = row.report ? JSON.parse(row.report) : null;
  } catch {
    report = null;
  }
  return { ...row, report };
}

function latestRunFor(assignmentId, studentId) {
  return parseRun(
    db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM check_runs
         WHERE assignment_id = ? AND student_id = ?
         ORDER BY id DESC LIMIT 1`
      )
      .get(assignmentId, studentId)
  );
}

function runForSubmission(submissionId) {
  return parseRun(
    db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM check_runs
         WHERE submission_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(submissionId)
  );
}

// История без отчётов: для списка прогонов хватает вердикта и счёта, а
// отчёты - это килобайты на строку.
function historyFor(assignmentId, studentId, limit = 20) {
  return db
    .prepare(
      `SELECT id, submission_id AS submissionId, verdict, score,
              initiated_by AS initiatedBy, error,
              created_at AS createdAt
       FROM check_runs
       WHERE assignment_id = ? AND student_id = ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(assignmentId, studentId, limit);
}

function recordRun(row) {
  const info = db
    .prepare(
      `INSERT INTO check_runs
         (assignment_id, student_id, submission_id, checker, verdict, score,
          report, teacher_report, student_report, config_hash, tool_version,
          code_state_id, initiated_by, error, duration_ms)
       VALUES
         (@assignmentId, @studentId, @submissionId, @checker, @verdict, @score,
          @report, @teacherReport, @studentReport, @configHash, @toolVersion,
          @codeStateId, @initiatedBy, @error, @durationMs)`
    )
    .run({
      assignmentId: row.assignmentId,
      studentId: row.studentId ?? null,
      submissionId: row.submissionId ?? null,
      checker: row.checker,
      verdict: row.verdict ?? null,
      score: row.score ?? null,
      report: row.report ? JSON.stringify(row.report) : null,
      teacherReport: row.teacherReport || null,
      studentReport: row.studentReport || null,
      configHash: row.configHash ?? null,
      toolVersion: row.toolVersion ?? null,
      codeStateId: row.codeStateId ?? null,
      initiatedBy: row.initiatedBy || "student",
      error: row.error ?? null,
      durationMs: row.durationMs ?? null,
    });
  return parseRun(
    db.prepare(`SELECT ${RUN_COLUMNS} FROM check_runs WHERE id = ?`).get(
      info.lastInsertRowid
    )
  );
}

// Включена ли проверка на задании и есть ли чем проверять.
function readyFor(assignment) {
  const settings = settingsFor(assignment.id);
  if (!settings || !settings.enabled) return null;
  const checker = checkerById(settings.checker);
  if (!checker || !checker.APPLIES_TO.includes(assignment.type)) return null;
  const references = referencesFor(assignment.id);
  if (references.length === 0) return null;
  return { settings, checker, references };
}

// Один прогон: выполнить и записать. Ошибка проверки - это тоже строка в
// журнале (вердикт "error"), а не потерянный результат: иначе было бы не
// видно, что проверка вообще пыталась отработать.
async function runCheck({
  assignment,
  studentId,
  submissionId = null,
  source,
  filename = null,
  files = null,
  initiatedBy = "student",
  sessionId = null,
}) {
  const ready = readyFor(assignment);
  if (!ready) {
    throw new CheckError("Автоматическая проверка для этого задания не настроена");
  }
  const { settings, checker, references } = ready;

  // Снимок того, что проверялось: по нему потом видно, какой именно текст
  // получил этот вердикт, даже если версию не сохраняли.
  let codeStateId = null;
  try {
    const snapshot =
      files && files.length > 0
        ? files
        : [{ filename: filename || "diagram.puml", content: source, isEntry: 1 }];
    codeStateId = progsnap.recordCodeState(snapshot, filename || undefined);
  } catch (err) {
    console.error("[checks] не удалось записать снимок:", err.message);
  }

  let release;
  try {
    release = await limiter.acquire();
  } catch (err) {
    if (err instanceof QueueFullError) {
      throw new CheckError("Проверок в очереди слишком много — попробуйте позже");
    }
    throw err;
  }

  // task_id нигде не вводится руками: он нужен только в отчёте, чтобы было
  // видно, к какому заданию относится прогон, и однозначно берётся из задания.
  const config = { ...settings.config, task_id: `assignment-${assignment.id}` };

  let result = null;
  let failure = null;
  try {
    result = await checker.run({
      config,
      references,
      source,
      filename,
      assignment,
    });
  } catch (err) {
    failure = err;
  } finally {
    release();
  }

  const run = recordRun({
    assignmentId: assignment.id,
    studentId,
    submissionId,
    checker: checker.ID,
    verdict: failure ? "error" : result.verdict,
    score: failure ? null : result.score,
    report: failure ? null : result.report,
    teacherReport: failure ? null : result.teacherReport,
    studentReport: failure ? null : result.studentReport,
    configHash: failure ? null : result.configHash,
    toolVersion: failure ? null : result.toolVersion,
    codeStateId,
    initiatedBy,
    error: failure ? failure.message : null,
    durationMs: failure ? null : result.durationMs,
  });

  progsnap.logCheck({
    subjectId: studentId,
    sessionId,
    assignmentId: assignment.id,
    submissionId,
    codeStateId,
    codeStateSection: filename,
    checker: checker.ID,
    verdict: run.verdict,
    score: run.score,
    configHash: run.configHash,
    toolVersion: run.toolVersion,
    initiatedBy,
    error: run.error,
  });

  if (failure) {
    // Строка записана, а вызывающей стороне всё равно нужно знать, что
    // проверка не состоялась.
    const error = new CheckError(failure.message);
    error.run = run;
    throw error;
  }
  return run;
}

module.exports = {
  CHECKERS,
  VERDICTS,
  VERDICT_LABELS,
  CheckError,
  checkerById,
  checkersForType,
  catalogFor,
  settingsFor,
  saveSettings,
  clearSettings,
  referencesFor,
  hasReferences,
  replaceReferences,
  renderReferences,
  readyFor,
  runCheck,
  latestRunFor,
  runForSubmission,
  historyFor,
};
