// Автоматическая проверка работ: настройка, запуск, отчёты.
//
// Маршруты ничего не знают о конкретной проверке - всё идёт через checks/.
// Два правила, которые соблюдаются здесь и дальше нигде не повторяются:
//
//   1. Эталоны и полный отчёт - учительские данные. Студенту уходит только
//      его отчёт: что и где не совпало, без текста эталона и без чисел
//      (ТЗ п. 8).
//   2. Проверка не ставит оценок. Вердикт живёт в check_runs, оценка - в
//      grades, и одно не превращается в другое само.

const express = require("express");
const db = require("../db/database");
const { requireLogin, requireRole } = require("../middleware/auth");
const checks = require("../checks");
const rules = require("../assignmentRules");

const router = express.Router();

function assignmentById(id) {
  return db.prepare("SELECT * FROM assignments WHERE id = ?").get(id);
}

function submissionById(id) {
  return db.prepare("SELECT * FROM submissions WHERE id = ?").get(id);
}

function filesForSubmission(submissionId) {
  return db
    .prepare(
      `SELECT filename, content, encoding, is_entry AS isEntry
       FROM submission_files WHERE submission_id = ?
       ORDER BY is_entry DESC, filename`
    )
    .all(submissionId);
}

// Что из прогона видит студент: вердикт и текстовые замечания. Ни счёта, ни
// критериев, ни эталона.
function studentView(run) {
  if (!run) return null;
  return {
    id: run.id,
    submissionId: run.submissionId,
    verdict: run.verdict,
    report: run.studentReport || "",
    error: run.error || null,
    createdAt: run.createdAt,
  };
}

// Что видит преподаватель: всё, включая разбор по критериям.
function teacherView(run) {
  if (!run) return null;
  return {
    id: run.id,
    submissionId: run.submissionId,
    studentId: run.studentId,
    checker: run.checker,
    verdict: run.verdict,
    score: run.score,
    report: run.report,
    teacherReport: run.teacherReport || "",
    studentReport: run.studentReport || "",
    configHash: run.configHash,
    toolVersion: run.toolVersion,
    initiatedBy: run.initiatedBy,
    error: run.error || null,
    durationMs: run.durationMs,
    createdAt: run.createdAt,
  };
}

// --- настройка (преподаватель) ---------------------------------------------

// Какие проверки вообще применимы к такому типу задания - для формы задания.
router.get("/catalog", requireLogin, requireRole("teacher"), (req, res) => {
  const type = String(req.query.type || "");
  res.json({ checkers: checks.catalogFor(type) });
});

// Настройка проверки на задании: конфигурация, эталоны и то же самое в виде
// YAML - как его увидит инструмент.
router.get(
  "/assignment/:id",
  requireLogin,
  requireRole("teacher"),
  async (req, res, next) => {
    try {
      const assignment = assignmentById(req.params.id);
      if (!assignment) return res.status(404).json({ error: "Задание не найдено" });

      const settings = checks.settingsFor(assignment.id);
      const references =
        req.query.render === "1"
          ? await checks.renderReferences(assignment.id)
          : checks.referencesFor(assignment.id);

      const checker = settings ? checks.checkerById(settings.checker) : null;
      let configYaml = "";
      let problem = null;
      if (checker) {
        try {
          configYaml = checker.configYaml(
            settings.config,
            references.map((reference) => `${reference.slot}.puml`)
          );
        } catch (err) {
          configYaml = "";
        }
        problem = await checker.problem();
      }

      res.json({
        checkers: checks.catalogFor(assignment.type),
        settings: settings
          ? {
              checker: settings.checker,
              enabled: settings.enabled,
              config: settings.config,
              updatedAt: settings.updatedAt,
            }
          : null,
        references: references.map((reference) => ({
          slot: reference.slot,
          filename: reference.filename,
          content: reference.content,
          svg: reference.svg || null,
          renderError: reference.renderError || null,
        })),
        configYaml,
        problem,
      });
    } catch (err) {
      next(err);
    }
  }
);

// Конфигурация, собранная из полей формы, в том виде, в котором её прочтёт
// инструмент. Ничего не сохраняет: это и предпросмотр, и проверка полей до
// сохранения задания.
router.post("/preview", requireLogin, requireRole("teacher"), (req, res) => {
  const type = String(req.body.type || "");
  const given = req.body.check && typeof req.body.check === "object" ? req.body.check : {};
  const available = checks.catalogFor(type);
  if (available.length === 0) {
    return res
      .status(400)
      .json({ error: "Для этого типа задания автоматическая проверка не предусмотрена" });
  }
  const checker = checks.checkerById(String(given.checker || available[0].id));
  if (!checker) return res.status(400).json({ error: "Неизвестная проверка" });

  try {
    const assignmentId = parseInt(req.body.assignmentId, 10);
    const config = checker.validateConfig(given.config, {
      taskId: assignmentId ? `assignment-${assignmentId}` : "новое задание",
    });
    const references = checker.validateReferences(given.references);
    res.json({
      configYaml: checker.configYaml(
        config,
        references.map((reference) => `${reference.slot}.puml`)
      ),
      referenceCount: references.length,
    });
  } catch (err) {
    if (err instanceof checker.CheckConfigError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});

// --- запуск ----------------------------------------------------------------

// Один прогон. Студент проверяет то, что у него сейчас в редакторе (сколько
// раз захочет); преподаватель - сохранённую версию работы.
router.post("/run", requireLogin, async (req, res, next) => {
  try {
    const isTeacher = req.session.user.role === "teacher";
    const submissionId = req.body.submissionId
      ? parseInt(req.body.submissionId, 10)
      : null;

    let assignment;
    let studentId;
    let source = typeof req.body.source === "string" ? req.body.source : null;
    let filename = req.body.filename ? String(req.body.filename) : null;
    let files = null;

    if (submissionId) {
      const submission = submissionById(submissionId);
      if (!submission) return res.status(404).json({ error: "Версия не найдена" });
      if (!isTeacher && submission.student_id !== req.session.user.id) {
        return res.status(403).json({ error: "Это не ваша версия" });
      }
      assignment = assignmentById(submission.assignment_id);
      studentId = submission.student_id;
      files = filesForSubmission(submission.id);
      const checker = checks.checkerById(
        (checks.settingsFor(submission.assignment_id) || {}).checker
      );
      const chosen = checker?.pickFile ? checker.pickFile(files, filename) : null;
      if (!chosen) {
        return res
          .status(400)
          .json({ error: "В этой версии нет файла, который можно проверить" });
      }
      source = chosen.content;
      filename = chosen.filename;
    } else {
      if (isTeacher) {
        return res
          .status(400)
          .json({ error: "Укажите версию работы, которую нужно проверить" });
      }
      assignment = assignmentById(req.body.assignmentId);
      studentId = req.session.user.id;
      if (source === null) {
        return res.status(400).json({ error: "Нечего проверять" });
      }
    }

    if (!assignment) return res.status(404).json({ error: "Задание не найдено" });
    if (!isTeacher && !rules.isActiveFor(assignment.id, studentId)) {
      return res.status(403).json({ error: "Это задание не требует выполнения" });
    }
    if (!checks.readyFor(assignment)) {
      return res
        .status(400)
        .json({ error: "Автоматическая проверка для этого задания не настроена" });
    }

    try {
      const run = await checks.runCheck({
        assignment,
        studentId,
        submissionId,
        source,
        filename,
        files,
        initiatedBy: isTeacher ? "teacher" : "student",
        sessionId: req.sessionID,
      });
      res.json({ run: isTeacher ? teacherView(run) : studentView(run) });
    } catch (err) {
      if (err instanceof checks.CheckError) {
        // Прогон с ошибкой уже записан; наружу уходит причина.
        return res.status(502).json({
          error: err.message,
          run: err.run
            ? isTeacher
              ? teacherView(err.run)
              : studentView(err.run)
            : null,
        });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// --- отчёты ----------------------------------------------------------------

// Последний прогон по паре «задание - студент».
router.get("/runs/latest", requireLogin, (req, res) => {
  const isTeacher = req.session.user.role === "teacher";
  const assignmentId = parseInt(req.query.assignmentId, 10);
  const studentId = isTeacher
    ? parseInt(req.query.studentId, 10)
    : req.session.user.id;
  if (!assignmentId || !studentId) {
    return res.status(400).json({ error: "Нужны задание и ученик" });
  }
  const assignment = assignmentById(assignmentId);
  if (!assignment) return res.status(404).json({ error: "Задание не найдено" });

  const run = checks.latestRunFor(assignmentId, studentId);
  res.json({
    configured: !!checks.readyFor(assignment),
    run: isTeacher ? teacherView(run) : studentView(run),
    history: isTeacher ? checks.historyFor(assignmentId, studentId) : [],
  });
});

// Прогон, относящийся к одной сохранённой версии.
router.get("/runs/submission/:submissionId", requireLogin, (req, res) => {
  const submission = submissionById(req.params.submissionId);
  if (!submission) return res.status(404).json({ error: "Версия не найдена" });
  const isTeacher = req.session.user.role === "teacher";
  if (!isTeacher && submission.student_id !== req.session.user.id) {
    return res.status(403).json({ error: "Это не ваша версия" });
  }
  const assignment = assignmentById(submission.assignment_id);
  const run = checks.runForSubmission(submission.id);
  res.json({
    configured: !!(assignment && checks.readyFor(assignment)),
    run: isTeacher ? teacherView(run) : studentView(run),
  });
});

module.exports = router;
