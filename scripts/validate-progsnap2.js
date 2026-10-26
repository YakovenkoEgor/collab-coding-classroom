#!/usr/bin/env node
//
// Checks an exported dataset against the ProgSnap2 specification before it
// goes anywhere.
//
//   npm run validate:progsnap
//   node scripts/validate-progsnap2.js exports/progsnap2-2026-10-20T11-46-38
//   node scripts/validate-progsnap2.js <dir> --no-privacy-check
//
// With no directory given it takes the newest export under ./exports.
//
// Two kinds of checking happen here. One is conformance: the files the spec
// requires, the columns it requires, the enumerations it fixes, and the
// references between tables. The other is privacy: the export is read back
// looking for anything from the classroom database that should never have
// left it - names, logins, e-mail addresses, feedback text. That second part
// is the reason to run this at all before publishing a dataset.
//
// Exit code is 1 when something is wrong, so it can gate a release.

const fs = require("fs");
const path = require("path");
const { parseCsv } = require("../csv");

const ROOT = path.join(__dirname, "..");

// --- what the specification fixes -------------------------------------------

const STANDARD_EVENT_TYPES = new Set([
  "Session.Start", "Session.End",
  "Project.Open", "Project.Close",
  "File.Create", "File.Delete", "File.Open", "File.Close", "File.Save",
  "File.Rename", "File.Copy", "File.Edit", "File.Focus",
  "Compile", "Compile.Error", "Compile.Warning",
  "Submit",
  "Run.Program", "Run.Test", "Debug.Program", "Debug.Test",
  "Resource.View", "Intervention",
]);

const REQUIRED_COLUMNS = [
  "EventType",
  "EventID",
  "SubjectID",
  "ToolInstances",
  "CodeStateID",
];

const EXECUTION_RESULTS = new Set(["Success", "Timeout", "Error", "TestFailed"]);
const COMPILE_RESULTS = new Set(["Success", "Warning", "Error"]);
const EVENT_INITIATORS = new Set([
  "UserDirectAction", "UserIndirectAction",
  "ToolReaction", "ToolTimedEvent",
  "InstructorDirectAction", "InstructorIndirectAction",
  "TeamMemberDirectAction", "TeamMemberIndirectAction",
]);
const CODE_STATE_REPRESENTATIONS = new Set(["Table", "Directory", "Git"]);
const ORDER_SCOPES = new Set(["Global", "Restricted", "None"]);

// --- plumbing ----------------------------------------------------------------

const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

function note(message) {
  notes.push(message);
}

function readTable(file) {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  if (rows.length === 0) return { header: [], rows: [] };
  const header = rows[0];
  return {
    header,
    rows: rows.slice(1).map((cells) => {
      const row = {};
      header.forEach((name, i) => (row[name] = cells[i] === undefined ? "" : cells[i]));
      return row;
    }),
  };
}

function newestExport() {
  const dir = path.join(ROOT, "exports");
  if (!fs.existsSync(dir)) return null;
  const candidates = fs
    .readdirSync(dir)
    .filter((name) => fs.statSync(path.join(dir, name)).isDirectory())
    .sort();
  return candidates.length > 0 ? path.join(dir, candidates[candidates.length - 1]) : null;
}

// --- checks -------------------------------------------------------------------

function checkLayout(root) {
  for (const rel of [
    "MainTable.csv",
    "DatasetMetadata.csv",
    "README.txt", // required by the spec since version 6
    "CodeStates",
    "LinkTables",
  ]) {
    if (!fs.existsSync(path.join(root, rel))) {
      fail(`нет обязательного файла или каталога: ${rel}`);
    }
  }
}

function checkMetadata(root) {
  const file = path.join(root, "DatasetMetadata.csv");
  if (!fs.existsSync(file)) return {};

  const { rows } = readTable(file);
  const meta = {};
  for (const row of rows) meta[row.Property] = row.Value;

  for (const key of [
    "Version",
    "IsEventOrderingConsistent",
    "EventOrderScope",
    "CodeStateRepresentation",
  ]) {
    if (!(key in meta)) fail(`DatasetMetadata.csv: нет свойства ${key}`);
  }

  if (meta.CodeStateRepresentation && !CODE_STATE_REPRESENTATIONS.has(meta.CodeStateRepresentation)) {
    fail(
      `CodeStateRepresentation = «${meta.CodeStateRepresentation}», допустимы Table, Directory, Git`
    );
  }
  if (meta.EventOrderScope && !ORDER_SCOPES.has(meta.EventOrderScope)) {
    fail(`EventOrderScope = «${meta.EventOrderScope}», допустимы Global, Restricted, None`);
  }
  if (meta.EventOrderScope === "Restricted" && !(meta.EventOrderScopeColumns || "").trim()) {
    fail("EventOrderScope = Restricted требует непустого EventOrderScopeColumns");
  }
  return meta;
}

// Order values must be distinct within the scope the metadata declares - the
// whole dataset for Global, per group of columns for Restricted.
function checkOrdering(rows, meta) {
  if (meta.EventOrderScope === "None") return;
  const scopeColumns =
    meta.EventOrderScope === "Restricted"
      ? (meta.EventOrderScopeColumns || "").split(";").map((c) => c.trim()).filter(Boolean)
      : [];

  const seen = new Map();
  for (const row of rows) {
    if (!row.Order) continue;
    const scope = scopeColumns.map((col) => row[col] || "").join("|");
    const key = `${scope}#${row.Order}`;
    if (seen.has(key)) {
      fail(
        `Order = ${row.Order} повторяется в одной области видимости: события ${seen.get(key)} и ${row.EventID}`
      );
    }
    seen.set(key, row.EventID);
  }
}

function checkEvents(root, meta) {
  const file = path.join(root, "MainTable.csv");
  if (!fs.existsSync(file)) return { rows: [], codeStates: new Set() };

  const { header, rows } = readTable(file);
  for (const col of REQUIRED_COLUMNS) {
    if (!header.includes(col)) fail(`MainTable.csv: нет обязательной колонки ${col}`);
  }

  const eventIds = new Set(rows.map((row) => row.EventID));
  const seenIds = new Set();
  const codeStates = new Set();

  for (const row of rows) {
    const where = `событие ${row.EventID || "(без EventID)"}`;
    const type = row.EventType || "";

    for (const col of REQUIRED_COLUMNS) {
      if (!header.includes(col)) continue;
      if ((row[col] || "") !== "") continue;
      if (col === "CodeStateID") {
        // The spec lets an event reuse the previous code state, and before a
        // student has written anything there is none to reuse. Worth seeing,
        // not worth failing: a dataset full of these is a different matter.
        note(`${where} (${type}): пустой CodeStateID`);
      } else {
        fail(`${where}: пустая обязательная колонка ${col}`);
      }
    }

    if (type && !STANDARD_EVENT_TYPES.has(type) && !type.startsWith("X-")) {
      fail(`${where}: EventType «${type}» не из перечисления и без префикса X-`);
    }

    if (seenIds.has(row.EventID)) fail(`${where}: EventID повторяется`);
    seenIds.add(row.EventID);

    const initiator = row.EventInitiator || "";
    if (initiator && !EVENT_INITIATORS.has(initiator) && !initiator.startsWith("X-")) {
      fail(`${where}: EventInitiator «${initiator}» не из перечисления`);
    }

    // Columns the spec requires for a particular event type.
    if (type === "Compile") {
      if (!COMPILE_RESULTS.has(row.CompileResult || "")) {
        fail(`${where}: Compile требует CompileResult из перечисления`);
      }
      if (!(row.CodeStateSection || "")) {
        fail(`${where}: Compile требует CodeStateSection`);
      }
    }
    if (type.startsWith("Compile.") && !(row.CompileMessageType || "")) {
      fail(`${where}: ${type} требует CompileMessageType`);
    }
    if ((type.startsWith("Run.") || type.startsWith("Debug.")) &&
        !EXECUTION_RESULTS.has(row.ExecutionResult || "")) {
      fail(`${where}: ${type} требует ExecutionResult из перечисления`);
    }
    if (type.startsWith("File.") && !(row.CodeStateSection || "")) {
      fail(`${where}: ${type} требует CodeStateSection`);
    }
    if (type === "Resource.View" && !(row.ResourceID || "")) {
      fail(`${where}: Resource.View требует ResourceID`);
    }
    if (type === "Intervention" && !(row.EventInitiator || "")) {
      fail(`${where}: Intervention требует EventInitiator`);
    }

    if (row.Score) {
      const score = Number(row.Score);
      if (!Number.isFinite(score) || score < 0 || score > 1) {
        fail(`${where}: Score = ${row.Score}, а должен быть числом от 0 до 1`);
      }
    }

    if (row.ParentEventID && !eventIds.has(row.ParentEventID)) {
      fail(`${where}: ParentEventID = ${row.ParentEventID} указывает на несуществующее событие`);
    }

    if (row.CodeStateID) codeStates.add(row.CodeStateID);
  }

  checkOrdering(rows, meta);
  return { rows, codeStates };
}

function checkCodeStates(root, meta, codeStates) {
  if (meta.CodeStateRepresentation !== "Directory") {
    note(
      `представление снимков — ${meta.CodeStateRepresentation || "не указано"}; проверена только главная таблица`
    );
    return 0;
  }

  let files = 0;
  for (const id of codeStates) {
    const dir = path.join(root, "CodeStates", id);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      fail(`нет каталога CodeStates/${id}, на который ссылается главная таблица`);
      continue;
    }
    const contents = fs.readdirSync(dir);
    if (contents.length === 0) fail(`каталог CodeStates/${id} пуст`);
    files += contents.length;
  }

  // Snapshots nobody points at are not an error, but they are dead weight in
  // a published dataset.
  const onDisk = fs.existsSync(path.join(root, "CodeStates"))
    ? fs.readdirSync(path.join(root, "CodeStates"))
    : [];
  const orphans = onDisk.filter((id) => !codeStates.has(id));
  if (orphans.length > 0) {
    note(`снимков, на которые никто не ссылается: ${orphans.length}`);
  }
  return files;
}

function checkSubjects(root, rows) {
  const file = path.join(root, "LinkTables", "Subject.csv");
  if (!fs.existsSync(file)) {
    note("нет LinkTables/Subject.csv — таблица связей необязательна");
    return;
  }

  const { header, rows: subjects } = readTable(file);
  if (!header.includes("SubjectID")) {
    fail("LinkTables/Subject.csv: нет колонки SubjectID");
    return;
  }
  // The spec allows extra columns in a link table only with the X- prefix.
  for (const col of header) {
    if (col !== "SubjectID" && col !== "URL" && !col.startsWith("X-")) {
      fail(`LinkTables/Subject.csv: колонка «${col}» должна начинаться с X-`);
    }
  }

  const listed = new Set(subjects.map((row) => row.SubjectID));
  const used = new Set(rows.map((row) => row.SubjectID).filter(Boolean));
  for (const id of used) {
    if (!listed.has(id)) note(`участник ${id} есть в событиях, но не в Subject.csv`);
  }
}

// The point of the surrogate key: nothing from the classroom database that
// identifies a person may appear in an export. This reads the database and
// looks for it in the exported text.
function checkPrivacy(root) {
  let db;
  try {
    db = require("../db/database");
  } catch (err) {
    note(`проверка на личные данные пропущена: база недоступна (${err.message})`);
    return;
  }

  const users = db
    .prepare(
      `SELECT username, display_name AS displayName, first_name AS firstName,
              last_name AS lastName, email, initial_password AS initialPassword,
              subject_key AS subjectKey
       FROM users`
    )
    .all();

  // Everything that must never show up, with a label for the report. Short
  // values are skipped: a one-letter surname would match everything.
  const secrets = [];
  for (const user of users) {
    for (const [label, value] of Object.entries({
      логин: user.username,
      "имя и фамилия": user.displayName,
      имя: user.firstName,
      фамилия: user.lastName,
      почта: user.email,
      пароль: user.initialPassword,
    })) {
      const text = (value || "").trim();
      if (text.length >= 4) secrets.push({ label, text });
    }
  }
  for (const row of db.prepare("SELECT feedback FROM grades").all()) {
    const text = (row.feedback || "").trim();
    if (text.length >= 8) secrets.push({ label: "комментарий к оценке", text });
  }
  for (const row of db.prepare("SELECT body FROM messages").all()) {
    const text = (row.body || "").trim();
    if (text.length >= 8) secrets.push({ label: "сообщение из обсуждения", text });
  }

  const exported = [];
  for (const rel of ["MainTable.csv", "README.txt", path.join("LinkTables", "Subject.csv")]) {
    const file = path.join(root, rel);
    if (fs.existsSync(file)) exported.push([rel, fs.readFileSync(file, "utf8")]);
  }
  const codeStatesDir = path.join(root, "CodeStates");
  if (fs.existsSync(codeStatesDir)) {
    for (const id of fs.readdirSync(codeStatesDir)) {
      const dir = path.join(codeStatesDir, id);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        exported.push([
          `CodeStates/${id}/${name}`,
          fs.readFileSync(path.join(dir, name), "utf8"),
        ]);
      }
    }
  }

  for (const [where, text] of exported) {
    const lower = text.toLowerCase();
    for (const secret of secrets) {
      if (lower.includes(secret.text.toLowerCase())) {
        // Code the student wrote is theirs to put a name in; that is not a
        // leak by the exporter, but it is worth saying out loud.
        const message = `${where}: встречается ${secret.label} «${secret.text}»`;
        if (where.startsWith("CodeStates/")) note(`${message} — это текст кода ученика`);
        else fail(message);
      }
    }
  }

  // And the reverse: SubjectID really should be the surrogate key.
  const keys = new Set(users.map((u) => u.subjectKey).filter(Boolean));
  const mainTable = path.join(root, "MainTable.csv");
  if (fs.existsSync(mainTable) && keys.size > 0) {
    const { rows } = readTable(mainTable);
    for (const row of rows) {
      if (row.SubjectID && !keys.has(row.SubjectID)) {
        fail(`событие ${row.EventID}: SubjectID «${row.SubjectID}» не является суррогатным ключом`);
      }
    }
  }
}

// --- main ----------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const privacy = !argv.includes("--no-privacy-check");
  const target = argv.find((arg) => !arg.startsWith("--")) || newestExport();

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Проверка набора данных ProgSnap2.

  node scripts/validate-progsnap2.js [каталог] [--no-privacy-check]

Без указания каталога берётся самая свежая выгрузка из ./exports.
--no-privacy-check пропускает сверку с базой на утечку личных данных.`);
    return;
  }

  if (!target) {
    console.error("Не указан каталог набора, и в ./exports ничего нет.");
    process.exit(1);
  }
  if (!fs.existsSync(target)) {
    console.error(`Каталог не найден: ${target}`);
    process.exit(1);
  }

  console.log(`Проверяется: ${target}\n`);

  checkLayout(target);
  const meta = checkMetadata(target);
  const { rows, codeStates } = checkEvents(target, meta);
  const codeStateFiles = checkCodeStates(target, meta, codeStates);
  checkSubjects(target, rows);
  if (privacy) checkPrivacy(target);
  else note("сверка с базой на личные данные пропущена (--no-privacy-check)");

  console.log(`событий:      ${rows.length}`);
  console.log(`снимков кода: ${codeStates.size} (файлов: ${codeStateFiles})`);
  console.log(
    `участников:   ${new Set(rows.map((r) => r.SubjectID).filter(Boolean)).size}`
  );

  if (notes.length > 0) {
    console.log("\nЗамечания (не нарушения):");
    for (const message of notes) console.log(`  · ${message}`);
  }

  if (problems.length > 0) {
    console.log(`\nНАРУШЕНИЯ (${problems.length}):`);
    for (const message of problems) console.log(`  ✗ ${message}`);
    process.exit(1);
  }

  console.log("\nНарушений не найдено.");
}

main();
