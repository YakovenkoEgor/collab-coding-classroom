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

// Есть ли pip в созданном окружении.
//
// В Debian и Ubuntu модуль venv разложен по пакетам: сам `python3 -m venv`
// работает, а ensurepip лежит в python3-venv, которого в системе может не
// быть. Тогда окружение создаётся пустым, без pip, и установка падает с
// «No module named pip». Системный pip из apt тут не при чём - внутри
// окружения его всё равно нет.
function hasPip(python) {
  return (
    spawnSync(python, ["-m", "pip", "--version"], { stdio: "ignore" }).status === 0
  );
}

function ensurePip(python) {
  if (hasPip(python)) return;
  console.log("В окружении нет pip — доставляю через ensurepip …");
  const result = spawnSync(python, ["-m", "ensurepip", "--upgrade"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.status === 0 && hasPip(python)) return;

  console.error(
    [
      "",
      "В окружении checker/.venv нет pip, и доставить его нечем.",
      "",
      "В Debian и Ubuntu за это отвечает отдельный пакет. Поставьте его и",
      "пересоздайте окружение:",
      "",
      "  sudo apt install -y python3-venv python3-pip",
      "  rm -rf checker/.venv",
      "  npm run setup:checker",
      "",
      "Если apt скажет, что пакета нет, возьмите версионный - например,",
      "python3.12-venv под Python 3.12 (`python3 -V` покажет версию).",
    ].join("\n")
  );
  process.exit(1);
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
ensurePip(python);
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
