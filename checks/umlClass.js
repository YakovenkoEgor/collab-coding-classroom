// Проверка диаграмм классов по эталонам: обёртка над инструментом
// checker/uml_check (ТЗ «автоматическая проверка UML-диаграмм классов»).
//
// Платформа тут не считает ничего сама. Она складывает во временный каталог
// то, что инструмент ждёт на входе - task_config.yaml, refs/*.puml,
// student.puml - запускает его и читает три файла на выходе: JSON-отчёт,
// отчёт преподавателю и отчёт студенту. Разделение намеренное: метрики,
// пороги и формулировки живут в одном месте, их можно прогнать из командной
// строки и покрыть тестами без сервера.
//
// Студенческий файл инструменту передаётся как данные: он его только читает,
// !include игнорирует, в сеть не ходит.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const { toYaml } = require("./yaml");
const plantuml = require("../plantuml");

const ID = "uml-class";
const LABEL = "Диаграмма классов по эталонам";
const APPLIES_TO = ["diagram"];

// ТЗ п. 0: по умолчанию три варианта решения, и больше трёх не нужно.
const MAX_REFERENCES = 3;

const ROOT = path.join(__dirname, "..", "checker");
const TIMEOUT_MS = parseInt(process.env.UML_CHECK_TIMEOUT_MS || "60000", 10);
const MAX_SOURCE_CHARS = parseInt(
  process.env.UML_CHECK_MAX_SOURCE_CHARS || "200000",
  10
);

class CheckConfigError extends Error {}
class CheckError extends Error {}

// --- интерпретатор ---------------------------------------------------------

// Окружение инструмента: переменная среды, затем окружение в checker/.venv,
// затем python из PATH. Своё окружение предпочтительнее - в нём версии
// библиотек те, под которые инструмент писался и которые он пишет в отчёт.
function interpreterCandidates() {
  const candidates = [];
  if (process.env.UML_CHECK_PYTHON) candidates.push(process.env.UML_CHECK_PYTHON);
  if (process.platform === "win32") {
    candidates.push(path.join(ROOT, ".venv", "Scripts", "python.exe"));
  } else {
    candidates.push(path.join(ROOT, ".venv", "bin", "python"));
  }
  return candidates;
}

function interpreter() {
  for (const candidate of interpreterCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // недоступный путь - просто следующий кандидат
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}

let probe = { at: 0, problem: null };
const PROBE_TTL_MS = 30000;

// Быстрая проверка готовности: без неё первая же проверка упала бы с
// трассировкой Python вместо внятного «окружение не создано».
async function problem() {
  if (Date.now() - probe.at < PROBE_TTL_MS) return probe.problem;
  let result = null;
  try {
    const { code, stderr } = await execute(
      ["-c", "import uml_check, scipy, yaml, pymorphy3"],
      { timeout: 20000 }
    );
    if (code !== 0) {
      result =
        "Окружение проверяльщика не готово. Создайте его: " +
        "`python -m venv checker/.venv` и `checker/.venv/Scripts/python -m pip " +
        "install -r checker/requirements.txt` (подробнее — checker/README.md)." +
        (stderr ? ` Python сказал: ${stderr.trim().split("\n").pop()}` : "");
    }
  } catch (err) {
    result = `Не удалось запустить Python: ${err.message}`;
  }
  probe = { at: Date.now(), problem: result };
  return result;
}

function execute(args, { timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(interpreter(), args, {
      cwd: ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new CheckError("Проверка не уложилась во время"));
      }
      resolve({ code, stdout, stderr });
    });
  });
}

// --- конфигурация ----------------------------------------------------------

const MAX_NAMES = 100;
const MAX_NAME_CHARS = 120;

function text(value, what) {
  const result = String(value === undefined || value === null ? "" : value).trim();
  if (result.length > MAX_NAME_CHARS) {
    throw new CheckConfigError(`${what}: слишком длинное имя`);
  }
  return result;
}

function names(raw, what) {
  const list = Array.isArray(raw)
    ? raw
    : String(raw || "")
        .split(/[\n,;]+/)
        .map((item) => item.trim());
  const out = [];
  for (const item of list) {
    const name = text(item, what);
    if (name && !out.includes(name)) out.push(name);
  }
  if (out.length > MAX_NAMES) {
    throw new CheckConfigError(`${what}: не больше ${MAX_NAMES} имён`);
  }
  return out;
}

function number(raw, what, { min = 0, max = 1, fallback }) {
  if (raw === undefined || raw === null || raw === "") {
    if (fallback === undefined) {
      throw new CheckConfigError(`${what}: значение не указано`);
    }
    return fallback;
  }
  const value = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new CheckConfigError(`${what}: ожидается число от ${min} до ${max}`);
  }
  // Шесть знаков - столько же, сколько в отчёте; иначе хеш конфигурации
  // менялся бы от незначащих разрядов.
  return Math.round(value * 1e6) / 1e6;
}

const DEFAULT_CONFIG = {
  weights: { c1: 0.2, c2: 0.2, c3: 0.3, c4: 0.1, c5: 0.2 },
  thresholds: { accept: 0.85, reject: 0.55, match_min: 0.5, name_min: 0.6 },
  partial_credit: { relation_kind_mismatch: 0.5, relation_inversion: 0.25 },
  extra_classes_max: 0.3,
  check_visibility: false,
  check_types: false,
};

// Приводит то, что пришло из формы задания, к конфигурации инструмента.
// Ключи - его собственные (task_config.yaml), платформа в них не вникает.
function validateConfig(raw, { taskId } = {}) {
  const given = raw && typeof raw === "object" ? raw : {};

  const synonyms = {};
  const rawSynonyms = given.synonyms;
  if (rawSynonyms && typeof rawSynonyms === "object" && !Array.isArray(rawSynonyms)) {
    for (const [key, value] of Object.entries(rawSynonyms)) {
      const name = text(key, "Синонимы");
      if (!name) continue;
      const group = names(value, `Синонимы «${name}»`).filter(
        (item) => item !== name
      );
      if (group.length > 0) synonyms[name] = group;
    }
  } else if (Array.isArray(rawSynonyms)) {
    // Форма присылает список строк вида «Клиент: Заказчик, Покупатель».
    for (const line of rawSynonyms) {
      const [head, tail] = String(line || "").split(":");
      const name = text(head, "Синонимы");
      if (!name || !tail) continue;
      const group = names(tail, `Синонимы «${name}»`).filter(
        (item) => item !== name
      );
      if (group.length > 0) synonyms[name] = group;
    }
  }
  if (Object.keys(synonyms).length > MAX_NAMES) {
    throw new CheckConfigError(`Синонимы: не больше ${MAX_NAMES} групп`);
  }

  const requiredRelations = [];
  for (const pair of Array.isArray(given.required_relations)
    ? given.required_relations
    : []) {
    const items = Array.isArray(pair)
      ? pair
      : String(pair || "")
          .split(/[-—–]|,/)
          .map((item) => item.trim());
    const left = text(items[0], "Обязательные связи");
    const right = text(items[1], "Обязательные связи");
    if (!left || !right) continue;
    if (!requiredRelations.some((item) => item[0] === left && item[1] === right)) {
      requiredRelations.push([left, right]);
    }
  }

  const weights = {
    c1: number(given.weights?.c1, "Вес C1", { fallback: DEFAULT_CONFIG.weights.c1 }),
    c2: number(given.weights?.c2, "Вес C2", { fallback: DEFAULT_CONFIG.weights.c2 }),
    c3: number(given.weights?.c3, "Вес C3", { fallback: DEFAULT_CONFIG.weights.c3 }),
    c4: number(given.weights?.c4, "Вес C4", { fallback: DEFAULT_CONFIG.weights.c4 }),
    c5: number(given.weights?.c5, "Вес C5", { fallback: DEFAULT_CONFIG.weights.c5 }),
  };
  const weightSum = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (Math.abs(weightSum - 1) > 1e-6) {
    throw new CheckConfigError(
      `Веса критериев должны давать в сумме 1,00, а дают ${weightSum.toFixed(2)}`
    );
  }

  const thresholds = {
    accept: number(given.thresholds?.accept, "Порог принятия", {
      fallback: DEFAULT_CONFIG.thresholds.accept,
    }),
    reject: number(given.thresholds?.reject, "Порог отклонения", {
      fallback: DEFAULT_CONFIG.thresholds.reject,
    }),
    match_min: number(given.thresholds?.match_min, "Порог сопоставления классов", {
      fallback: DEFAULT_CONFIG.thresholds.match_min,
    }),
    name_min: number(given.thresholds?.name_min, "Порог сходства имён", {
      fallback: DEFAULT_CONFIG.thresholds.name_min,
    }),
  };
  if (thresholds.reject > thresholds.accept) {
    throw new CheckConfigError(
      "Порог отклонения не может быть больше порога принятия"
    );
  }

  const partialCredit = {
    relation_kind_mismatch: number(
      given.partial_credit?.relation_kind_mismatch,
      "Частичный зачёт связи",
      { fallback: DEFAULT_CONFIG.partial_credit.relation_kind_mismatch }
    ),
    relation_inversion: number(
      given.partial_credit?.relation_inversion,
      "Зачёт перевёрнутой связи",
      { fallback: DEFAULT_CONFIG.partial_credit.relation_inversion }
    ),
  };

  return {
    task_id: text(given.task_id || taskId || "", "Идентификатор задания"),
    language: "ru",
    synonyms,
    required_classes: names(given.required_classes, "Обязательные классы"),
    required_relations: requiredRelations,
    weights,
    thresholds,
    partial_credit: partialCredit,
    extra_classes_max: number(given.extra_classes_max, "Доля лишних классов", {
      max: 5,
      fallback: DEFAULT_CONFIG.extra_classes_max,
    }),
    check_visibility: !!given.check_visibility,
    check_types: !!given.check_types,
  };
}

// Та же конфигурация, как её увидит инструмент. Показывается преподавателю в
// форме задания - чтобы было видно, чем именно проверяется работа.
function configYaml(config, referenceNames = []) {
  const refs = referenceNames.map((name) => `refs/${name}`);
  return toYaml({ ...config, refs });
}

// --- эталоны ---------------------------------------------------------------

function validateReferences(raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > MAX_REFERENCES) {
    throw new CheckConfigError(`Эталонов не больше ${MAX_REFERENCES}`);
  }
  const out = [];
  list.forEach((file, index) => {
    const content = typeof file?.content === "string" ? file.content : "";
    if (!content.trim()) return;
    if (content.length > MAX_SOURCE_CHARS) {
      throw new CheckConfigError(
        `Эталон ${index + 1}: файл длиннее ${MAX_SOURCE_CHARS} символов`
      );
    }
    const given = String(file.filename || "").trim();
    if (given && !plantuml.isDiagramFile(given)) {
      throw new CheckConfigError(
        `Эталон «${given}»: ожидается файл диаграммы (.puml)`
      );
    }
    const slot = `ref_${out.length + 1}`;
    out.push({ slot, filename: given || `${slot}.puml`, content });
  });
  return out;
}

// --- запуск ----------------------------------------------------------------

function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

async function run({ config, references, source, filename }) {
  const blocked = await problem();
  if (blocked) throw new CheckError(blocked);

  if (!references || references.length === 0) {
    throw new CheckError("У задания не задано ни одного эталона");
  }
  const body = typeof source === "string" ? source : "";
  if (!body.trim()) {
    throw new CheckError("Диаграмма пуста — проверять нечего");
  }
  if (body.length > MAX_SOURCE_CHARS) {
    throw new CheckError(`Файл длиннее ${MAX_SOURCE_CHARS} символов`);
  }

  const work = fs.mkdtempSync(
    path.join(os.tmpdir(), `uml-check-${crypto.randomBytes(6).toString("hex")}-`)
  );
  try {
    fs.mkdirSync(path.join(work, "refs"));
    const referenceNames = [];
    for (const reference of references) {
      const name = `${reference.slot}.puml`;
      referenceNames.push(name);
      fs.writeFileSync(path.join(work, "refs", name), reference.content, "utf8");
    }

    const studentPath = path.join(work, "student.puml");
    fs.writeFileSync(studentPath, body, "utf8");
    const configPath = path.join(work, "task_config.yaml");
    fs.writeFileSync(configPath, configYaml(config, referenceNames), "utf8");

    const reportPath = path.join(work, "report.json");
    const teacherPath = path.join(work, "teacher.md");
    const studentReportPath = path.join(work, "student.md");

    const started = Date.now();
    const { code, stderr } = await execute([
      "-m",
      "uml_check",
      "--config",
      configPath,
      "--student",
      studentPath,
      "--out",
      reportPath,
      "--md",
      teacherPath,
      "--student-md",
      studentReportPath,
      "--quiet",
    ]);
    const durationMs = Date.now() - started;

    const rawReport = readIfExists(reportPath);
    if (code !== 0 || !rawReport) {
      throw new CheckError(
        "Проверка завершилась с ошибкой" +
          (stderr ? `: ${stderr.trim().split("\n").pop()}` : "")
      );
    }

    let report;
    try {
      report = JSON.parse(rawReport);
    } catch {
      throw new CheckError("Проверка вернула нечитаемый отчёт");
    }

    return {
      verdict: String(report.verdict || "needs_review"),
      score: typeof report.score === "number" ? report.score : null,
      report,
      teacherReport: readIfExists(teacherPath) || "",
      studentReport: readIfExists(studentReportPath) || "",
      configHash: report.meta?.config_hash || null,
      toolVersion: report.meta?.tool_version || null,
      durationMs,
      checkedFile: filename || null,
    };
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch (err) {
      console.error("[uml-check] не удалось убрать временный каталог:", err.message);
    }
  }
}

// Какой файл работы проверяется. У диаграммы это файл, открытый у студента
// (ровно он и отрисовывается), поэтому выбор делает вызывающая сторона;
// здесь - разумное значение по умолчанию для автоматического прогона.
function pickFile(files, preferred) {
  const diagrams = (files || []).filter((file) =>
    plantuml.isDiagramFile(file.filename)
  );
  if (diagrams.length === 0) return null;
  if (preferred) {
    const chosen = diagrams.find((file) => file.filename === preferred);
    if (chosen) return chosen;
  }
  return diagrams.find((file) => file.isEntry) || diagrams[0];
}

module.exports = {
  ID,
  LABEL,
  APPLIES_TO,
  MAX_REFERENCES,
  CheckConfigError,
  CheckError,
  DEFAULT_CONFIG,
  validateConfig,
  validateReferences,
  configYaml,
  pickFile,
  problem,
  run,
};
