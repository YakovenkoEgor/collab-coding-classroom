// Готовит окружение проверяльщиков и, с --test, прогоняет их тесты.
//
//   npm run setup:checker
//   npm run test:checker
//
// Делает ровно то, что написано в checker/README.md, - создаёт checker/.venv и
// ставит в него зависимости, - но одной командой и одинаково на Windows и на
// Linux. Это единственное, что нужно для автоматической проверки: ни Docker,
// ни доступа в сеть из песочницы она не требует.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "checker");
const VENV = path.join(ROOT, ".venv");
const WINDOWS = process.platform === "win32";

function venvPython() {
  return WINDOWS
    ? path.join(VENV, "Scripts", "python.exe")
    : path.join(VENV, "bin", "python");
}

// Какой python создаёт окружение. На Windows его обычно зовут `python`, в
// остальных местах - `python3`; PYTHON переопределяет и то, и другое.
function hostPython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  return WINDOWS ? "python" : "python3";
}

function run(command, args, what) {
  process.stdout.write(`\n$ ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) {
    console.error(`\n${what}: не удалось запустить ${command} — ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n${what}: завершилось с кодом ${result.status}`);
    process.exit(result.status || 1);
  }
}

const wantsTests = process.argv.includes("--test");

if (!fs.existsSync(path.join(ROOT, "requirements.txt"))) {
  console.error("Не найден checker/requirements.txt — каталог проверяльщиков на месте?");
  process.exit(1);
}

if (!fs.existsSync(venvPython())) {
  console.log("Создаю окружение проверяльщиков в checker/.venv …");
  run(hostPython(), ["-m", "venv", ".venv"], "Создание окружения");
}

const python = venvPython();
run(
  python,
  ["-m", "pip", "install", "--disable-pip-version-check", "-q", "-r",
   wantsTests ? "requirements-dev.txt" : "requirements.txt"],
  "Установка зависимостей"
);

if (wantsTests) {
  run(python, ["-m", "pytest", "tests", "-q"], "Тесты проверяльщика");
  console.log("\nТесты пройдены.");
} else {
  // Короткая проверка того, что инструмент действительно собирается: импорт
  // тянет за собой scipy и словарь морфологии.
  run(
    python,
    ["-c", "import uml_check, scipy, yaml, pymorphy3; print('uml_check готов')"],
    "Проверка окружения"
  );
  console.log("\nГотово. Автоматическая проверка диаграмм включается в форме задания.");
}
