#!/usr/bin/env node
//
// Exports the process log as a ProgSnap2 dataset.
//
//   npm run export:progsnap
//   node scripts/export-progsnap2.js --out exports --no-archive --with-groups
//
// What comes out is a directory (and a .tar.gz beside it) laid out the way
// the specification asks:
//
//   MainTable.csv          one row per event
//   DatasetMetadata.csv    the properties a consumer needs to read the rest
//   README.txt             required by the spec; says what this dataset is
//   CodeStates/<id>/...    one directory per distinct snapshot of the project
//   LinkTables/Subject.csv the subjects, by surrogate key
//
// Specification: https://cssplice.org/progsnap2 - version 8 (Beta).
//
// On personal data: SubjectID is the surrogate key from users.subject_key -
// random, unique, and tied to a person only through the classroom database,
// which is never part of an export. No names, logins, e-mails or marks'
// feedback text go in, and discussion threads between a student and the
// teacher are not exported at all.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const db = require("../db/database");
const progsnap = require("../progsnap");

const ROOT = path.join(__dirname, "..");
const SPEC_VERSION = 8;

// --- arguments -------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    out: path.join(ROOT, "exports"),
    archive: true,
    withGroups: false,
    courseId: process.env.PROGSNAP_COURSE_ID || "java-classroom",
    termId: process.env.PROGSNAP_TERM_ID || "",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") args.out = path.resolve(argv[++i] || args.out);
    else if (arg === "--no-archive") args.archive = false;
    else if (arg === "--with-groups") args.withGroups = true;
    else if (arg === "--course") args.courseId = argv[++i] || args.courseId;
    else if (arg === "--term") args.termId = argv[++i] || args.termId;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else {
      console.error(`Неизвестный аргумент: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

function usage() {
  console.log(`Выгрузка данных процесса в формате ProgSnap2.

  --out <dir>      куда складывать (по умолчанию ./exports)
  --no-archive     не паковать в .tar.gz
  --with-groups    добавить учебную группу в LinkTables/Subject.csv
                   (по умолчанию нет: группа сужает круг до нескольких человек)
  --course <id>    значение CourseID (по умолчанию java-classroom)
  --term <id>      значение TermID, например "2026 осень"
`);
}

// --- CSV (RFC 4180, as the spec requires) -----------------------------------

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(values) {
  return values.map(csvCell).join(",");
}

function writeCsv(file, header, rows) {
  const out = [csvRow(header)];
  for (const row of rows) out.push(csvRow(header.map((col) => row[col])));
  // CRLF: RFC 4180 names it as the line break, and every reader accepts it.
  fs.writeFileSync(file, out.join("\r\n") + "\r\n", "utf8");
}

// --- timestamps -------------------------------------------------------------

// The database stores UTC without a marker; ProgSnap2 wants something a
// consumer can parse, so it goes out as ISO 8601 with the Z.
function isoUtc(stored) {
  if (!stored) return "";
  const text = String(stored).trim().replace(" ", "T");
  return text.endsWith("Z") ? text : `${text}Z`;
}

function sortKey(event) {
  // When the browser said when an edit happened, that is the truth about the
  // ordering; otherwise the server's own clock is.
  return `${isoUtc(event.client_timestamp || event.server_timestamp)}#${String(
    event.id
  ).padStart(12, "0")}`;
}

// --- the dataset -------------------------------------------------------------

function buildDataset(args) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = `progsnap2-${stamp}`;
  const dir = path.join(args.out, name);

  fs.mkdirSync(path.join(dir, "CodeStates"), { recursive: true });
  fs.mkdirSync(path.join(dir, "LinkTables"), { recursive: true });
  fs.mkdirSync(path.join(dir, "Resources"), { recursive: true });

  // Only students have process data, and only students get a subject key.
  const subjects = new Map(
    db
      .prepare(
        `SELECT id, subject_key AS subjectKey, group_name AS groupName
         FROM users WHERE role = 'student' AND subject_key IS NOT NULL`
      )
      .all()
      .map((row) => [row.id, row])
  );

  const assignments = new Map(
    db
      .prepare("SELECT id, type, test_kind AS testKind FROM assignments")
      .all()
      .map((row) => [row.id, row])
  );

  const events = db
    .prepare("SELECT * FROM events ORDER BY id")
    .all()
    // An event without a known subject cannot be part of a dataset about
    // subjects - that would be a row nobody can join to anything.
    .filter((event) => subjects.has(event.subject_id));

  events.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  // ---- MainTable.csv ----
  const header = [
    // Required by the spec
    "EventID",
    "EventType",
    "SubjectID",
    "ToolInstances",
    "CodeStateID",
    // Recommended
    "Order",
    "ServerTimestamp",
    "ServerTimezone",
    "ClientTimestamp",
    "CourseID",
    "TermID",
    "AssignmentID",
    "ProblemID",
    "Attempt",
    // Event-specific
    "SessionID",
    "ParentEventID",
    "ResourceID",
    "CodeStateSection",
    "EventInitiator",
    "EditType",
    "CompileResult",
    "CompileMessageType",
    "CompileMessageData",
    "ExecutionID",
    "ExecutionResult",
    "ProgramInput",
    "ProgramOutput",
    "ProgramErrorOutput",
    "Score",
    // Ours, declared in README.txt
    "X-SandboxStatus",
    "X-Interactive",
    "X-AssignmentType",
    "X-TestKind",
    "X-RawScore",
    "X-MaxScore",
  ];

  const usedCodeStates = new Set();

  // CodeStateID is a required column, and the specification says how to fill
  // it for an event that did not itself produce a snapshot: "If the code has
  // not changed since the previous event, the previous CodeStateID may be
  // reused." So each subject's last known state is carried forward - per
  // assignment where the event belongs to one, and overall otherwise (a
  // Session.Start says nothing about which exercise is open).
  const lastStateBySubject = new Map();
  const lastStateByPair = new Map();

  function carriedState(event) {
    if (event.code_state_id) return event.code_state_id;
    const pairKey = `${event.subject_id}:${event.assignment_id}`;
    if (event.assignment_id !== null && lastStateByPair.has(pairKey)) {
      return lastStateByPair.get(pairKey);
    }
    return lastStateBySubject.get(event.subject_id) || "";
  }

  const rows = events.map((event, index) => {
    const extra = event.extra ? JSON.parse(event.extra) : {};
    const assignment = assignments.get(event.assignment_id) || {};
    const codeStateId = carriedState(event);
    if (event.code_state_id) {
      lastStateBySubject.set(event.subject_id, event.code_state_id);
      if (event.assignment_id !== null) {
        lastStateByPair.set(
          `${event.subject_id}:${event.assignment_id}`,
          event.code_state_id
        );
      }
    }
    if (codeStateId) usedCodeStates.add(codeStateId);

    return {
      EventID: event.id,
      EventType: event.event_type,
      SubjectID: subjects.get(event.subject_id).subjectKey,
      // Required and non-empty for every row: which tool produced the event.
      ToolInstances: "Java Classroom",
      // Either this event's own snapshot or the last one the student is known
      // to have had (see carriedState). Empty only before a student has any
      // code at all - typically their very first Session.Start.
      CodeStateID: codeStateId,
      Order: index,
      ServerTimestamp: isoUtc(event.server_timestamp),
      ServerTimezone: "UTC",
      ClientTimestamp: isoUtc(event.client_timestamp),
      CourseID: args.courseId,
      TermID: args.termId,
      AssignmentID: event.assignment_id === null ? "" : event.assignment_id,
      // One assignment is one problem here; the platform has no sub-problems.
      ProblemID: event.assignment_id === null ? "" : event.assignment_id,
      Attempt: event.attempt === null ? "" : event.attempt,
      SessionID: event.session_id || "",
      ParentEventID: event.parent_event_id === null ? "" : event.parent_event_id,
      ResourceID: event.resource_id || "",
      CodeStateSection: event.code_state_section || "",
      EventInitiator: event.event_initiator || "",
      EditType: event.edit_type || "",
      CompileResult: event.compile_result || "",
      CompileMessageType: event.compile_message_type || "",
      CompileMessageData: event.compile_message_data || "",
      ExecutionID: event.execution_id || "",
      ExecutionResult: event.execution_result || "",
      ProgramInput: event.program_input || "",
      ProgramOutput: event.program_output || "",
      ProgramErrorOutput: event.program_error_output || "",
      Score: event.score === null ? "" : event.score,
      "X-SandboxStatus": extra["X-SandboxStatus"] || "",
      "X-Interactive": extra["X-Interactive"] || "",
      "X-AssignmentType": assignment.type || "",
      "X-TestKind": extra["X-TestKind"] || "",
      "X-RawScore": extra["X-RawScore"] === undefined ? "" : extra["X-RawScore"],
      "X-MaxScore": extra["X-MaxScore"] === undefined ? "" : extra["X-MaxScore"],
    };
  });

  writeCsv(path.join(dir, "MainTable.csv"), header, rows);

  // ---- CodeStates/ (Directory format) ----
  // Only the snapshots the exported events actually point at, each once.
  const filesOf = db.prepare(
    `SELECT filename, content, encoding, is_entry AS isEntry
     FROM event_code_state_files WHERE code_state_id = ? ORDER BY filename`
  );
  let codeStateFiles = 0;
  for (const codeStateId of usedCodeStates) {
    const stateDir = path.join(dir, "CodeStates", codeStateId);
    fs.mkdirSync(stateDir, { recursive: true });
    for (const file of filesOf.all(codeStateId)) {
      // A data file that is not text was stored base64; it goes back to bytes
      // here, so the directory holds the project as the student had it.
      const payload =
        file.encoding === "base64"
          ? Buffer.from(file.content, "base64")
          : Buffer.from(file.content, "utf8");
      fs.writeFileSync(path.join(stateDir, path.basename(file.filename)), payload);
      codeStateFiles++;
    }
  }

  // ---- LinkTables/Subject.csv ----
  // The subjects themselves. With --with-groups it also carries the study
  // group, which is a quasi-identifier in a small class - hence opt-in.
  const subjectHeader = args.withGroups
    ? ["SubjectID", "X-GroupName"]
    : ["SubjectID"];
  const seenSubjects = new Set(rows.map((row) => row.SubjectID));
  writeCsv(
    path.join(dir, "LinkTables", "Subject.csv"),
    subjectHeader,
    [...subjects.values()]
      .filter((subject) => seenSubjects.has(subject.subjectKey))
      .map((subject) => ({
        SubjectID: subject.subjectKey,
        "X-GroupName": subject.groupName || "",
      }))
  );

  // ---- DatasetMetadata.csv ----
  // Two columns, Property and Value, as the specification's examples show.
  writeCsv(
    path.join(dir, "DatasetMetadata.csv"),
    ["Property", "Value"],
    [
      { Property: "Version", Value: String(SPEC_VERSION) },
      { Property: "IsEventOrderingConsistent", Value: "true" },
      // One server, one clock, one log: the Order column is meaningful across
      // the whole dataset, not just within a student.
      { Property: "EventOrderScope", Value: "Global" },
      { Property: "EventOrderScopeColumns", Value: "" },
      { Property: "CodeStateRepresentation", Value: "Directory" },
    ]
  );

  // ---- README.txt (required) ----
  const counts = {};
  for (const row of rows) counts[row.EventType] = (counts[row.EventType] || 0) + 1;

  fs.writeFileSync(
    path.join(dir, "README.txt"),
    readme({ args, rows, counts, usedCodeStates, codeStateFiles, subjects: seenSubjects }),
    "utf8"
  );

  return { dir, name, rows, counts, codeStates: usedCodeStates.size, codeStateFiles };
}

function readme({ args, rows, counts, usedCodeStates, codeStateFiles, subjects }) {
  const span =
    rows.length === 0
      ? "—"
      : `${rows[0].ServerTimestamp} … ${rows[rows.length - 1].ServerTimestamp}`;

  return `Java Classroom — данные процесса программирования в формате ProgSnap 2
================================================================

Спецификация: ProgSnap 2, версия ${SPEC_VERSION} (Beta), https://cssplice.org/progsnap2
Выгружено: ${new Date().toISOString()}
Курс (CourseID): ${args.courseId}
Семестр (TermID): ${args.termId || "не указан"}

Состав набора
-------------
MainTable.csv            событий: ${rows.length}
CodeStates/              снимков кода: ${usedCodeStates.size} (файлов: ${codeStateFiles})
LinkTables/Subject.csv   участников: ${subjects.size}
DatasetMetadata.csv      свойства набора
Resources/               пусто: внешних материалов в наборе нет

Период наблюдений: ${span}

Событий по типам
----------------
${Object.entries(counts)
  .sort((a, b) => b[1] - a[1])
  .map(([type, count]) => `  ${type.padEnd(22)} ${count}`)
  .join("\n") || "  (нет событий)"}

Персональные данные
-------------------
SubjectID — суррогатный ключ (users.subject_key): случайный, уникальный,
никак не выведенный из логина, имени или идентификатора в базе. Сопоставление
ключа с человеком существует только в учебной базе платформы и в выгрузку не
попадает. В наборе нет имён, логинов, адресов почты и комментариев
преподавателя к оценкам. Переписка ученика с преподавателем не выгружается
принципиально. Учебная группа попадает в Subject.csv только при запуске с
ключом --with-groups: в небольшом классе это квазиидентификатор.

Нестандартные типы событий (префикс X-, как предписывает спецификация)
----------------------------------------------------------------------
  X-Draft.Save   сохранение черновика. Это не Submit: сдачей считается только
                 явная отправка работы преподавателю.
  X-Grade        выставление оценки преподавателем. Score нормирован к 0..1
                 относительно максимума, действовавшего для группы ученика;
                 исходные значения — в X-RawScore и X-MaxScore.
  X-Test.Start   начало попытки прохождения теста.
  X-Test.Submit  отправка ответов теста. Сами ответы не выгружаются.
  X-Sandbox.Error  сбой самой песочницы (например, на сервере не запущен
                 Docker). Код ученика при этом не компилировался и не
                 запускался, поэтому Compile и Run.Program для такой попытки
                 отсутствуют: это отказ платформы, а не ошибка ученика.

Нестандартные колонки
---------------------
  X-SandboxStatus   собственный статус песочницы до приведения к
                    ExecutionResult: Accepted, Time Limit Exceeded,
                    Runtime Error, Compilation Error, Sandbox Error.
  X-Interactive     true, если запуск был интерактивным (ученик вводил данные
                    в консоль по ходу выполнения), иначе false.
  X-AssignmentType  тип задания: code, text, freeform, test.
  X-TestKind        для тестов: graded или survey.
  X-RawScore,
  X-MaxScore        оценка и максимум в баллах курса, до нормирования.

Что нужно знать при анализе
---------------------------
1. Запуск программы — это пара событий: Compile и затем Run.Program, связанные
   через ParentEventID и общий ExecutionID. Если компиляция не удалась,
   Run.Program не возникает, а появляется Compile.Error.
2. ExecutionResult приведён к перечислению спецификации: Accepted → Success,
   превышение лимита времени → Timeout, остальные сбои → Error. Исходный
   статус сохранён в X-SandboxStatus.
3. File.Edit присутствует, только если на сервере включён захват правок
   (PROGSNAP_EDIT_CAPTURE=on). Это не отдельные нажатия клавиш, а снимок
   проекта не чаще, чем раз в PROGSNAP_EDIT_INTERVAL_SECONDS секунд; EditType
   у таких событий — GenericEdit. ClientTimestamp у них взят с часов ученика,
   ServerTimestamp — с часов сервера.
4. Session.End возникает только при явном выходе из системы. Сессия, которая
   просто истекла, события не оставляет, поэтому часть сессий не закрыта.
5. Вывод программы и сообщения компилятора обрезаны до
   ${progsnap.MAX_OUTPUT_CHARS} символов; обрезанные значения заканчиваются
   пометкой об этом.
6. В Order учтено фактическое время события: для правок — время с часов
   ученика, для остального — серверное.
7. CodeStateID у событий, которые сами снимок не создают (Session.*, X-Grade),
   указывает на последнее известное состояние кода этого ученика — так
   предписывает спецификация («если код не менялся, допускается повторное
   использование предыдущего CodeStateID»). Пусто это поле только до того, как
   у ученика появился хоть какой-то код, то есть обычно у самого первого
   события Session.Start.
`;
}

// --- packing ----------------------------------------------------------------

function archive(dir, name, outDir) {
  // Same approach as backup-db.js: the system tar, so no dependency.
  const result = spawnSync("tar", ["-czf", `${name}.tar.gz`, name], {
    cwd: outDir,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    console.warn("Не удалось упаковать архив — каталог остался как есть.");
    return null;
  }
  return path.join(outDir, `${name}.tar.gz`);
}

// --- main -------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();

  fs.mkdirSync(args.out, { recursive: true });
  const built = buildDataset(args);

  console.log(`Набор собран: ${built.dir}`);
  console.log(`  событий:      ${built.rows.length}`);
  console.log(`  снимков кода: ${built.codeStates} (файлов: ${built.codeStateFiles})`);
  for (const [type, count] of Object.entries(built.counts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${type.padEnd(22)} ${count}`);
  }

  if (args.archive) {
    const file = archive(built.dir, built.name, args.out);
    if (file) console.log(`Архив: ${file}`);
  }

  if (built.rows.length === 0) {
    console.log(
      "\nСобытий нет. Журнал ведётся только для учеников; проверьте, что PROGSNAP_LOGGING не выключен."
    );
  }
}

main();
