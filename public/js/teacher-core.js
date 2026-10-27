let currentUser = null;
let assignments = [];
let activeAssignment = null;
let activeStudent = null; // {studentId, displayName}
let activeProfile = null; // student whose profile page is open, if any
// Counts of submitted-but-ungraded work, keyed by assignment id and student id.
let pendingReview = { byAssignment: {}, byStudent: {} };
let versions = [];
let activeVersion = null;
let editingAssignmentId = null; // set while the form is editing, null when creating
let existingHandouts = []; // handouts already attached to the assignment being edited
let removedHandoutIds = []; // marked for removal, applied on save
let starterFiles = []; // starter project being authored in the new-assignment form
let starterActive = null; // starter file shown in the textarea
let starterEntry = null; // starter file the student's Run will start from
let viewerFiles = []; // files of the version being reviewed
let viewerFile = null; // which of them is shown in the editor
let viewerEditor = null;
let editorReady = null;

// Grading scale: whole numbers from 0 up to the assignment's own maximum,
// which the teacher sets when creating it (mirrored in routes/assignments.js
// and routes/grades.js).
const MIN_SCORE = 0;
const MIN_MAX_SCORE = 1;
const MAX_MAX_SCORE = 100;

// A survey records answers but is never marked: no grade box, no column in
// the gradebook export (see routes/grades.js).
function isSurvey() {
  return (
    !!activeAssignment &&
    activeAssignment.type === "test" &&
    activeAssignment.test_kind === "survey"
  );
}

// The top mark that applies to the student being reviewed. An assignment has
// none of its own any more - it exists per study group - so outside a review
// there is nothing to show.
function currentMaxScore() {
  const value = activeStudent && activeStudent.maxScore;
  return Number.isInteger(value) && value > 0 ? value : null;
}

// ---------- Student names ----------
//
// Students are listed the way a register lists them: surname first, then given
// name. display_name is stored as "Имя Фамилия", so it is only a fallback for
// rows that predate the split name fields.
function studentName(row) {
  if (!row) return "";
  const last = (row.lastName || "").trim();
  const first = (row.firstName || "").trim();
  if (last && first) return `${last} ${first}`;
  return last || first || row.displayName || "";
}

// Surname-first comparison, so "Ёлкина" and "елкина" land where a teacher
// expects them to.
function byStudentName(a, b) {
  return studentName(a).localeCompare(studentName(b), "ru", { sensitivity: "base" });
}

// Assignment kinds, mirrored from routes/assignments.js
const ASSIGNMENT_TYPES = [
  { value: "code", label: "Код", hint: "проект на Java, который ученик запускает" },
  { value: "text", label: "Текст", hint: "письменный ответ, с теми же версиями" },
  { value: "freeform", label: "Произвольное", hint: "ученик прикладывает файлы" },
  { value: "test", label: "Тест", hint: "вопросы, на которые отвечают за один раз" },
];
const TYPE_LABEL = {
  code: "Код",
  text: "Текст",
  freeform: "Произвольное",
  test: "Тест",
};

// Test settings, mirrored from testing.js
const TEST_QUESTION_KINDS = [
  { value: "single", label: "Один правильный ответ" },
  { value: "multiple", label: "Несколько правильных ответов" },
  { value: "open", label: "Открытый ответ" },
];
const DEFAULT_TIME_LIMIT = 15;
const MIN_TIME_LIMIT = 1;
const MAX_TIME_LIMIT = 600;

// The test being written in the form: [{ kind, body, expectedAnswer, options }]
let testQuestions = [];
// True while editing a test students have already started: the questions can
// no longer change, only the dates, the time limit and the maximum mark.
let testQuestionsFrozen = false;

// Student attachment limits, mirrored from storage.js
const MAX_STUDENT_FILES = 3;
const MAX_STUDENT_MB = 5;

// A small tag showing an assignment's kind.
function typeBadge(type) {
  const label = TYPE_LABEL[type] || TYPE_LABEL.code;
  return `<span class="type-badge type-${type || "code"}">${label}</span>`;
}

// Upload limits, mirrored from storage.js
const MAX_UPLOAD_MB = 10;
const MAX_UPLOAD_FILES = 10;
const ALLOWED_UPLOAD_EXTENSIONS = [
  ".pdf", ".doc", ".docx", ".odt", ".rtf", ".txt", ".md",
  ".ppt", ".pptx", ".xls", ".xlsx", ".csv", ".png", ".jpg", ".jpeg",
];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 401) {
    window.location.href = "/login.html";
    throw new Error("Вы не авторизованы");
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Запрос не выполнен");
  return data;
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}

function initEditor() {
  editorReady = new Promise((resolve) => {
    require.config({ paths: { vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.47.0/min/vs" } });
    require(["vs/editor/editor.main"], () => resolve());
  });
}

async function loadMe() {
  const { user } = await api("/api/auth/me");
  if (!user || user.role !== "teacher") { window.location.href = "/login.html"; return; }
  currentUser = user;
  document.getElementById("whoami").textContent = `${user.displayName} (преподаватель)`;
}

// ---------- Ungraded work indicator ----------

async function loadPendingReview() {
  try {
    pendingReview = await api("/api/assignments/review/pending");
  } catch {
    // A failure here must not blank out the dashboard - just show no badges.
    pendingReview = { byAssignment: {}, byStudent: {} };
  }
}

// The "!" badge shown next to an assignment title or a student's name.
function reviewBadge(count, what) {
  if (!count) return "";
  const label =
    what === "assignment"
      ? `Работ, ожидающих проверки: ${count}`
      : `Сданных заданий, ожидающих проверки: ${count}`;
  return `<span class="needs-review" title="${label}">!</span>`;
}

// ---------- Assignments ----------

async function loadAssignments() {
  const { assignments: list } = await api("/api/assignments");
  assignments = list;
  return list;
}

async function renderNewAssignmentForm() {
  // The study groups the form can set separate rules for. A failure here only
  // costs the group table, so the form still opens - but it says what went
  // wrong instead of claiming there are no groups.
  let groups = null;
  let groupsError = null;
  try {
    ({ groups } = await api("/api/assignments/groups"));
  } catch (err) {
    groupsError = err.message;
  }
  renderAssignmentForm(null, groups, groupsError);
}

// One form for both creating and editing. `existing` is null when creating,
// otherwise { assignment, files, starterFiles, groupRules, groups } as
// returned by the API; `groups` is passed separately when creating.
function renderAssignmentForm(existing, newGroups, groupsError) {
  const editing = !!existing;
  const assignment = editing ? existing.assignment : null;
  editingAssignmentId = editing ? assignment.id : null;
  removedHandoutIds = [];

  // One row per study group, pre-filled with the exception it already has.
  // A missing list (rather than an empty one) means the server didn't send it:
  // usually a server still running a version older than this page's script.
  const groups = editing ? existing.groups : newGroups;
  const groupsProblem =
    groupsError ||
    (Array.isArray(groups)
      ? null
      : "сервер не вернул список учебных групп — возможно, он всё ещё работает на старой версии (перезапустите его), а браузер уже получил новую страницу");
  const ruleByGroup = new Map(
    ((editing && existing.groupRules) || []).map((rule) => [rule.groupName, rule])
  );

  const main = document.getElementById("main-content");
  main.innerHTML = `
    <div class="card">
      ${editing ? '<button class="secondary" id="cancel-edit-btn">← Назад</button>' : ""}
      <h2 style="${editing ? "margin-top:10px" : ""}">${
        editing ? "Редактирование задания" : "Новое задание"
      }</h2>
      <div class="form-row">
        <label>Название</label>
        <input id="a-title" placeholder="например: Циклы — FizzBuzz" value="${
          editing ? escapeHtml(assignment.title) : ""
        }">
      </div>
      <div class="form-row">
        <label>Тип задания</label>
        <select id="a-type" ${editing ? "" : ""}>
          ${ASSIGNMENT_TYPES.map(
            (t) =>
              `<option value="${t.value}"${
                (editing ? assignment.type : "code") === t.value ? " selected" : ""
              }>${t.label} — ${t.hint}</option>`
          ).join("")}
        </select>
        ${
          editing
            ? '<span class="muted" style="font-size:12px">Тип можно изменить, только пока никто из учеников не начал работу.</span>'
            : ""
        }
      </div>
      <div class="form-row">
        <label>Описание и указания</label>
        <textarea id="a-desc" rows="4" placeholder="Опишите задание…">${
          editing ? escapeHtml(assignment.description || "") : ""
        }</textarea>
      </div>
      ${
        editing
          ? `<div class="form-row">
               <label>Прикреплённые методички</label>
               <div id="existing-handouts"></div>
             </div>`
          : ""
      }
      <div class="form-row">
        <label>${editing ? "Добавить методички" : "Методички (необязательно)"}</label>
        <input type="file" id="a-files" multiple accept="${ALLOWED_UPLOAD_EXTENSIONS.join(",")}">
        <span class="muted" style="font-size:12px">
          PDF, DOCX и подобные документы — до ${MAX_UPLOAD_MB} МБ каждый,
          не больше ${MAX_UPLOAD_FILES} файлов. Ученики смогут скачать их из задания.
        </span>
        <div id="a-files-list"></div>
      </div>
      <div class="form-row">
        <label>Сроки и баллы по группам</label>
        ${renderGroupRuleEditor(groups || [], ruleByGroup, groupsProblem)}
      </div>
      <div class="form-row" id="starter-code-row">
        <label>Стартовый проект</label>
        <span class="muted" style="font-size:12px">
          Файлы, с которыми открывается редактор ученика. Запуск начинается
          с того, который помечен <span class="entry-badge">main</span>.
        </span>
        <div class="editor-layout" style="margin-top:6px">
          <div class="file-tree wide" style="height:260px">
            <div class="file-tree-header">Файлы</div>
            <div id="starter-file-list"></div>
            <div class="file-tree-actions">
              <button class="secondary" id="starter-new-file-btn" type="button">+ Новый файл</button>
              <button class="secondary" id="starter-add-local-btn" type="button"
                      title="Взять файл с этого компьютера и выдать его вместе с заданием">
                + Файл с компьютера
              </button>
            </div>
            <input type="file" id="starter-local-file-input" multiple hidden>
          </div>
          <textarea id="a-starter" style="font-family: var(--font-mono); flex:1; height:260px; resize:vertical"></textarea>
        </div>
      </div>
      <div class="form-row" id="network-row">
        <label class="checkbox-label">
          <input type="checkbox" id="a-network"${
            editing && assignment.network_access ? " checked" : ""
          }>
          Разрешить скачивание файлов по сети
        </label>
        <span class="muted" style="font-size:12px">
          Программа ученика сможет обращаться по HTTP к файлам из раздела
          «Файлы по сети». Ничего другого из песочницы не доступно: ни интернет,
          ни этот сервер. Нужно для заданий на сетевое программирование.
        </span>
        <div id="network-files" class="muted" style="font-size:12px; margin-top:4px"></div>
      </div>
      <div class="form-row" id="starter-text-row" style="display:none">
        <label>Начальный текст (необязательно)</label>
        <span class="muted" style="font-size:12px">
          Текст, с которым откроется поле ответа ученика — заготовка или подсказка.
        </span>
        <textarea id="a-starter-text" rows="6" style="margin-top:6px">${
          editing && assignment.type === "text"
            ? escapeHtml(assignment.starter_code || "")
            : ""
        }</textarea>
      </div>
      <div class="form-row" id="test-row" style="display:none">
        <label>Тест</label>
        <div class="test-settings">
          <label class="inline-label">Вид
            <select id="t-kind">
              <option value="graded">Обычный тест — с правильными ответами и оценкой</option>
              <option value="survey">Тест-опрос — без правильных ответов и без оценки</option>
            </select>
          </label>
          <label class="inline-label">Время на решение, мин
            <input type="number" id="t-limit" min="${MIN_TIME_LIMIT}" max="${MAX_TIME_LIMIT}"
                   step="1" value="${DEFAULT_TIME_LIMIT}">
          </label>
          <label class="inline-label">Доступен с (необязательно)
            <input type="datetime-local" id="t-from">
          </label>
        </div>
        <span class="muted" style="font-size:12px">
          Решать можно только между «доступен с» и дедлайном выше. Пустое «доступен с»
          означает «сразу». Время на решение отсчитывается с того момента, когда ученик
          открыл вопросы; когда оно выходит, ответы отправляются сами.
        </span>
        <div id="t-questions"></div>
        <button class="secondary" id="t-add-question" type="button">+ Добавить вопрос</button>
      </div>

      <div class="form-row" id="freeform-note-row" style="display:none">
        <label>Что сдают ученики</label>
        <span class="muted" style="font-size:12px">
          Ученики прикладывают до ${MAX_STUDENT_FILES} файлов, по ${MAX_STUDENT_MB} МБ каждый.
          Архивы и программы (zip, rar, exe и подобные) не принимаются.
          Готовить здесь ничего не нужно.
        </span>
      </div>
      <button id="create-assignment-btn">${
        editing ? "Сохранить изменения" : "Создать задание"
      }</button>
    </div>
  `;

  const fileInput = document.getElementById("a-files");
  fileInput.onchange = () => renderChosenFiles(fileInput.files);

  // Only one of the three starter sections applies at a time.
  const typeSelect = document.getElementById("a-type");
  const kindSelect = document.getElementById("t-kind");
  const applyTypeToForm = () => {
    const type = typeSelect.value;
    document.getElementById("starter-code-row").style.display =
      type === "code" ? "" : "none";
    document.getElementById("starter-text-row").style.display =
      type === "text" ? "" : "none";
    document.getElementById("freeform-note-row").style.display =
      type === "freeform" ? "" : "none";
    document.getElementById("test-row").style.display = type === "test" ? "" : "none";
    // Only a program can download anything, so the switch belongs to code work.
    document.getElementById("network-row").style.display = type === "code" ? "" : "none";
    // A survey is never scored, so the maximum-mark column means nothing for
    // it - the deadlines in the same table still do, so only the column goes.
    const scored = !(type === "test" && kindSelect.value === "survey");
    document
      .querySelectorAll(".max-score-col")
      .forEach((cell) => (cell.style.display = scored ? "" : "none"));
    if (type === "test") renderTestQuestions();
  };
  // Both re-render the question list, which is rebuilt from testQuestions -
  // so read the form back first or whatever has just been typed is lost.
  // What the sandbox will actually be able to download, so the switch is not
  // a promise about an empty folder.
  (async () => {
    const box = document.getElementById("network-files");
    if (!box) return;
    try {
      const data = await api("/api/mirror");
      box.innerHTML =
        (data.files || []).length === 0
          ? 'Сейчас не раздаётся ни одного файла — добавьте их в разделе «Файлы по сети».'
          : "Доступно: " +
            data.files.map((f) => `<code>${escapeHtml(f.url)}</code>`).join(", ");
    } catch {
      box.textContent = "";
    }
  })();

  typeSelect.onchange = () => {
    syncTestQuestions();
    applyTypeToForm();
  };
  kindSelect.onchange = () => {
    syncTestQuestions();
    applyTypeToForm();
    renderTestQuestions(); // correct-answer controls appear and disappear with the kind
  };
  document.getElementById("t-add-question").onclick = () => addTestQuestion();

  // The test being edited, or a single empty question to start from. A test
  // someone has already started keeps its questions as they are.
  testQuestionsFrozen = editing && (existing.testAttempts || 0) > 0;
  if (editing && assignment.type === "test") {
    document.getElementById("t-kind").value = assignment.test_kind || "graded";
    document.getElementById("t-limit").value =
      assignment.time_limit_minutes || DEFAULT_TIME_LIMIT;
    document.getElementById("t-from").value = assignment.available_from
      ? String(assignment.available_from).replace(" ", "T")
      : "";
    testQuestions = (existing.questions || []).map((q) => ({
      kind: q.kind,
      body: q.body,
      expectedAnswer: q.expectedAnswer || "",
      options: (q.options || []).map((o) => ({ body: o.body, isCorrect: !!o.isCorrect })),
    }));
  } else {
    testQuestions = [];
  }
  if (testQuestions.length === 0) addTestQuestion({ silent: true });
  applyTypeToForm();

  if (editing) {
    document.getElementById("cancel-edit-btn").onclick = () => selectAssignment(assignment);
    existingHandouts = existing.files || [];
    renderExistingHandouts();

    starterFiles = (existing.starterFiles || []).map((f) => ({
      filename: f.filename,
      content: f.content,
      encoding: f.encoding === "base64" ? "base64" : "text",
    }));
    if (starterFiles.length === 0) {
      starterFiles = [{ filename: "Main.java", content: DEFAULT_STARTER }];
    }
    const entryRow = (existing.starterFiles || []).find((f) => f.isEntry);
    starterEntry = entryRow ? entryRow.filename : starterFiles[0].filename;
    starterActive = starterEntry;
  } else {
    // Start every new assignment from a one-file project.
    starterFiles = [{ filename: "Main.java", content: DEFAULT_STARTER }];
    starterEntry = "Main.java";
    starterActive = "Main.java";
  }

  document.getElementById("a-starter").value =
    (starterFiles.find((f) => f.filename === starterActive) || starterFiles[0]).content;
  document.getElementById("a-starter").addEventListener("input", syncStarterTextarea);
  document.getElementById("starter-new-file-btn").onclick = addStarterFile;
  document.getElementById("starter-add-local-btn").onclick = addLocalStarterFile;
  document.getElementById("starter-local-file-input").onchange = onStarterLocalFilesChosen;
  renderStarterTree();

  document.getElementById("create-assignment-btn").onclick = async () => {
    const title = document.getElementById("a-title").value.trim();
    const description = document.getElementById("a-desc").value.trim();
    syncStarterTextarea();
    if (!title) return alert("Укажите название задания");

    const btn = document.getElementById("create-assignment-btn");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = editing ? "Сохранение…" : "Создание…";
    try {
      const files = await readFilesAsBase64(fileInput.files);
      const body = JSON.stringify({
        title,
        description,
        type: typeSelect.value,
        files,
        starterFiles,
        starterEntry,
        starterText: document.getElementById("a-starter-text").value,
        // Deadlines and top marks exist only per study group now.
        groupRules: collectGroupRules(),
        networkAccess: document.getElementById("a-network").checked,
        removeFileIds: removedHandoutIds,
        ...(typeSelect.value === "test"
          ? {
              testKind: document.getElementById("t-kind").value,
              timeLimitMinutes: Number(document.getElementById("t-limit").value),
              availableFrom: document.getElementById("t-from").value,
              // Omitted when frozen: the server then keeps the stored ones.
              ...(testQuestionsFrozen ? {} : { questions: collectTestQuestions() }),
            }
          : {}),
      });

      const result = editing
        ? await api(`/api/assignments/${editingAssignmentId}`, { method: "PUT", body })
        : await api("/api/assignments", { method: "POST", body });

      // Each assignment has a page of its own, so saving lands on it - which
      // also means the browser's Back button goes where the teacher expects.
      window.location.href = `/assignments?id=${result.assignment.id}`;
    } catch (err) {
      alert(
        (editing ? "Не удалось сохранить задание: " : "Не удалось создать задание: ") +
          err.message
      );
      btn.disabled = false;
      btn.textContent = label;
    }
  };
}


// ---------- The question builder in the assignment form ----------
//
// testQuestions is the form's own copy of the test. The DOM is rebuilt from
// it on every change, which keeps "what is on screen" and "what will be sent"
// the same thing.

function currentTestKind() {
  const select = document.getElementById("t-kind");
  return select ? select.value : "graded";
}

function addTestQuestion({ silent = false } = {}) {
  // Read the form back first: everything below is rebuilt from
  // testQuestions, so whatever has been typed since the last render would
  // otherwise be thrown away by the re-render.
  if (!silent) syncTestQuestions();
  testQuestions.push({
    kind: "single",
    body: "",
    expectedAnswer: "",
    options: [
      { body: "", isCorrect: false },
      { body: "", isCorrect: false },
    ],
  });
  if (!silent) renderTestQuestions();
}

// Reads the inputs back into testQuestions. Called before any re-render, so
// typing is never lost when a control is added or removed.
function syncTestQuestions() {
  const box = document.getElementById("t-questions");
  if (!box || testQuestionsFrozen) return;
  box.querySelectorAll(".test-question").forEach((node) => {
    const index = Number(node.dataset.index);
    const question = testQuestions[index];
    if (!question) return;
    question.kind = node.querySelector(".tq-kind").value;
    question.body = node.querySelector(".tq-body").value;
    const expected = node.querySelector(".tq-expected");
    if (expected) question.expectedAnswer = expected.value;
    question.options = Array.from(node.querySelectorAll(".tq-option")).map((row) => ({
      body: row.querySelector(".tq-option-body").value,
      isCorrect: row.querySelector(".tq-correct")
        ? row.querySelector(".tq-correct").checked
        : false,
    }));
  });
}

function collectTestQuestions() {
  syncTestQuestions();
  return testQuestions;
}

// A textarea that is exactly as tall as its content. Called on render and on
// every keystroke; "auto" first so the box can shrink again after a deletion.
function fitToText(area) {
  area.style.height = "auto";
  area.style.height = `${Math.max(area.scrollHeight, 32)}px`;
}

function renderTestQuestions() {
  const box = document.getElementById("t-questions");
  if (!box) return;
  const graded = currentTestKind() === "graded";

  box.innerHTML = "";
  // Changing a question under a student who has already answered it would
  // leave their answer attached to something else entirely, so a test that
  // has been started is shown as it stands.
  const addButton = document.getElementById("t-add-question");
  if (testQuestionsFrozen) {
    if (addButton) addButton.hidden = true;
    box.innerHTML = `
      <div class="form-message error">
        Ученики уже начали проходить тест — вопросы изменить нельзя.
        Сроки, время на решение и максимальный балл поменять можно.
      </div>
      ${testQuestions
        .map(
          (question, index) => `
        <div class="test-question">
          <div class="tq-head">
            <span class="tq-number">${index + 1}</span>
            <span class="muted">${
              (TEST_QUESTION_KINDS.find((k) => k.value === question.kind) || {}).label || ""
            }</span>
          </div>
          <div class="test-question-body">${escapeHtml(question.body)}</div>
          ${
            question.options.length > 0
              ? `<ul class="test-answer-options">${question.options
                  .map(
                    (option) =>
                      `<li class="${option.isCorrect ? "is-correct" : ""}">${escapeHtml(
                        option.body
                      )}</li>`
                  )
                  .join("")}</ul>`
              : question.expectedAnswer
                ? `<div class="muted">Ожидается: ${escapeHtml(question.expectedAnswer)}</div>`
                : ""
          }
        </div>`
        )
        .join("")}`;
    return;
  }
  if (addButton) addButton.hidden = false;

  testQuestions.forEach((question, index) => {
    const node = document.createElement("div");
    node.className = "test-question";
    node.dataset.index = index;

    const options =
      question.kind === "open"
        ? ""
        : `<div class="tq-options">${question.options
            .map(
              (option, optionIndex) => `
          <div class="tq-option">
            ${
              graded
                ? `<input type="${question.kind === "single" ? "radio" : "checkbox"}"
                         class="tq-correct" name="correct-${index}"
                         ${option.isCorrect ? "checked" : ""}
                         title="Правильный ответ">`
                : ""
            }
            <input class="tq-option-body" value="${escapeHtml(option.body)}"
                   placeholder="Вариант ${optionIndex + 1}">
            <button type="button" class="delete-file tq-remove-option"
                    data-option="${optionIndex}" title="Убрать вариант">×</button>
          </div>`
            )
            .join("")}
          <button type="button" class="secondary tq-add-option">+ Вариант</button>
        </div>`;

    // The wording and the kind share the top line, the way a question reads:
    // "this, asked like this". Everything the kind brings with it follows.
    node.innerHTML = `
      <div class="tq-head">
        <span class="tq-number">${index + 1}</span>
        <textarea class="tq-body" rows="1" placeholder="Текст вопроса">${escapeHtml(
          question.body
        )}</textarea>
        <select class="tq-kind">
          ${TEST_QUESTION_KINDS.map(
            (k) =>
              `<option value="${k.value}"${
                question.kind === k.value ? " selected" : ""
              }>${k.label}</option>`
          ).join("")}
        </select>
        <button type="button" class="delete-file tq-remove" title="Удалить вопрос">×</button>
      </div>
      ${options}
      ${
        question.kind === "open" && graded
          ? `<textarea class="tq-expected" rows="1"
                   placeholder="Ожидаемый ответ (необязательно — без него вопрос проверяете вы)">${escapeHtml(
                     question.expectedAnswer
                   )}</textarea>`
          : ""
      }`;

    box.appendChild(node);
  });

  // Both free-text fields start one line tall and grow with what is typed -
  // by wrapping or by a deliberate Enter - instead of carrying a resize grip.
  box.querySelectorAll(".tq-body, .tq-expected").forEach((area) => {
    fitToText(area);
    area.oninput = () => fitToText(area);
  });

  // One handler per control, each syncing first so nothing typed is lost.
  box.querySelectorAll(".tq-kind").forEach((select) => {
    select.onchange = () => {
      syncTestQuestions();
      const question = testQuestions[Number(select.closest(".test-question").dataset.index)];
      // Switching to a choice question needs something to choose between.
      if (question.kind !== "open" && question.options.length < 2) {
        question.options = [
          { body: "", isCorrect: false },
          { body: "", isCorrect: false },
        ];
      }
      renderTestQuestions();
    };
  });
  box.querySelectorAll(".tq-remove").forEach((button) => {
    button.onclick = () => {
      syncTestQuestions();
      testQuestions.splice(Number(button.closest(".test-question").dataset.index), 1);
      if (testQuestions.length === 0) addTestQuestion({ silent: true });
      renderTestQuestions();
    };
  });
  box.querySelectorAll(".tq-add-option").forEach((button) => {
    button.onclick = () => {
      syncTestQuestions();
      testQuestions[Number(button.closest(".test-question").dataset.index)].options.push({
        body: "",
        isCorrect: false,
      });
      renderTestQuestions();
    };
  });
  box.querySelectorAll(".tq-remove-option").forEach((button) => {
    button.onclick = () => {
      syncTestQuestions();
      const question = testQuestions[Number(button.closest(".test-question").dataset.index)];
      if (question.options.length <= 2) {
        alert("В вопросе с выбором должно остаться хотя бы два варианта.");
        return;
      }
      question.options.splice(Number(button.dataset.option), 1);
      renderTestQuestions();
    };
  });
  // A single-choice question has radio buttons, which already clear each
  // other; the checkboxes of a multiple-choice one need nothing.
  box.querySelectorAll(".tq-correct").forEach((input) => {
    input.onchange = () => syncTestQuestions();
  });
}

// Handouts already attached to the assignment being edited, with a way to
// mark them for removal. Nothing is deleted until the form is saved.
function renderExistingHandouts() {
  const box = document.getElementById("existing-handouts");
  if (!box) return;
  if (existingHandouts.length === 0) {
    box.innerHTML = '<p class="muted" style="font-size:12px">Методички не прикреплены.</p>';
    return;
  }
  box.innerHTML = "";
  existingHandouts.forEach((file) => {
    const marked = removedHandoutIds.includes(file.id);
    const div = document.createElement("div");
    div.className = "file-item";
    div.innerHTML = `
      <span class="${marked ? "muted" : ""}" style="${
        marked ? "text-decoration: line-through" : ""
      }">${escapeHtml(file.originalName)}</span>
      <span class="muted">${formatSize(file.size)}</span>`;
    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.type = "button";
    btn.style.padding = "2px 8px";
    btn.style.fontSize = "12px";
    btn.textContent = marked ? "Вернуть" : "Убрать";
    btn.onclick = () => {
      removedHandoutIds = marked
        ? removedHandoutIds.filter((id) => id !== file.id)
        : [...removedHandoutIds, file.id];
      renderExistingHandouts();
    };
    div.appendChild(btn);
    box.appendChild(div);
  });
}

// ---------- Starter project in the new-assignment form ----------

const JAVA_FILENAME = /^[A-Za-z_][A-Za-z0-9_]*\.java$/;
const DEFAULT_STARTER =
  "public class Main {\n    public static void main(String[] args) {\n        \n    }\n}\n";

// Data files in a project, mirrored from projectFiles.js. A starter project
// may hand out the data a program is meant to read - an input.txt next to
// Main.java - and the student's own saved versions may contain data files the
// program wrote, binary ones included.
const DATA_FILENAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const DATA_EXTENSIONS = [
  "txt", "text", "log", "md", "markdown",
  "csv", "tsv", "psv", "tab",
  "dat", "data", "in", "inp", "out", "rec", "asc",
  "json", "xml", "yaml", "yml",
  "ini", "cfg", "conf", "config", "properties", "props", "env",
  "lst", "list",
];
const MAX_DATA_FILE_KB = 256;

function isJavaFile(filename) {
  return /\.java$/i.test(String(filename || ""));
}

function isBinaryFile(file) {
  return !!file && file.encoding === "base64";
}

function isAllowedDataName(filename) {
  if (!DATA_FILENAME.test(filename)) return false;
  const dot = filename.lastIndexOf(".");
  const ext = dot <= 0 ? "" : filename.slice(dot + 1).toLowerCase();
  return ext === "" || DATA_EXTENSIONS.includes(ext);
}

function dataNameMessage(filename) {
  return (
    `"${filename}" нельзя добавить в проект.\n\n` +
    "Имя: буквы, цифры, точка, дефис и подчёркивание, без папок.\n" +
    "Расширение: любой текстовый формат данных — " +
    DATA_EXTENSIONS.join(", ") +
    " — либо файл вообще без расширения."
  );
}

function fileSizeOf(file) {
  if (isBinaryFile(file)) {
    const text = file.content || "";
    const padding = (text.match(/=+$/) || [""])[0].length;
    return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
  }
  return new TextEncoder().encode(file.content || "").length;
}

// Hands a project file to the browser as a download - the only way to look at
// a serialised object a student's program produced.
function downloadProjectFile(file) {
  const bytes = isBinaryFile(file)
    ? Uint8Array.from(atob(file.content || ""), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(file.content || "");
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// A small "data"/"bin" tag plus a download button, shared by the starter tree
// and the review viewer.
function appendDataControls(div, file) {
  const badge = document.createElement("span");
  badge.className = "data-badge" + (isBinaryFile(file) ? " binary" : "");
  badge.textContent = isBinaryFile(file) ? "двоич." : "данные";
  badge.title = `${file.filename} — ${formatSize(fileSizeOf(file))}${
    isBinaryFile(file) ? ", двоичный файл" : ""
  }`;
  div.appendChild(badge);

  const download = document.createElement("button");
  download.className = "download-file";
  download.type = "button";
  download.textContent = "↓";
  download.title = "Скачать файл";
  download.onclick = (e) => {
    e.stopPropagation();
    downloadProjectFile(file);
  };
  div.appendChild(download);
}

// The textarea holds whichever starter file is selected, so its text has to be
// written back before the selection changes or the form is submitted.
function syncStarterTextarea() {
  const box = document.getElementById("a-starter");
  if (!box) return;
  const file = starterFiles.find((f) => f.filename === starterActive);
  if (file) file.content = box.value;
}

function openStarterFile(filename) {
  syncStarterTextarea();
  starterActive = filename;
  const file = starterFiles.find((f) => f.filename === filename);
  document.getElementById("a-starter").value = file ? file.content : "";
  renderStarterTree();
}

function renderStarterTree() {
  const list = document.getElementById("starter-file-list");
  if (!list) return;
  list.innerHTML = "";

  starterFiles.forEach((file) => {
    const div = document.createElement("div");
    div.className = "file-node" + (file.filename === starterActive ? " active" : "");

    const name = document.createElement("span");
    name.className = "file-node-name";
    name.textContent = file.filename;
    name.title = file.filename; // full name stays readable when ellipsized
    name.onclick = () => openStarterFile(file.filename);
    div.appendChild(name);

    if (!isJavaFile(file.filename)) appendDataControls(div, file);

    if (file.filename === starterEntry) {
      const badge = document.createElement("span");
      badge.className = "entry-badge";
      badge.textContent = "main";
      badge.title = "С этого файла начинается запуск у ученика";
      div.appendChild(badge);
    } else {
      // Unlike the student's editor, the entry file here is chosen explicitly -
      // the teacher is authoring the project, not running it. Only a source
      // file can be the entry point.
      if (isJavaFile(file.filename)) {
        const setEntry = document.createElement("button");
        setEntry.className = "set-entry";
        setEntry.type = "button";
        setEntry.textContent = "сделать main";
        setEntry.title = "Сделать файлом, с которого начинается запуск";
        setEntry.onclick = (e) => {
          e.stopPropagation();
          starterEntry = file.filename;
          renderStarterTree();
        };
        div.appendChild(setEntry);
      }

      const del = document.createElement("button");
      del.className = "delete-file";
      del.type = "button";
      del.textContent = "×";
      del.title = "Убрать файл";
      del.onclick = (e) => {
        e.stopPropagation();
        removeStarterFile(file.filename);
      };
      div.appendChild(del);
    }

    list.appendChild(div);
  });
}

function addStarterFile() {
  const raw = prompt(
    "Имя нового файла — Helper.java для кода, input.txt для данных:",
    "Helper.java"
  );
  if (!raw) return;
  const filename = raw.trim();
  if (!filename) return;

  const isJava = isJavaFile(filename);
  if (isJava && !JAVA_FILENAME.test(filename)) {
    alert(
      "Имя файла Java должно начинаться с буквы или подчёркивания, содержать только буквы, цифры и подчёркивания и оканчиваться на .java — например Helper.java"
    );
    return;
  }
  if (!isJava && !isAllowedDataName(filename)) {
    alert(dataNameMessage(filename));
    return;
  }
  if (starterFiles.some((f) => f.filename === filename)) {
    alert(`Файл «${filename}» уже есть в стартовом проекте.`);
    return;
  }

  syncStarterTextarea();
  starterFiles.push({
    filename,
    content: isJava
      ? `public class ${filename.replace(/\.java$/, "")} {\n    \n}\n`
      : "",
    encoding: "text",
  });
  openStarterFile(filename);
}

// "Add local file" in the assignment form: hands out data with the task -
// the input.txt a student's program is supposed to read.
function addLocalStarterFile() {
  const picker = document.getElementById("starter-local-file-input");
  if (picker) picker.click();
}

async function onStarterLocalFilesChosen(event) {
  const chosen = Array.from(event.target.files || []);
  event.target.value = "";
  if (chosen.length === 0) return;

  syncStarterTextarea();
  let lastAdded = null;

  for (const file of chosen) {
    const filename = file.name;
    if (isJavaFile(filename)) {
      if (!JAVA_FILENAME.test(filename)) {
        alert(`«${filename}» — недопустимое имя для файла Java.`);
        continue;
      }
    } else if (!isAllowedDataName(filename)) {
      alert(dataNameMessage(filename));
      continue;
    }
    if (file.size > MAX_DATA_FILE_KB * 1024) {
      alert(
        `"${filename}" — ${formatSize(file.size)}, это больше ${MAX_DATA_FILE_KB} КБ.`
      );
      continue;
    }

    let text;
    try {
      text = await file.text();
    } catch (err) {
      alert(`Не удалось прочитать "${filename}": ${err.message}`);
      continue;
    }
    if (text.includes("�")) {
      alert(
        `"${filename}" не является текстовым файлом. В стартовый проект можно ` +
          "положить только текстовые данные."
      );
      continue;
    }

    const existing = starterFiles.find((f) => f.filename === filename);
    if (existing) {
      if (!confirm(`"${filename}" уже есть в стартовом проекте. Заменить?`)) continue;
      existing.content = text;
      existing.encoding = "text";
    } else {
      starterFiles.push({ filename, content: text, encoding: "text" });
    }
    lastAdded = filename;
  }

  if (lastAdded) openStarterFile(lastAdded);
  else renderStarterTree();
}

function removeStarterFile(filename) {
  if (starterFiles.length <= 1) return;
  if (filename === starterEntry) return; // the entry file can't be removed
  starterFiles = starterFiles.filter((f) => f.filename !== filename);
  if (starterActive === filename) {
    openStarterFile(starterEntry);
  } else {
    renderStarterTree();
  }
}

function renderChosenFiles(fileList) {
  const box = document.getElementById("a-files-list");
  if (!box) return;
  const files = Array.from(fileList || []);
  if (files.length === 0) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = files
    .map(
      (f) =>
        `<div class="file-item"><span class="file-name">${escapeHtml(f.name)}</span>
         <span class="muted">${formatSize(f.size)}</span></div>`
    )
    .join("");
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Reads the picked files into base64 so they can travel inside the JSON body.
// Validation is repeated on the server - this only gives faster feedback.
function readFilesAsBase64(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return Promise.resolve([]);
  if (files.length > MAX_UPLOAD_FILES) {
    return Promise.reject(new Error(`At most ${MAX_UPLOAD_FILES} files can be attached`));
  }
  const tooBig = files.find((f) => f.size > MAX_UPLOAD_MB * 1024 * 1024);
  if (tooBig) {
    return Promise.reject(
      new Error(`"${tooBig.name}" is larger than ${MAX_UPLOAD_MB} MB`)
    );
  }

  return Promise.all(
    files.map(
      (file) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve({ name: file.name, data: reader.result });
          reader.onerror = () => reject(new Error(`Не удалось прочитать «${file.name}»`));
          reader.readAsDataURL(file);
        })
    )
  );
}

// Renders the download list shown on an existing assignment.
function renderFileLinks(assignmentId, files) {
  if (!files || files.length === 0) return "";
  const items = files
    .map(
      (f) =>
        `<div class="file-item">
           <a href="/api/assignments/${assignmentId}/files/${f.id}/download">${escapeHtml(f.originalName)}</a>
           <span class="muted">${formatSize(f.size)}</span>
         </div>`
    )
    .join("");
  return `<div class="file-list"><h4>Методички</h4>${items}</div>`;
}

async function selectAssignment(assignment) {
  activeAssignment = assignment;
  activeStudent = null;
  activeProfile = null;
  activeNotification = null;
  await renderOverview();
}

async function renderOverview() {
  // `roster` rather than `students` so it doesn't shadow the sidebar list.
  const [{ students: roster, groupRules }, { files }] = await Promise.all([
    api(`/api/assignments/${activeAssignment.id}/overview`),
    api(`/api/assignments/${activeAssignment.id}/files`),
  ]);
  const main = document.getElementById("main-content");
  main.innerHTML = `
    <div class="card">
      <h2>${escapeHtml(activeAssignment.title)} ${typeBadge(activeAssignment.type)}</h2>
      <p class="muted assignment-description">${escapeHtml(activeAssignment.description || "")}</p>
      ${renderGroupRuleSummary(groupRules)}
      ${renderFileLinks(activeAssignment.id, files)}
      <div class="toolbar">
        <button class="secondary" id="edit-assignment-btn">Редактировать</button>
        <button class="secondary danger" id="delete-assignment-btn">Удалить задание</button>
      </div>
    </div>
    <div class="card">
      <h3>Работы учеников</h3>
      <table>
        <thead>
          <tr><th>Ученик</th><th>Группа</th><th>${
            activeAssignment.type === "test"
              ? "Результат"
              : activeAssignment.type === "freeform"
                ? "Файлы"
                : "Последняя версия"
          }</th><th>Статус</th><th>Активность</th><th>Оценка</th></tr>
        </thead>
        <tbody id="student-rows"></tbody>
      </table>
    </div>
  `;
  document.getElementById("edit-assignment-btn").onclick = editActiveAssignment;
  document.getElementById("delete-assignment-btn").onclick = deleteActiveAssignment;

  const tbody = document.getElementById("student-rows");
  if (roster.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">Учеников пока нет — добавьте их на панели слева.</td></tr>';
    return;
  }
  const isFreeform = activeAssignment.type === "freeform";
  const isTest = activeAssignment.type === "test";

  // Work that is waiting to be looked at comes first: handed in, then started
  // but not handed in, then untouched - each block alphabetical by surname.
  const handInRank = (s) => {
    if (isFreeform) return s.fileCount > 0 ? 0 : 2;
    if (isTest) {
      const state = s.test ? s.test.state : "not-started";
      return state === "submitted" ? 0 : state === "in-progress" ? 1 : 2;
    }
    if (s.status === "submitted") return 0;
    return s.status ? 1 : 2;
  };
  roster.sort((a, b) => handInRank(a) - handInRank(b) || byStudentName(a, b));

  roster.forEach((s) => {
    // Free-form work has no versions - what a student has is a set of files.
    const testState = s.test ? s.test.state : null;
    const handedIn = isFreeform
      ? s.fileCount > 0
      : isTest
        ? testState === "submitted"
        : !!s.status;
    const activity = isFreeform ? s.lastUpload : s.lastActivity;
    // A test's timestamps come from the database in UTC.
    const activityText = activity
      ? new Date(
          isTest ? `${String(activity).replace(" ", "T")}Z` : activity
        ).toLocaleString()
      : "—";
    const tr = document.createElement("tr");
    tr.className = "student-row";
    tr.innerHTML = `
      <td>${escapeHtml(studentName(s))}${s.isActive ? deadlineMark(s) : ""}</td>
      <td class="muted">${escapeHtml(s.groupName || "—")}</td>
      <td>${
        isFreeform
          ? s.fileCount
            ? `${s.fileCount} file${s.fileCount > 1 ? "s" : ""}`
            : "—"
          : isTest
            ? testSummaryCell(s)
            : s.latestVersion
              ? "v" + s.latestVersion
              : "—"
      }</td>
      <td>${
        // A student whose study group was not given this assignment has not
        // failed to start it - it was never theirs to do.
        !s.isActive
          ? '<span class="muted">не требует выполнения</span>'
          : isTest
            ? testState === "submitted"
              ? '<span class="badge submitted">сдан</span>'
              : testState === "in-progress"
                ? '<span class="badge draft">выполняется</span>'
                : '<span class="badge">не начат</span>'
            : handedIn
              ? `<span class="badge ${isFreeform ? "submitted" : s.status}">${
                  isFreeform ? "приложено" : versionStatusLabel(s.status)
                }</span>`
              : '<span class="badge">не начато</span>'
      }</td>
      <td class="muted">${activityText}</td>
      <td>${
        s.score !== null && s.score !== undefined
          ? `${s.score}${s.maxScore ? ` / ${s.maxScore}` : ""}`
          : "—"
      }</td>
    `;
    tr.onclick = () => {
      window.location.href = workPagePath(s.studentId, activeAssignment.id, "assignment");
    };
    tbody.appendChild(tr);
  });
}

// How a test came out, for the overview table: right answers out of the
// total on a graded test, how much was answered on a survey.
function testSummaryCell(row) {
  const test = row.test;
  if (!test || !test.summary || test.state === "not-started") return "—";
  const summary = test.summary;
  if (activeAssignment.test_kind === "survey") {
    return `${summary.answered} / ${summary.total}`;
  }
  const manual = summary.manual > 0 ? ` <span class="muted">+${summary.manual}?</span>` : "";
  return `${summary.correct} / ${summary.total}${manual}`;
}

// ---------- Per-group deadlines and maximum scores ----------

// The table inside the assignment form. The first row holds the assignment's
// own deadline and maximum score; every study group gets a row below it, and
// an empty field there means the group follows the default, so clearing both
// fields removes the exception on save.
function renderGroupRuleEditor(groups, ruleByGroup, problem) {
  // Told apart on purpose: "the class has no groups" is a normal state, while
  // "the list could not be read" is a fault worth naming.
  const note = problem
    ? `<div class="form-message error">
         Не удалось загрузить учебные группы: ${escapeHtml(problem)}.
       </div>`
    : groups.length === 0
      ? `<div class="form-message error">
           Учебных групп пока нет, а сроки и баллы задаются только по группам —
           выдать это задание будет некому. Добавьте ученикам учебные группы.
         </div>`
      : `<span class="muted" style="font-size:12px">
           Если у группы не заданы ни дедлайн, ни балл, задание ей не выдаётся:
           ученики увидят его в списке с пометкой «не требует выполнения».
         </span>`;

  const rows = groups
    .map((groupName) => {
      const rule = ruleByGroup.get(groupName) || {};
      const deadline = rule.deadline
        ? escapeHtml(String(rule.deadline).replace(" ", "T"))
        : "";
      const maxScore =
        rule.maxScore === null || rule.maxScore === undefined ? "" : rule.maxScore;
      return `<tr data-group="${escapeHtml(groupName)}">
          <td>${escapeHtml(groupName)}</td>
          <td><input type="datetime-local" class="group-deadline" value="${deadline}"></td>
          <td class="max-score-col"><input type="number" class="group-max-score" step="1"
                     min="${MIN_MAX_SCORE}" max="${MAX_MAX_SCORE}"
                     placeholder="—" value="${maxScore}"></td>
        </tr>`;
    })
    .join("");

  return `${note}
      <table class="group-rules">
        <thead><tr><th>Учебная группа</th><th>Дедлайн</th><th class="max-score-col">Макс. балл</th></tr></thead>
        <tbody id="group-rules-body">${rows}</tbody>
      </table>`;
}

// What the group table is currently showing, in the shape the API expects.
// Rows that override nothing are dropped by the server.
function collectGroupRules() {
  return Array.from(document.querySelectorAll("#group-rules-body tr")).map((tr) => ({
    groupName: tr.dataset.group,
    deadline: tr.querySelector(".group-deadline").value,
    maxScore: tr.querySelector(".group-max-score").value,
  }));
}

// Who the assignment has been given to, and on what terms. This is the whole
// story now: a group that is not listed here does not have to do it.
function renderGroupRuleSummary(groupRules) {
  if (!Array.isArray(groupRules) || groupRules.length === 0) {
    return `<p class="muted">Задание не выдано ни одной учебной группе —
        ученики видят его с пометкой «не требует выполнения».</p>`;
  }
  const lines = groupRules
    .map((rule) => {
      const deadline = rule.deadline
        ? `срок ${escapeHtml(formatDeadline(rule.deadline))}`
        : "без срока";
      const max =
        rule.maxScore !== null && rule.maxScore !== undefined
          ? `макс. балл ${rule.maxScore}`
          : "балл не задан";
      return `<li><strong>${escapeHtml(rule.groupName)}</strong> — ${deadline}, ${max}</li>`;
    })
    .join("");
  return `<div class="group-rules-summary">
      <span class="muted">Выдано группам:</span>
      <ul>${lines}</ul>
    </div>`;
}

async function editActiveAssignment() {
  try {
    // Fetch the full record: the sidebar list doesn't carry starter files.
    const existing = await api(`/api/assignments/${activeAssignment.id}`);
    renderAssignmentForm(existing);
  } catch (err) {
    alert("Не удалось открыть задание для редактирования: " + err.message);
  }
}

async function deleteActiveAssignment() {
  const assignment = activeAssignment;
  let impact;
  try {
    impact = await api(`/api/assignments/${assignment.id}/impact`);
  } catch (err) {
    return alert("Не удалось проверить, что будет удалено: " + err.message);
  }

  // Spell out what goes with it - this cannot be undone from the UI.
  const lines = [
    `Удалить задание «${assignment.title}»?`,
    "",
    "Вместе с ним у всех учеников удалятся:",
    `  • сохранённых версий: ${impact.submissions} (учеников: ${impact.students})`,
    `  • оценок: ${impact.grades}`,
    `  • сообщений в обсуждениях: ${impact.messages}`,
    ...(impact.testAttempts
      ? [`  • пройденных тестов: ${impact.testAttempts} (вопросы и ответы)`]
      : []),
    "  • стартовый проект и все методички",
    "",
    "Отменить это будет нельзя.",
  ];
  if (!confirm(lines.join("\n"))) return;

  try {
    await api(`/api/assignments/${assignment.id}`, { method: "DELETE" });
    activeAssignment = null;
    activeStudent = null;
    window.location.href = "/assignments";
  } catch (err) {
    alert("Не удалось удалить задание: " + err.message);
  }
}

// ---------- Student review ----------

// maxScore is the one that applies to this student (their group's, or the
// assignment's); it is what the grade box counts up to.
async function selectStudent(studentId, displayName, maxScore) {
  activeStudent = { studentId, displayName, maxScore };
  activeVersion = null;
  renderStudentPanel();
  await Promise.all([
    activeAssignment.type === "freeform"
      ? loadStudentUploads()
      : activeAssignment.type === "test"
        ? loadTestAttempt()
        : loadVersions(),
    loadDiscussion(),
    // A survey is never scored, so there is no grade box to fill.
    isSurvey() ? Promise.resolve() : loadGrade(),
  ]);
}

function renderStudentPanel() {
  const main = document.getElementById("main-content");
  // On the pair's own page the heading already carries a way back, so the
  // panel does not add a second one.
  const standalone = typeof backFromWorkPage === "function";

  main.innerHTML = `
    ${
      standalone
        ? ""
        : '<button class="secondary" id="back-to-overview">← Ко всем ученикам</button>'
    }
    <div class="card" style="margin-top:10px">
      <h2>${escapeHtml(activeStudent.displayName)} — ${escapeHtml(activeAssignment.title)}</h2>
    </div>

    ${
      activeAssignment.type === "test"
        ? `<div class="card">
             <h3>${isSurvey() ? "Ответы опроса" : "Результат теста"}</h3>
             <div id="test-review"><p class="muted">Загрузка…</p></div>
           </div>`
        : activeAssignment.type === "freeform"
        ? `<div class="card">
             <h3>Приложенные файлы</h3>
             <div id="student-uploads"><p class="muted">Загрузка…</p></div>
           </div>`
        : `<div class="card">
             <h3>История версий</h3>
             <div class="version-list" id="version-list"><p class="muted">Загрузка…</p></div>
           </div>

           <div class="card">
             <h3>${activeAssignment.type === "text" ? "Ответ" : "Код"}</h3>
             ${
               activeAssignment.type === "text"
                 ? '<div class="text-view" id="text-view">Выберите версию, чтобы прочитать ответ.</div>'
                 : `<div class="editor-layout" id="editor-layout">
                      <div class="file-tree">
                        <div class="file-tree-header">Проект</div>
                        <div id="file-list"><p class="muted" style="font-size:12px">—</p></div>
                      </div>
                      <div class="editor-wrap" id="editor-container"></div>
                      <div class="binary-note" id="binary-note" hidden></div>
                    </div>
                    <div id="stdin-used"></div>
                    <div class="output-panel" id="output-panel">Выберите версию, чтобы увидеть вывод программы.</div>`
             }
           </div>`
    }

    <div class="card"${isSurvey() ? ' hidden' : ""}>
      <h3>Оценка</h3>
      ${
        currentMaxScore() === null
          ? `<p class="muted">Для учебной группы этого ученика максимальный балл
               за задание не задан, поэтому оценку поставить нельзя. Задайте балл
               в самом задании, в таблице «Сроки и баллы по группам».</p>`
          : `<div class="grade-box">
               <label class="muted">Балл (0–${currentMaxScore()}):</label>
               <!-- No min/max on purpose: they would stop the stepper dead at
                    the bounds, and we want it to wrap around instead. The range
                    is enforced in wrapScore(), in saveGrade() and on the
                    server. -->
               <input type="number" id="grade-score" step="1" value="${currentMaxScore()}">
               <button id="save-grade-btn">Сохранить оценку</button>
             </div>`
      }
    </div>

    <div class="card">
      <h3>Обсуждение</h3>
      <div class="discussion" id="discussion-list"></div>
      <div class="toolbar">
        <input id="message-input" placeholder="Напишите отзыв или вопрос…" style="flex:1">
        <button id="send-message-btn">Отправить</button>
      </div>
    </div>
  `;
  const back = document.getElementById("back-to-overview");
  if (back) {
    back.onclick = () => {
      activeStudent = null;
      renderOverview();
    };
  }
  const saveGradeBtn = document.getElementById("save-grade-btn");
  if (saveGradeBtn) saveGradeBtn.onclick = saveGrade;
  // Covers the stepper arrows, the up/down keys and the scroll wheel - all of
  // them fire "input" after the value changes.
  const scoreField = document.getElementById("grade-score");
  if (scoreField) {
    scoreField.addEventListener("input", (e) => wrapScore(e.target));
  }
  document.getElementById("send-message-btn").onclick = sendMessage;
  document.getElementById("message-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendMessage();
  });
  // Only code assignments need the Monaco viewer.
  if (activeAssignment.type === "code") setupViewer();
}

// Free-form work: the student's attachments, downloadable but not editable.
async function loadStudentUploads() {
  const box = document.getElementById("student-uploads");
  if (!box) return;
  try {
    const { files } = await api(
      `/api/uploads/assignment/${activeAssignment.id}?studentId=${activeStudent.studentId}`
    );
    if (files.length === 0) {
      box.innerHTML = '<p class="muted">Ученик пока ничего не приложил.</p>';
      return;
    }
    box.innerHTML = files
      .map(
        (f) => `<div class="file-item">
            <a href="/api/uploads/${f.id}/download">${escapeHtml(f.originalName)}</a>
            <span class="muted">${formatSize(f.size)} · ${new Date(
              f.createdAt
            ).toLocaleString()}</span>
          </div>`
      )
      .join("");
  } catch (err) {
    box.innerHTML = `<p class="muted">Не удалось загрузить файлы: ${escapeHtml(err.message)}</p>`;
  }
}

async function setupViewer() {
  await editorReady;
  const container = document.getElementById("editor-container");
  viewerEditor = monaco.editor.create(container, {
    value: "// Select a version from the list above",
    language: "java",
    theme: "vs-dark",
    automaticLayout: true,
    fontSize: 14,
    minimap: { enabled: false },
    readOnly: true,
  });
  // Same drag-to-resize grip the student has, so long files can be read
  // without scrolling a short window.
  makeEditorResizable(document.getElementById("editor-layout"));
}

async function loadVersions() {
  const { submissions } = await api(
    `/api/submissions/assignment/${activeAssignment.id}?studentId=${activeStudent.studentId}`
  );
  versions = submissions;
  const list = document.getElementById("version-list");
  if (!list) return;
  if (versions.length === 0) {
    list.innerHTML = '<p class="muted">Ученик пока ничего не сохранял.</p>';
    return;
  }
  list.innerHTML = "";
  versions.forEach((v, idx) => {
    const div = document.createElement("div");
    div.className = "version-item" + (activeVersion && activeVersion.id === v.id ? " active" : "");
    // The student may have named the version; show that name next to its number.
    const name = v.title ? ` «${v.title}»` : "";
    div.textContent = `v${v.version_number}${name} — ${versionStatusLabel(
      v.status
    )} — ${new Date(v.created_at).toLocaleString()}`;
    div.onclick = () => openVersion(v);
    list.appendChild(div);
    if (idx === 0 && !activeVersion) div.click(); // auto-select latest
  });
}

// Opens a version: loads its files into the read-only tree and shows the
// entry file first.
async function openVersion(v) {
  // A text answer is just read - no editor, no file tree.
  if (activeAssignment.type === "text") {
    activeVersion = v;
    const box = document.getElementById("text-view");
    if (box) box.textContent = v.code || "(empty)";
    loadVersions();
    return;
  }

  await editorReady;
  activeVersion = v;
  try {
    const { files } = await api(`/api/submissions/${v.id}/files`);
    viewerFiles = files.length
      ? files
      : [{ filename: "Main.java", content: v.code, isEntry: 1 }];
  } catch {
    viewerFiles = [{ filename: "Main.java", content: v.code, isEntry: 1 }];
  }
  const entry = viewerFiles.find((f) => f.isEntry) || viewerFiles[0];
  showFile(entry.filename);
  renderStdinUsed(v.stdin);
  renderOutput(v.last_run_stdout, v.last_run_stderr, v.last_run_status);
  loadVersions();
}

function showFile(filename) {
  const file = viewerFiles.find((f) => f.filename === filename) || viewerFiles[0];
  if (!file) return;
  viewerFile = file.filename;

  // A data file the student's program produced may be binary (a serialised
  // object), and there is nothing to read in it - offer the download instead.
  const wrap = document.getElementById("editor-container");
  const note = document.getElementById("binary-note");
  if (wrap && note) {
    if (isBinaryFile(file)) {
      wrap.hidden = true;
      note.hidden = false;
      note.innerHTML = `<strong>${escapeHtml(file.filename)}</strong> — двоичный файл,
        ${formatSize(fileSizeOf(file))}. Показать как текст нечего;
        скачайте его кнопкой «↓» в дереве проекта.`;
    } else {
      note.hidden = true;
      wrap.hidden = false;
      viewerEditor.setValue(file.content);
      const model = viewerEditor.getModel();
      if (model) {
        monaco.editor.setModelLanguage(
          model,
          isJavaFile(file.filename) ? "java" : "plaintext"
        );
      }
    }
  }
  renderViewerTree();
}

function renderViewerTree() {
  const list = document.getElementById("file-list");
  if (!list) return;
  list.innerHTML = "";
  viewerFiles.forEach((file) => {
    const div = document.createElement("div");
    div.className = "file-node" + (file.filename === viewerFile ? " active" : "");
    const name = document.createElement("span");
    name.className = "file-node-name";
    name.textContent = file.filename;
    name.title = file.filename; // full name stays readable when ellipsized
    div.appendChild(name);
    if (!isJavaFile(file.filename)) appendDataControls(div, file);
    // Shows which file the student ran, so the reviewer starts in the right place.
    if (file.isEntry) {
      const badge = document.createElement("span");
      badge.className = "entry-badge";
      badge.textContent = "main";
      badge.title = "С этого файла ученик запускал программу";
      div.appendChild(badge);
    }
    div.onclick = () => showFile(file.filename);
    list.appendChild(div);
  });
}

// Shows the console input the student ran this version against, so output
// that depends on Scanner input can be read in context.
function renderStdinUsed(stdin) {
  const box = document.getElementById("stdin-used");
  if (!box) return;
  if (!stdin || stdin.trim() === "") {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `<div class="stdin-used">
      <div class="stdin-used-title">Ввод программы</div>
      <pre>${escapeHtml(stdin)}</pre>
    </div>`;
}

function renderOutput(stdout, stderr, status) {
  const panel = document.getElementById("output-panel");
  if (!panel) return;
  const hasError = stderr && stderr.trim().length > 0;
  panel.className = "output-panel" + (hasError ? " error" : "");
  panel.innerHTML = "";
  const statusLine = document.createElement("div");
  statusLine.className = "status-line";
  statusLine.textContent = `Статус: ${runStatusLabel(status)}`;
  panel.appendChild(statusLine);
  const pre = document.createElement("div");
  pre.textContent = (stdout || "") + (stderr ? "\n" + stderr : "") || "(no output)";
  panel.appendChild(pre);
}


// ---------- Reviewing a test ----------
//
// A test has no versions and no code: what the teacher needs is how it came
// out, then the answers themselves. The tally comes first, because that is
// what the mark is usually based on - the mark itself is still theirs to
// choose, out of the maximum they set for the assignment.

function renderTestSummary(summary, testKind) {
  if (testKind === "survey") {
    return `<p class="muted">Опрос: правильных ответов нет, оценка не выставляется.
      Отвечено ${summary.answered} из ${summary.total}.</p>`;
  }
  const line = (label, count, percent, cls) => `
    <div class="test-stat ${cls}">
      <span class="test-stat-value">${count} из ${summary.total}</span>
      <span class="test-stat-percent">${percent}%</span>
      <span class="test-stat-label">${label}</span>
    </div>`;
  return `
    <div class="test-stats">
      ${line("правильных ответов", summary.correct, summary.percentCorrect, "correct")}
      ${line("неправильных ответов", summary.incorrect, summary.percentIncorrect, "incorrect")}
      ${line("требуют ручной проверки", summary.manual, summary.percentManual, "manual")}
    </div>`;
}

const VERDICT_LABEL = {
  correct: "верно",
  incorrect: "неверно",
  manual: "проверьте сами",
  none: "ответ",
};

function renderTestAnswer(question, index) {
  const given = question.given;
  let answerHtml;
  if (question.kind === "open") {
    answerHtml = given.textAnswer.trim()
      ? `<div class="test-answer-text">${escapeHtml(given.textAnswer)}</div>`
      : '<div class="test-answer-text muted">нет ответа</div>';
  } else {
    answerHtml = `<ul class="test-answer-options">${question.options
      .map((option) => {
        const chosen = given.optionIds.includes(option.id);
        const marks = [];
        if (chosen) marks.push("выбрано");
        if (option.isCorrect) marks.push("правильный");
        return `<li class="${chosen ? "chosen" : ""}${option.isCorrect ? " is-correct" : ""}">
            ${escapeHtml(option.body)}${
              marks.length ? ` <span class="muted">(${marks.join(", ")})</span>` : ""
            }</li>`;
      })
      .join("")}</ul>`;
  }

  const expected =
    question.kind === "open" && (question.expectedAnswer || "").trim()
      ? `<div class="muted" style="font-size:12px">Ожидался: ${escapeHtml(
          question.expectedAnswer
        )}</div>`
      : "";

  return `
    <div class="test-review-question verdict-${question.verdict}">
      <div class="test-review-head">
        <span class="tq-number">${index + 1}</span>
        <span class="test-verdict ${question.verdict}">${VERDICT_LABEL[question.verdict]}</span>
      </div>
      <div class="test-review-body">${escapeHtml(question.body)}</div>
      ${answerHtml}
      ${expected}
    </div>`;
}

async function loadTestAttempt() {
  const box = document.getElementById("test-review");
  if (!box) return;
  let data;
  try {
    data = await api(
      `/api/tests/assignment/${activeAssignment.id}/attempt?studentId=${activeStudent.studentId}`
    );
  } catch (err) {
    box.innerHTML = `<p class="muted">Не удалось загрузить тест: ${escapeHtml(
      err.message
    )}</p>`;
    return;
  }

  if (data.state === "not-started") {
    box.innerHTML = '<p class="muted">Ученик ещё не открывал тест.</p>';
    return;
  }

  const when = (value) =>
    value ? new Date(`${String(value).replace(" ", "T")}Z`).toLocaleString() : "—";

  box.innerHTML = `
    <p class="muted">
      Начат: ${when(data.startedAt)} ·
      ${
        data.state === "submitted"
          ? `сдан: ${when(data.submittedAt)}`
          : `выполняется, ${data.timeLimitMinutes} мин на решение`
      }
    </p>
    ${renderTestSummary(data.summary, data.testKind)}
    <div class="test-review-list">
      ${data.questions.map(renderTestAnswer).join("")}
    </div>`;
}

// ---------- Grading ----------

// Makes the score wrap around instead of stopping at the ends: stepping up
// from the maximum gives 0, stepping down from 0 gives the maximum. Anything
// further out of range (typed by hand) is clamped rather than wrapped, so
// typing "99" doesn't silently become something else.
function wrapScore(input) {
  const raw = input.value.trim();
  if (raw === "") return; // empty means "no grade" - leave it alone
  const value = Number(raw);
  if (!Number.isInteger(value)) return;

  const max = currentMaxScore();
  if (max === null) return;
  if (value > max) {
    input.value = value === max + 1 ? MIN_SCORE : max;
  } else if (value < MIN_SCORE) {
    input.value = value === MIN_SCORE - 1 ? max : MIN_SCORE;
  }
}

async function loadGrade() {
  const { grade } = await api(
    `/api/grades/assignment/${activeAssignment.id}?studentId=${activeStudent.studentId}`
  );
  const scoreInput = document.getElementById("grade-score");
  if (!scoreInput) return;
  // Ungraded work starts at the top of the scale; an existing grade wins.
  scoreInput.value =
    grade && grade.score !== null && grade.score !== undefined
      ? grade.score
      : (currentMaxScore() ?? "");
}

async function saveGrade() {
  const input = document.getElementById("grade-score");
  if (!input) return;
  const raw = input.value.trim();
  let score = null;
  if (raw !== "") {
    score = Number(raw);
    const max = currentMaxScore();
    if (max === null) {
      alert("Для учебной группы этого ученика максимальный балл не задан.");
      return;
    }
    if (!Number.isInteger(score) || score < MIN_SCORE || score > max) {
      alert(`Балл должен быть целым числом от ${MIN_SCORE} до ${max}.`);
      return;
    }
  }
  try {
    await api(`/api/grades/assignment/${activeAssignment.id}`, {
      method: "PUT",
      body: JSON.stringify({
        studentId: activeStudent.studentId,
        score,
      }),
    });
    // Grading is what clears a badge, so whatever list the page shows has to
    // be redrawn.
    await loadPendingReview();
    await onDataChanged();
    alert("Оценка сохранена");
  } catch (err) {
    alert("Не удалось сохранить оценку: " + err.message);
  }
}

// ---------- Discussion ----------

async function loadDiscussion() {
  const { messages } = await api(
    `/api/discussions/assignment/${activeAssignment.id}?studentId=${activeStudent.studentId}`
  );
  const list = document.getElementById("discussion-list");
  if (!list) return;
  list.innerHTML = "";
  if (messages.length === 0) {
    list.innerHTML = '<p class="muted">Сообщений пока нет.</p>';
    return;
  }
  messages.forEach((m) => {
    const div = document.createElement("div");
    div.className = "message " + (m.authorRole === "teacher" ? "teacher" : "student");
    let linked = "";
    if (m.linkedVersion) {
      linked = `<span class="linked-version" data-submission="${m.submission_id}">→ referring to v${m.linkedVersion}</span>`;
    }
    // A teacher may delete any message in the thread - their own and the student's.
    div.innerHTML = `<div class="meta">${escapeHtml(m.authorName)} · ${new Date(m.created_at).toLocaleString()}
        <button class="delete-message" data-message="${m.id}" title="Удалить сообщение">×</button>
      </div>
      <div class="body">${escapeHtml(m.body)}</div>${linked}`;
    list.appendChild(div);
  });
  list.scrollTop = list.scrollHeight;

  list.querySelectorAll(".delete-message").forEach((el) => {
    el.onclick = () => deleteMessage(parseInt(el.dataset.message, 10));
  });

  list.querySelectorAll(".linked-version").forEach((el) => {
    el.onclick = async () => {
      const subId = parseInt(el.dataset.submission, 10);
      const v = versions.find((x) => x.id === subId);
      if (v) await openVersion(v);
    };
  });
}

async function deleteMessage(messageId) {
  if (!confirm("Удалить сообщение? Это действие нельзя отменить.")) return;
  try {
    await api(`/api/discussions/messages/${messageId}`, { method: "DELETE" });
    await loadDiscussion();
  } catch (err) {
    alert("Не удалось удалить сообщение: " + err.message);
  }
}

async function sendMessage() {
  const input = document.getElementById("message-input");
  const body = input.value.trim();
  if (!body) return;
  try {
    await api(`/api/discussions/assignment/${activeAssignment.id}/messages?studentId=${activeStudent.studentId}`, {
      method: "POST",
      body: JSON.stringify({ body, submissionId: activeVersion ? activeVersion.id : null }),
    });
    input.value = "";
    await loadDiscussion();
  } catch (err) {
    alert("Не удалось отправить сообщение: " + err.message);
  }
}

// ---------- Deadlines ----------

function formatDeadline(deadline) {
  const date = new Date(String(deadline).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? deadline : date.toLocaleString();
}

// Wording for how much time is left (or how long it's been overdue).
function deadlineHint(row) {
  const hours = row.hoursLeft;
  if (hours === null || hours === undefined) return "";
  if (row.deadlineState === "overdue") {
    const late = Math.abs(hours);
    return late < 48
      ? `просрочено на ${late} ч`
      : `просрочено на ${Math.round(late / 24)} дн`;
  }
  return hours < 24 ? `осталось ${hours} ч` : `осталось ${Math.round(hours / 24)} дн`;
}

function deadlineMark(row) {
  if (!row.deadlineState) return "";
  const cls = row.deadlineState === "overdue" ? "deadline-flag overdue" : "deadline-flag";
  const label = row.deadlineState === "overdue" ? "просрочено" : "скоро срок";
  return ` <span class="${cls}" title="${escapeHtml(deadlineHint(row))}">${label}</span>`;
}

// A summary banner above the table, so an at-risk student is obvious without
// reading every row.
function renderDeadlineWarnings(rows) {
  const box = document.getElementById("deadline-warnings");
  if (!box) return;
  const flagged = rows.filter((r) => r.deadlineState);
  if (flagged.length === 0) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `
    <div class="warning-banner">
      <strong>Ещё не сдано:</strong>
      <ul>
        ${flagged
          .map(
            (r) =>
              `<li>${escapeHtml(r.title)} — ${escapeHtml(formatDeadline(r.deadline))} (${escapeHtml(deadlineHint(r))})</li>`
          )
          .join("")}
      </ul>
    </div>`;
}

// ---------- Student profile (all assignments for one student) ----------

async function selectStudentProfile(studentId) {
  activeAssignment = null;
  activeStudent = null;
  activeProfile = { id: studentId };
  activeNotification = null;
  // The assignment list is what the profile's rows are matched against below.
  await loadAssignments();
  await onDataChanged();

  const { student, assignments: rows } = await api(`/api/auth/users/${studentId}`);
  activeProfile = student;

  const main = document.getElementById("main-content");
  main.innerHTML = `
    <div class="card">
      <h2>${escapeHtml(studentName(student))}</h2>
      <table class="profile-table">
        <tr><td class="muted">Логин</td><td>${escapeHtml(student.username)}</td></tr>
        <tr><td class="muted">Имя</td><td>${escapeHtml(student.firstName || "—")}</td></tr>
        <tr><td class="muted">Фамилия</td><td>${escapeHtml(student.lastName || "—")}</td></tr>
        <tr><td class="muted">Учебная группа</td><td>${escapeHtml(student.groupName || "—")}</td></tr>
        <tr><td class="muted">Почта</td><td>${escapeHtml(student.email || "—")}</td></tr>
        <tr>
          <td class="muted">Пароль</td>
          <td>${
            student.initialPassword
              ? `<code>${escapeHtml(student.initialPassword)}</code>
                 <span class="muted" style="font-size:12px">— пароль, с которым создана учётная запись</span>`
              : '<span class="muted">не сохранён</span>'
          }</td>
        </tr>
      </table>
    </div>
    <div class="card">
      <h3>Задания</h3>
      <div id="deadline-warnings"></div>
      <table>
        <thead>
          <tr><th>Задание</th><th>Дедлайн</th><th>Последняя версия</th><th>Статус</th><th>Активность</th><th>Оценка</th></tr>
        </thead>
        <tbody id="profile-rows"></tbody>
      </table>
    </div>
  `;

  renderDeadlineWarnings(rows);

  const tbody = document.getElementById("profile-rows");
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">Заданий пока нет.</td></tr>';
    return;
  }
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.className = "student-row";
    tr.innerHTML = `
      <td>${escapeHtml(r.title)}${r.archived ? ' <span class="muted">(в архиве)</span>' : ""}${
        r.isActive ? deadlineMark(r) : ""
      }</td>
      <td class="muted">${
        r.isActive
          ? r.deadline
            ? formatDeadline(r.deadline)
            : "—"
          : "не требует выполнения"
      }</td>
      <td>${r.latestVersion ? "v" + r.latestVersion : "—"}</td>
      <td>${
        !r.isActive
          ? '<span class="muted">не требует выполнения</span>'
          : r.status
            ? `<span class="badge ${r.status}">${versionStatusLabel(r.status)}</span>`
            : '<span class="badge">не начато</span>'
      }</td>
      <td class="muted">${r.lastActivity ? new Date(r.lastActivity).toLocaleString() : "—"}</td>
      <td>${
        r.score !== null && r.score !== undefined
          ? `${r.score}${r.maxScore ? ` / ${r.maxScore}` : ""}`
          : "—"
      }</td>
    `;
    // Jump straight to reviewing this student's work on that assignment.
    tr.onclick = () => {
      window.location.href = workPagePath(student.id, r.assignmentId, "student");
    };
    tbody.appendChild(tr);
  });
}


// ---------- Notifications ----------
//
// Class-wide announcements. The banners students see are rendered by ui.js;
// this is the authoring side: the sidebar list and the form behind it.

let activeNotification = null; // the one open in the form, if any

// One form for writing a new announcement and for editing an existing one.
function renderNotificationForm(existing) {
  const editing = !!existing;
  activeNotification = existing || null;
  activeAssignment = null;
  activeStudent = null;
  activeProfile = null;
  onDataChanged();

  // Default: active until the end of tomorrow, which is the common case for
  // "read this before the next class".
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(23, 59, 0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  const asInput = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;

  const main = document.getElementById("main-content");
  main.innerHTML = `
    <div class="card">
      <h2>${editing ? "Редактирование уведомления" : "Новое уведомление"}</h2>
      <p class="muted">
        Текст увидит каждый ученик — плашкой над рабочей областью, пока
        уведомление активно. Ученик может закрыть плашку; до конца его сессии
        она больше не появится.
      </p>
      <div class="form-row">
        <label>Текст уведомления</label>
        <textarea id="n-body" rows="4"
                  placeholder="Например: в пятницу занятие в 302 аудитории">${
                    editing ? escapeHtml(existing.body) : ""
                  }</textarea>
      </div>
      <div class="form-row">
        <label>Активно до</label>
        <input type="datetime-local" id="n-until" value="${
          editing
            ? escapeHtml(String(existing.activeUntil).replace(" ", "T"))
            : asInput(tomorrow)
        }">
      </div>
      <div id="n-message"></div>
      <div class="toolbar">
        <button id="n-save">${editing ? "Сохранить изменения" : "Опубликовать"}</button>
        ${
          editing
            ? '<button class="secondary danger" id="n-delete">Удалить</button>'
            : ""
        }
      </div>
    </div>`;

  document.getElementById("n-save").onclick = () => saveNotification(existing);
  if (editing) {
    document.getElementById("n-delete").onclick = () => deleteNotification(existing);
  }
}

function notificationMessage(text, kind) {
  const box = document.getElementById("n-message");
  if (!box) return;
  box.className = text ? (kind === "error" ? "form-message error" : "form-message success") : "";
  box.textContent = text || "";
}

async function saveNotification(existing) {
  const body = document.getElementById("n-body").value.trim();
  const activeUntil = document.getElementById("n-until").value;
  if (!body) return notificationMessage("Напишите текст уведомления.", "error");
  if (!activeUntil) return notificationMessage("Укажите, до какого момента оно активно.", "error");

  const btn = document.getElementById("n-save");
  btn.disabled = true;
  try {
    const payload = JSON.stringify({ body, activeUntil });
    if (existing) {
      await api(`/api/notifications/${existing.id}`, { method: "PUT", body: payload });
      activeNotification = { ...existing, body, activeUntil: activeUntil.replace("T", " ") };
      notificationMessage("Изменения сохранены.", "success");
    } else {
      const { notification } = await api("/api/notifications", {
        method: "POST",
        body: payload,
      });
      // Published: from here on it is an existing notification, so it gets
      // its own address rather than staying on the "new" page.
      window.location.href = `/notifications?id=${notification.id}`;
      return;
    }
    await onDataChanged();
    // The teacher's own banner bar shows what the students now see.
    await loadNotifications();
  } catch (err) {
    notificationMessage("Не удалось сохранить: " + err.message, "error");
  } finally {
    const again = document.getElementById("n-save");
    if (again) again.disabled = false;
  }
}

async function deleteNotification(existing) {
  if (!confirm(`Удалить уведомление «${existing.body.slice(0, 60)}»?`)) return;
  try {
    await api(`/api/notifications/${existing.id}`, { method: "DELETE" });
    activeNotification = null;
    window.location.href = "/notifications";
  } catch (err) {
    notificationMessage("Не удалось удалить: " + err.message, "error");
  }
}

// ---------- The file mirror: what the sandbox can download from ----------
//
// The sidebar shows how many files are being served; the panel is where the
// teacher adds them and copies their URLs.

let mirrorFiles = [];

function mirrorMessage(text, kind) {
  const box = document.getElementById("mirror-message");
  if (box) box.innerHTML = `<div class="form-message ${kind}">${escapeHtml(text)}</div>`;
}

async function renderMirrorPanel() {
  activeAssignment = null;
  activeStudent = null;
  activeProfile = null;
  activeNotification = null;
  onDataChanged();

  const main = document.getElementById("main-content");
  main.innerHTML = `
    <div class="card">
      <h2>Файлы по сети</h2>
      <p class="muted" style="font-size:13px">
        Эти файлы программа ученика может скачать по HTTP — так выполняются задания
        на работу с сетью. Больше из песочницы не доступно ничего: ни интернет, ни
        этот сервер. Доступ включается галочкой «Разрешить скачивание файлов по сети»
        в самом задании.
      </p>
      <div id="mirror-message"></div>
      <div id="mirror-status" class="muted" style="font-size:13px">Проверяем раздачу…</div>
      <div class="form-row" style="margin-top:12px">
        <label>Добавить файлы</label>
        <input type="file" id="mirror-files" multiple>
        <span class="muted" style="font-size:12px">
          Только текстовые данные: txt, csv, json, xml и подобные, либо без расширения.
          Файл с тем же именем заменяется.
        </span>
      </div>
      <button id="mirror-upload-btn">Загрузить</button>
      <div id="mirror-list" style="margin-top:16px"></div>
    </div>
  `;

  document.getElementById("mirror-upload-btn").onclick = uploadMirrorFiles;

  // What is being served right now. The panel asks for this itself: it used
  // to arrive with the sidebar summary, which no longer exists.
  try {
    const data = await api("/api/mirror");
    mirrorFiles = data.files || [];
  } catch (err) {
    mirrorMessage("Не удалось получить список файлов: " + err.message, "error");
  }
  renderMirrorList();
  refreshMirrorStatus();
}

async function refreshMirrorStatus() {
  const box = document.getElementById("mirror-status");
  if (!box) return;
  try {
    const status = await api("/api/mirror/status");
    box.innerHTML = status.running
      ? `Раздача работает, адрес <code>${escapeHtml(status.baseUrl)}</code>.
         <button class="secondary" id="mirror-stop-btn" style="margin-left:8px">Остановить</button>`
      : `Раздача не запущена — она поднимется сама при первом запуске задания с доступом к сети.
         <button class="secondary" id="mirror-start-btn" style="margin-left:8px">Запустить сейчас</button>`;
    const start = document.getElementById("mirror-start-btn");
    const stop = document.getElementById("mirror-stop-btn");
    if (start) start.onclick = () => mirrorPower("start");
    if (stop) stop.onclick = () => mirrorPower("stop");
  } catch (err) {
    box.textContent = "Не удалось опросить раздачу: " + err.message;
  }
}

async function mirrorPower(action) {
  const box = document.getElementById("mirror-status");
  if (box) box.textContent = action === "start" ? "Запускаем…" : "Останавливаем…";
  try {
    await api(`/api/mirror/${action}`, { method: "POST" });
  } catch (err) {
    mirrorMessage("Не получилось: " + err.message, "error");
  }
  refreshMirrorStatus();
}

function renderMirrorList() {
  const box = document.getElementById("mirror-list");
  if (!box) return;
  if (mirrorFiles.length === 0) {
    box.innerHTML = '<p class="muted">Пока ничего не раздаётся.</p>';
    return;
  }
  box.innerHTML = `
    <table>
      <thead><tr><th>Файл</th><th>Ссылка для программы</th><th>Размер</th><th></th></tr></thead>
      <tbody>
        ${mirrorFiles
          .map(
            (file) => `<tr>
              <td>${escapeHtml(file.filename)}</td>
              <td><code>${escapeHtml(file.url)}</code></td>
              <td>${Math.max(1, Math.round(file.size / 1024))} КБ</td>
              <td><button class="delete-file" data-file="${escapeHtml(
                file.filename
              )}" title="Убрать из раздачи">×</button></td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
  box.querySelectorAll(".delete-file").forEach((button) => {
    button.onclick = () => deleteMirrorFile(button.dataset.file);
  });
}

async function uploadMirrorFiles() {
  const input = document.getElementById("mirror-files");
  const chosen = Array.from((input && input.files) || []);
  if (chosen.length === 0) return mirrorMessage("Выберите файлы.", "error");

  const button = document.getElementById("mirror-upload-btn");
  button.disabled = true;
  try {
    const files = await Promise.all(
      chosen.map(
        (file) =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve({ name: file.name, data: reader.result });
            reader.onerror = () => reject(new Error(`Не удалось прочитать «${file.name}»`));
            reader.readAsDataURL(file);
          })
      )
    );
    const result = await api("/api/mirror", {
      method: "POST",
      body: JSON.stringify({ files }),
    });
    mirrorFiles = result.all || [];
    input.value = "";
    renderMirrorList();
    onDataChanged();
    mirrorMessage(`Файлов в раздаче: ${mirrorFiles.length}.`, "success");
  } catch (err) {
    mirrorMessage("Не удалось загрузить: " + err.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function deleteMirrorFile(filename) {
  if (!confirm(`Убрать «${filename}» из раздачи?`)) return;
  try {
    const result = await api(`/api/mirror/${encodeURIComponent(filename)}`, {
      method: "DELETE",
    });
    mirrorFiles = result.files || [];
    renderMirrorList();
    onDataChanged();
  } catch (err) {
    mirrorMessage("Не удалось убрать: " + err.message, "error");
  }
}

// ---------- Page start-up ----------
//
// Each section of the teacher's side is its own page, and each one loads this
// file plus a small script of its own. What they have in common - who is
// logged in, the review badges, the announcement banners, the Log out button -
// happens here.

// A page with a list of its own installs a renderer here; shared code calls it
// after anything that could change what that list shows (a new mark clears a
// badge, a saved notification changes the tiles, and so on). Pages without a
// list leave it alone.
let onDataChanged = async () => {};

async function initTeacherPage({ dataChanged, withEditor = false } = {}) {
  if (dataChanged) onDataChanged = dataChanged;
  if (withEditor) initEditor();

  const logout = document.getElementById("logout-btn");
  if (logout) {
    logout.onclick = async () => {
      await api("/api/auth/logout", { method: "POST" });
      window.location.href = "/login.html";
    };
  }

  await loadMe();
  await loadPendingReview();
  // The banners themselves live in ui.js, shared with the student's page.
  if (typeof loadNotifications === "function") await loadNotifications();
}

// Where a page puts its own content. Every teacher page has this element.
function mainContent() {
  return document.getElementById("main-content");
}

// One student's work on one assignment has a page of its own. The pair has no
// id in the database - a student who has not started has nothing to point at -
// so the address names both halves. `from` only decides where "back" leads,
// since the same page is reached from the assignment and from the student.
function workPagePath(studentId, assignmentId, from) {
  return `/student-assignment-work?student=${studentId}&assignment=${assignmentId}${
    from ? `&from=${from}` : ""
  }`;
}

// The link in the page heading. A section's list points back to the sections;
// once one item of it is open, it should point back to that section's list
// instead, so the way out is always one click away.
function setBackLink(href, text) {
  const link = document.querySelector(".page-head .back-link");
  if (!link) return;
  link.href = href;
  link.textContent = text;
}
