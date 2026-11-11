// Запись YAML.
//
// Инструменты проверки получают конфигурацию задания файлом (ТЗ по UML -
// task_config.yaml), а в платформе она хранится как JSON. Полноценная
// библиотека для этого не нужна: тут нет ни ссылок, ни многострочных блоков,
// ни тегов - только отображения, списки и скаляры. Зато нужна предсказуемость,
// поэтому строки всегда в кавычках, а порядок ключей - тот, в котором их
// перечислили.
//
// Этот же текст показывается преподавателю в форме задания, так что он должен
// читаться как YAML из документации, а не как JSON в одну строку.

const INDENT = "  ";

function escapeString(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

// Простое имя остаётся без кавычек (так конфигурация читается как в ТЗ),
// всё остальное - в кавычках, чтобы ключ со спецсимволом не ломал файл.
const PLAIN_KEY = /^[0-9A-Za-zА-Яа-яЁё_][0-9A-Za-zА-Яа-яЁё_. -]*$/;

function key(name) {
  const text = String(name);
  return PLAIN_KEY.test(text) ? text : `"${escapeString(text)}"`;
}

function isScalar(value) {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function scalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`YAML: нечисловое значение ${value}`);
    }
    return String(value);
  }
  return `"${escapeString(value)}"`;
}

// Список скаляров и список списков скаляров пишутся в строку: так
// `required_relations: [["Клиент", "Счёт"]]` выглядит как в ТЗ.
function flow(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => flow(item)).join(", ")}]`;
  }
  if (value && typeof value === "object") {
    const pairs = Object.entries(value).map(
      ([name, item]) => `${key(name)}: ${flow(item)}`
    );
    return `{${pairs.join(", ")}}`;
  }
  return scalar(value);
}

function isFlat(value) {
  if (Array.isArray(value)) return value.every(isScalar);
  if (value && typeof value === "object") {
    return Object.values(value).every(isScalar);
  }
  return false;
}

function emit(value, depth) {
  const pad = INDENT.repeat(depth);
  const lines = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      if (isScalar(item) || isFlat(item)) {
        lines.push(`${pad}- ${flow(item)}`);
      } else {
        lines.push(`${pad}-`);
        lines.push(...emit(item, depth + 1));
      }
    }
    return lines;
  }

  for (const [name, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (isScalar(item)) {
      lines.push(`${pad}${key(name)}: ${scalar(item)}`);
    } else if (isFlat(item)) {
      lines.push(`${pad}${key(name)}: ${flow(item)}`);
    } else if (Array.isArray(item) && item.length === 0) {
      lines.push(`${pad}${key(name)}: []`);
    } else if (!Array.isArray(item) && Object.keys(item).length === 0) {
      lines.push(`${pad}${key(name)}: {}`);
    } else {
      lines.push(`${pad}${key(name)}:`);
      lines.push(...emit(item, depth + 1));
    }
  }
  return lines;
}

// Объект -> текст YAML. Верхний уровень всегда отображение.
function toYaml(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("YAML: на верхнем уровне ожидается объект");
  }
  const lines = emit(value, 0);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

module.exports = { toYaml };
