let currentUser = null;
let assignments = [];
let activeAssignment = null;
let versions = [];
let activeVersion = null; // the version currently loaded into the editor
let projectFiles = []; // [{ filename, content }] - the project in the editor
let uploadedFiles = []; // free-form assignments: the student's attachments
let runStream = null; // EventSource carrying a running program's output
let runSessionId = null; // id of that program, while it lives
let typedThisRun = []; // lines the student typed into the console this run
let activeFile = null; // file shown in the editor (source or data file)
let entryJavaFile = null; // the .java file Run starts from
let editor = null;
let editorReady = null; // promise
let selectedVersionForMessage = null;

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

function initEditor() {
  editorReady = new Promise((resolve) => {
    require.config({ paths: { vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.47.0/min/vs" } });
    require(["vs/editor/editor.main"], () => {
      resolve();
    });
  });
}

async function loadMe() {
  const { user } = await api("/api/auth/me");
  if (!user) { window.location.href = "/login.html"; return; }
  currentUser = user;
  document.getElementById("whoami").textContent = `${user.displayName} (ученик)`;
}

async function loadAssignments() {
  const { assignments: list } = await api("/api/assignments");
  assignments = list;
  const container = document.getElementById("assignment-list");
  container.innerHTML = "";
  if (list.length === 0) {
    container.innerHTML = '<p class="muted">Заданий пока нет.</p>';
    return;
  }
  list.forEach((a) => {
    const div = document.createElement("div");
    div.className = "assignment-item" + (activeAssignment && activeAssignment.id === a.id ? " active" : "");
    div.innerHTML = `<div class="title">${escapeHtml(a.title)}${deadlineMark(a)}</div>
      <div class="meta">${typeBadge(a.type)} ${
        a.deadline
          ? "до " + formatDeadline(a.deadline)
          : new Date(a.created_at).toLocaleDateString()
      }</div>`;
    // Each assignment is its own page, so this is a link, not a redraw.
    div.onclick = () => {
      window.location.href = `/student/work?id=${a.id}`;
    };
    container.appendChild(div);
  });
}

// ---------------------------------------------------------------------
// Notifications
//
// The banners themselves are handled in ui.js, shared with the teacher's
// page. This is the sidebar list: everything active right now, closed ones
// included - clicking one brings its banner back so it can be read again.
// ---------------------------------------------------------------------

window.onNotificationsLoaded = (list) => {
  const container = document.getElementById("notification-list");
  if (!container) return;
  container.innerHTML = "";
  if (list.length === 0) {
    container.innerHTML = '<p class="muted">Активных уведомлений нет.</p>';
    return;
  }
  list.forEach((item) => {
    const div = document.createElement("div");
    div.className =
      "assignment-item notification-item" + (item.dismissed ? " is-dismissed" : "");
    // A preview keeps the teacher's line breaks but not the blank lines
    // between paragraphs: three lines is all it shows, and a gap would eat one.
    div.innerHTML = `<div class="title">${escapeHtml(
      item.body.replace(/\n{2,}/g, "\n")
    )}</div>
      <div class="meta">активно до ${escapeHtml(formatDeadline(item.activeUntil))}${
        item.dismissed ? " · закрыто" : ""
      }</div>`;
    div.title = item.dismissed
      ? "Нажмите, чтобы показать уведомление снова"
      : item.body;
    div.onclick = () => revealNotification(item.id);
    container.appendChild(div);
  });
};

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ---------------------------------------------------------------------
// Assignment types
// ---------------------------------------------------------------------

const TYPE_LABEL = { code: "Код", text: "Текст", freeform: "Произвольное", test: "Тест" };

// Version names, mirrored from routes/submissions.js
const MAX_VERSION_TITLE = 80;

// Student attachment limits, mirrored from storage.js
const MAX_STUDENT_FILES = 3;
const MAX_STUDENT_MB = 5;
const BLOCKED_EXTENSIONS = [
  ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".cab", ".iso", ".dmg",
  ".exe", ".msi", ".dll", ".so", ".dylib", ".app", ".apk", ".deb", ".rpm",
  ".com", ".scr", ".pif", ".jar", ".bin",
  ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf",
  ".wsh", ".sh", ".reg", ".lnk", ".hta", ".msc", ".chm",
];

function assignmentType() {
  return (activeAssignment && activeAssignment.type) || "code";
}

function typeBadge(type) {
  const label = TYPE_LABEL[type] || TYPE_LABEL.code;
  return `<span class="type-badge type-${type || "code"}">${label}</span>`;
}

// Code and text assignments: an editor plus the version history.
function renderWorkCard() {
  const isText = assignmentType() === "text";
  return `
    <div class="card">
      <h3>${isText ? "Ваш ответ" : "Редактор кода"}</h3>
      ${
        isText
          ? '<textarea id="text-editor" class="text-editor" placeholder="Напишите ответ здесь…"></textarea>'
          : `<div class="editor-layout" id="editor-layout">
               <div class="file-tree">
                 <div class="file-tree-header">Проект</div>
                 <div id="file-list"></div>
                 <div class="file-tree-actions">
                   <button class="secondary" id="new-file-btn">+ Новый файл</button>
                   <button class="secondary" id="add-local-file-btn"
                           title="Взять файл с этого компьютера и положить в проект">
                     + Файл с компьютера
                   </button>
                 </div>
                 <input type="file" id="local-file-input" multiple hidden>
               </div>
               <div class="editor-wrap" id="editor-container"></div>
               <div class="binary-note" id="binary-note" hidden></div>
             </div>
             <div id="entry-hint" class="muted"></div>
             <div id="network-hint" style="font-size:12px; margin-top:4px"></div>`
      }
      <div id="readonly-banner"></div>
      <div class="toolbar">
        ${isText ? "" : '<button id="run-btn">▶ Запустить</button>'}
        ${isText ? "" : '<button class="secondary" id="console-stop" hidden>■ Стоп</button>'}
        <input id="version-title" maxlength="${MAX_VERSION_TITLE}" style="flex:1;min-width:140px"
               placeholder="Название версии (необязательно)">
        <button class="secondary" id="rename-version-btn" hidden>Переименовать</button>
        <button class="secondary" id="save-draft-btn">Сохранить черновик</button>
        <button id="submit-btn">Сдать</button>
      </div>
      ${
        isText
          ? ""
          : // One console for everything: program output, errors and what the
            // student types, in the order it happened - the input line lives
            // inside the panel so the caret sits right after the prompt.
            `<div class="output-panel terminal" id="output-panel"><span id="terminal-text">Здесь появится вывод программы.</span><input
                 id="console-line" class="terminal-input" autocomplete="off"
                 spellcheck="false" hidden></div>`
      }
    </div>

    <div class="card">
      <h3>История версий</h3>
      <div class="version-list" id="version-list"><p class="muted">Загрузка…</p></div>
    </div>`;
}

// Free-form assignments: attachments, no versions.
function renderUploadCard() {
  return `
    <div class="card">
      <h3>Ваши файлы</h3>
      <p class="muted" style="font-size:13px">
        Можно приложить до ${MAX_STUDENT_FILES} файлов, по ${MAX_STUDENT_MB} МБ каждый.
        Файл с уже использованным именем заменяет предыдущий.
        Архивы и программы (zip, rar, exe и подобные) не принимаются.
      </p>
      <div id="upload-list"><p class="muted">Загрузка…</p></div>
      <div class="toolbar">
        <input type="file" id="upload-input" multiple>
        <button id="upload-btn" disabled>Приложить</button>
      </div>
      <div id="upload-message"></div>
    </div>`;
}


// ---------------------------------------------------------------------
// Tests
//
// A test is always visible in the list, but it can only be solved between
// "available from" and the deadline. Inside that window the student presses
// one button to open the questions - which is also when the clock starts.
// Answers are saved as they are given, so when the time runs out there is
// nothing left to send: the attempt is simply closed.
// ---------------------------------------------------------------------

let testState = null; // the last state the server reported
let testTicker = null; // the countdown's interval
let testSubmitting = false;

function isSurveyAssignment() {
  return assignmentType() === "test" && activeAssignment.test_kind === "survey";
}

function stopTestTicker() {
  if (testTicker) {
    clearInterval(testTicker);
    testTicker = null;
  }
}

function formatClock(seconds) {
  const safe = Math.max(0, seconds);
  const mm = String(Math.floor(safe / 60)).padStart(2, "0");
  const ss = String(safe % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

// Timestamps written by the database are UTC; the window dates are local
// strings the teacher typed (see testing.js).
function formatStoredTime(value) {
  return value
    ? new Date(`${String(value).replace(" ", "T")}Z`).toLocaleString()
    : "";
}

function renderTestCard() {
  return `
    <div class="card" id="test-card">
      <h3>${isSurveyAssignment() ? "Опрос" : "Тест"}</h3>
      <div id="test-area"><p class="muted">Загрузка…</p></div>
    </div>`;
}

async function loadTest() {
  const area = document.getElementById("test-area");
  if (!area) return;
  try {
    testState = await api(`/api/tests/assignment/${activeAssignment.id}`);
  } catch (err) {
    area.innerHTML = `<p class="muted">Не удалось загрузить тест: ${escapeHtml(
      err.message
    )}</p>`;
    return;
  }
  renderTest();
}

function renderTest() {
  const area = document.getElementById("test-area");
  if (!area || !testState) return;
  stopTestTicker();

  const { availability, state } = testState;
  const windowNote = `<p class="muted" style="font-size:13px">
      ${availability.from ? `Доступен с ${formatDeadline(availability.from)}. ` : ""}
      ${availability.to ? `Решить нужно до ${formatDeadline(availability.to)}. ` : ""}
      На решение ${testState.assignment.timeLimitMinutes} мин,
      вопросов: ${testState.questionCount}.
    </p>`;

  // Outside the window the questions are not even loaded - the server does
  // not send them.
  if (!availability.open && state !== "submitted") {
    area.innerHTML = `${windowNote}
      <div class="warning-banner${availability.reason === "late" ? " overdue" : ""}">
        <strong>${
          availability.reason === "late"
            ? "Дедлайн для решения уже истёк"
            : "Тест ещё не доступен для решения"
        }</strong>
      </div>`;
    return;
  }

  if (state === "not-started") {
    area.innerHTML = `${windowNote}
      <p class="muted">
        Вопросы откроются после нажатия кнопки, и с этого момента пойдёт время.
        Пройти тест можно один раз.
      </p>
      <button id="test-start-btn">Показать вопросы и начать</button>`;
    document.getElementById("test-start-btn").onclick = startTest;
    return;
  }

  if (state === "submitted") {
    const when = formatStoredTime(testState.submittedAt);
    area.innerHTML = `${windowNote}
      <div class="form-message success">Ответы отправлены${when ? " " + when : ""}.</div>
      ${renderTestQuestionList({ readOnly: true })}`;
    return;
  }

  // In progress: the clock, the questions, and a way to finish early.
  area.innerHTML = `${windowNote}
    <div class="test-timer" id="test-timer">${formatClock(testState.secondsLeft)}</div>
    ${renderTestQuestionList({ readOnly: false })}
    <div class="toolbar">
      <button id="test-submit-btn">Завершить и отправить</button>
    </div>`;
  wireTestInputs();
  document.getElementById("test-submit-btn").onclick = () => submitTest(false);
  startTestTicker();
}

// The questions, with whatever this student has already answered.
function renderTestQuestionList({ readOnly }) {
  const answers = new Map(testState.answers.map((a) => [a.questionId, a]));
  const kindLabel = {
    single: "один ответ",
    multiple: "несколько ответов",
    open: "открытый ответ",
  };

  return `<div class="test-questions">${testState.questions
    .map((question, index) => {
      const answer = answers.get(question.id) || { optionIds: [], textAnswer: "" };
      const body =
        question.kind === "open"
          ? `<textarea class="test-open" data-question="${question.id}" rows="3"
                       placeholder="Ваш ответ"${readOnly ? " disabled" : ""}>${escapeHtml(
              answer.textAnswer
            )}</textarea>`
          : `<div class="test-options">${question.options
              .map(
                (option) => `
            <label class="test-option">
              <input type="${question.kind === "single" ? "radio" : "checkbox"}"
                     name="q-${question.id}" value="${option.id}"
                     data-question="${question.id}"
                     ${answer.optionIds.includes(option.id) ? "checked" : ""}
                     ${readOnly ? "disabled" : ""}>
              <span>${escapeHtml(option.body)}</span>
            </label>`
              )
              .join("")}</div>`;

      return `
        <div class="test-question-view">
          <div class="test-question-head">
            <span class="tq-number">${index + 1}</span>
            <span class="muted" style="font-size:12px">${kindLabel[question.kind]}</span>
          </div>
          <div class="test-question-body">${escapeHtml(question.body)}</div>
          ${body}
        </div>`;
    })
    .join("")}</div>`;
}

function wireTestInputs() {
  const area = document.getElementById("test-area");
  if (!area) return;

  area.querySelectorAll(".test-options input").forEach((input) => {
    input.onchange = () => {
      const questionId = Number(input.dataset.question);
      const chosen = Array.from(
        area.querySelectorAll(`input[name="q-${questionId}"]:checked`)
      ).map((el) => Number(el.value));
      saveTestAnswer({ questionId, optionIds: chosen });
    };
  });

  // Text is saved when the student leaves the box rather than on every key:
  // one request per answer, and the last word still gets in because every box
  // is read again when the test is handed in.
  area.querySelectorAll(".test-open").forEach((box) => {
    box.onchange = () =>
      saveTestAnswer({ questionId: Number(box.dataset.question), textAnswer: box.value });
  });
}

// Keeps the local copy in step with what was sent, so a re-render (after the
// clock stops, say) shows the same answers.
function rememberAnswer(payload) {
  const existing = testState.answers.find((a) => a.questionId === payload.questionId);
  const value = {
    questionId: payload.questionId,
    optionIds: payload.optionIds || [],
    textAnswer: payload.textAnswer || "",
  };
  if (existing) Object.assign(existing, value);
  else testState.answers.push(value);
}

async function saveTestAnswer(payload) {
  rememberAnswer(payload);
  try {
    const result = await api(`/api/tests/assignment/${activeAssignment.id}/answer`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    if (typeof result.secondsLeft === "number") {
      testState.secondsLeft = result.secondsLeft;
    }
  } catch (err) {
    // The usual reason is that the time ran out between the last tick and
    // this answer; reload to show the closed test rather than pretend.
    const expired = /Время вышло/.test(err.message);
    await loadTest();
    if (!expired) alert("Не удалось сохранить ответ: " + err.message);
  }
}

async function startTest() {
  const button = document.getElementById("test-start-btn");
  if (button) button.disabled = true;
  try {
    const started = await api(`/api/tests/assignment/${activeAssignment.id}/start`, {
      method: "POST",
    });
    testState = { ...testState, ...started, state: "in-progress" };
    renderTest();
  } catch (err) {
    alert(err.message);
    await loadTest();
  }
}

function startTestTicker() {
  stopTestTicker();
  testTicker = setInterval(() => {
    testState.secondsLeft -= 1;
    const clock = document.getElementById("test-timer");
    if (clock) {
      clock.textContent = formatClock(testState.secondsLeft);
      if (testState.secondsLeft <= 60) clock.classList.add("urgent");
    }
    if (testState.secondsLeft <= 0) {
      stopTestTicker();
      submitTest(true);
    }
  }, 1000);
}

// byClock=true is the automatic hand-in: the answers are already on the
// server, so this only closes the attempt.
async function submitTest(byClock) {
  if (testSubmitting) return;
  if (!byClock && !confirm("Завершить тест? Изменить ответы после этого нельзя.")) return;
  testSubmitting = true;
  stopTestTicker();

  // Whatever is in the open-answer boxes but not yet sent - the student may
  // well be typing when the clock runs out.
  const area = document.getElementById("test-area");
  if (area) {
    const pending = Array.from(area.querySelectorAll(".test-open")).map((box) =>
      saveTestAnswer({
        questionId: Number(box.dataset.question),
        textAnswer: box.value,
      })
    );
    await Promise.allSettled(pending);
  }

  try {
    await api(`/api/tests/assignment/${activeAssignment.id}/submit`, { method: "POST" });
  } catch {
    // Already closed by the server - the reload below shows that.
  }
  testSubmitting = false;
  await loadTest();
  await refreshDeadlineState();
  await loadGrade();
  if (byClock) alert("Время вышло. Ваши ответы отправлены.");
}

// ---------------------------------------------------------------------
// Deadlines (mirrors what the teacher sees in a student's profile)
// ---------------------------------------------------------------------

function formatDeadline(deadline) {
  const date = new Date(String(deadline).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? deadline : date.toLocaleString();
}

function deadlineHint(row) {
  const hours = row.hoursLeft;
  if (hours === null || hours === undefined) return "";
  if (row.deadlineState === "overdue") {
    const late = Math.abs(hours);
    return late < 48 ? `просрочено на ${late} ч` : `просрочено на ${Math.round(late / 24)} дн`;
  }
  return hours < 24 ? `осталось ${hours} ч` : `осталось ${Math.round(hours / 24)} дн`;
}

function deadlineMark(row) {
  if (!row.deadlineState) return "";
  const cls = row.deadlineState === "overdue" ? "deadline-flag overdue" : "deadline-flag";
  const label = row.deadlineState === "overdue" ? "просрочено" : "скоро срок";
  return ` <span class="${cls}" title="${escapeHtml(deadlineHint(row))}">${label}</span>`;
}

// Re-reads the assignment list (which carries the deadline state) and updates
// both the sidebar and the notice on the open assignment.
async function refreshDeadlineState() {
  await loadAssignments();
  const fresh = assignments.find((a) => a.id === activeAssignment.id);
  if (fresh) activeAssignment = fresh;
  const box = document.getElementById("deadline-notice");
  if (box) box.innerHTML = renderDeadlineNotice(activeAssignment);
}

// The line shown on the open assignment: the due date, plus a warning box
// while the work is unsubmitted and the deadline is close or gone.
function renderDeadlineNotice(assignment) {
  if (!assignment.deadline) return "";

  const due = `<p class="muted" style="font-size:13px">
      Срок сдачи: <strong>${escapeHtml(formatDeadline(assignment.deadline))}</strong>
    </p>`;

  if (!assignment.deadlineState) return due;

  const overdue = assignment.deadlineState === "overdue";
  return `${due}
    <div class="warning-banner${overdue ? " overdue" : ""}">
      <strong>${overdue ? "Срок сдачи истёк." : "Срок сдачи близко."}</strong>
      Работа ещё не сдана — ${escapeHtml(deadlineHint(assignment))}.
      Нажмите «Submit», когда будете готовы.
    </div>`;
}

async function selectAssignment(assignment) {
  // Leaving the assignment abandons whatever was running on it. The test
  // countdown stops too - the attempt itself keeps running on the server,
  // which is what closes it when the time is up.
  stopRun();
  closeRunStream();
  stopTestTicker();
  testState = null;
  activeAssignment = assignment;
  selectedVersionForMessage = null;
  activeVersion = null;
  await renderMainPanel(); // awaits the editor so loadVersions can fill it
  await Promise.all([
    // Free-form work has no versions - its files are loaded by setupUploads();
    // a test has none either, and loads through loadTest().
    assignmentType() === "freeform" || assignmentType() === "test"
      ? Promise.resolve()
      : loadVersions(),
    loadDiscussion(),
    loadAssignmentFiles(),
    loadGrade(),
  ]);
}

// ---------------------------------------------------------------------
// The grade for this assignment
//
// The teacher's mark, shown on the assignment itself so a student doesn't have
// to go looking for it in the discussion.
// ---------------------------------------------------------------------

function maxScore() {
  const value = activeAssignment && activeAssignment.max_score;
  return Number.isInteger(value) && value > 0 ? value : 15;
}

async function loadGrade() {
  const box = document.getElementById("grade-box");
  if (!box) return;
  // A survey is not marked at all - saying "оценка не выставлена" about it
  // would be wrong rather than just empty.
  if (isSurveyAssignment()) {
    box.innerHTML = "";
    return;
  }
  let grade = null;
  try {
    ({ grade } = await api(`/api/grades/assignment/${activeAssignment.id}`));
  } catch {
    box.innerHTML = "";
    return;
  }

  // A row can exist with the score cleared - that still counts as ungraded.
  const scored = grade && grade.score !== null && grade.score !== undefined;
  const feedback = grade && grade.feedback ? grade.feedback.trim() : "";

  if (!scored && !feedback) {
    box.innerHTML = `<div class="grade-panel">
        <span class="muted">Оценка: ещё не выставлена. Максимум за задание — ${maxScore()}.</span>
      </div>`;
    return;
  }

  box.innerHTML = `<div class="grade-panel graded">
      <div>Оценка: <span class="score">${
        scored ? escapeHtml(String(grade.score)) : "—"
      }</span> из ${maxScore()}</div>
      ${
        feedback
          ? `<div class="feedback"><strong>Комментарий преподавателя:</strong>\n${escapeHtml(feedback)}</div>`
          : ""
      }
    </div>`;
}

async function renderMainPanel() {
  const main = document.getElementById("main-content");
  main.innerHTML = `
    <div class="card">
      <h2>${escapeHtml(activeAssignment.title)} ${typeBadge(activeAssignment.type)}</h2>
      <p class="muted assignment-description">${escapeHtml(activeAssignment.description || "")}</p>
      <div id="deadline-notice">${renderDeadlineNotice(activeAssignment)}</div>
      <div id="grade-box"></div>
      <div id="assignment-files"></div>
    </div>

    ${
      assignmentType() === "test"
        ? renderTestCard()
        : assignmentType() === "freeform"
          ? renderUploadCard()
          : renderWorkCard()
    }

    <div class="card">
      <h3>Обсуждение с преподавателем</h3>
      <div id="linked-version-banner"></div>
      <div class="discussion" id="discussion-list"></div>
      <div class="toolbar">
        <input id="message-input" placeholder="Напишите сообщение…" style="flex:1">
        <button id="send-message-btn">Отправить</button>
      </div>
    </div>
  `;

  const type = assignmentType();
  if (type === "test") {
    await loadTest();
  } else if (type === "code") {
    await setupEditor();
    document.getElementById("new-file-btn").onclick = addFile;
    document.getElementById("add-local-file-btn").onclick = addLocalFile;
    document.getElementById("local-file-input").onchange = onLocalFilesChosen;
    document.getElementById("run-btn").onclick = runCode;

    const line = document.getElementById("console-line");
    const submitLine = () => {
      sendConsoleLine(line.value);
      line.value = "";
    };
    document.getElementById("console-stop").onclick = stopRun;
    line.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitLine();
    });
    // Clicking anywhere in the console puts the caret back on the input,
    // the way a terminal behaves.
    document.getElementById("output-panel").addEventListener("click", () => {
      if (!line.hidden && !window.getSelection().toString()) line.focus();
    });
  } else if (type === "text") {
    setupTextEditor();
  } else {
    setupUploads();
  }

  if (type !== "freeform" && type !== "test") {
    document.getElementById("save-draft-btn").onclick = () => saveVersion("draft");
    document.getElementById("submit-btn").onclick = () => saveVersion("submitted");
    document.getElementById("rename-version-btn").onclick = renameVersion;
  }
  document.getElementById("send-message-btn").onclick = sendMessage;
  document.getElementById("message-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendMessage();
  });
}

async function setupEditor() {
  await editorReady;
  const container = document.getElementById("editor-container");

  // The assignment's starter project - possibly several files the teacher
  // prepared. Falls back to a bare Main.java if it can't be loaded.
  const fallback =
    activeAssignment.starter_code ||
    "public class Main {\n    public static void main(String[] args) {\n        \n    }\n}\n";
  try {
    const starter = await api(`/api/assignments/${activeAssignment.id}/starter`);
    projectFiles = starter.files.length
      ? starter.files.map((f) => ({
          filename: f.filename,
          content: f.content,
          encoding: f.encoding === "base64" ? "base64" : "text",
        }))
      : [{ filename: "Main.java", content: fallback, encoding: "text" }];
    entryJavaFile = starter.entry || null;
  } catch {
    projectFiles = [{ filename: "Main.java", content: fallback, encoding: "text" }];
    entryJavaFile = "Main.java";
  }
  activeFile = entryFile() || projectFiles[0].filename;

  editor = monaco.editor.create(container, {
    value: currentFile().content,
    language: "java",
    theme: "vs-dark",
    automaticLayout: true,
    fontSize: 14,
    minimap: { enabled: false },
  });
  // Only a flag is set here, so typing stays free; the snapshot itself goes
  // out on a timer, and only when edit capture is switched on server-side.
  editor.onDidChangeModelContent(() => noteEdit());
  // The grip under the editor; Monaco's automaticLayout follows the height.
  makeEditorResizable(document.getElementById("editor-layout"));
  applyEditorToActiveFile();
  renderFileTree();
}

// ---------------------------------------------------------------------
// Text assignments
// ---------------------------------------------------------------------

// The starter text is whatever the teacher prepared; a saved version wins.
function setupTextEditor() {
  const box = document.getElementById("text-editor");
  if (box) box.value = activeAssignment.starter_code || "";
}

function textAnswer() {
  const box = document.getElementById("text-editor");
  return box ? box.value : "";
}

// ---------------------------------------------------------------------
// Console input (what java.util.Scanner reads)
// ---------------------------------------------------------------------

// Everything the student typed into the console during the current run. The
// submitted version is replayed against exactly this, so the result the
// teacher sees matches what the student saw.
function consoleInput() {
  return typedThisRun.length > 0 ? typedThisRun.join("\n") + "\n" : "";
}

// ---------------------------------------------------------------------
// Free-form assignments: attached files
// ---------------------------------------------------------------------

function extensionOf(name) {
  const dot = String(name).lastIndexOf(".");
  return dot === -1 ? "" : String(name).slice(dot).toLowerCase();
}

function showUploadMessage(text, kind) {
  const box = document.getElementById("upload-message");
  if (!box) return;
  box.className = text ? (kind === "error" ? "form-message error" : "form-message success") : "";
  box.textContent = text || "";
}

function setupUploads() {
  const input = document.getElementById("upload-input");
  const button = document.getElementById("upload-btn");

  input.onchange = () => {
    // Warn about a blocked file before anything is sent to the server.
    const rejected = Array.from(input.files).filter((f) =>
      BLOCKED_EXTENSIONS.includes(extensionOf(f.name))
    );
    const tooBig = Array.from(input.files).filter(
      (f) => f.size > MAX_STUDENT_MB * 1024 * 1024
    );

    if (rejected.length > 0) {
      showUploadMessage(
        `Нельзя прикрепить ${rejected
          .map((f) => f.name)
          .join(", ")}: архивы и программы (zip, rar, exe и подобные) не принимаются. Приложите сам документ.`,
        "error"
      );
      input.value = "";
      button.disabled = true;
      return;
    }
    if (tooBig.length > 0) {
      showUploadMessage(
        `Слишком большой файл: ${tooBig
          .map((f) => f.name)
          .join(", ")}. Максимум ${MAX_STUDENT_MB} МБ.`,
        "error"
      );
      input.value = "";
      button.disabled = true;
      return;
    }
    if (input.files.length > MAX_STUDENT_FILES) {
      showUploadMessage(`Можно приложить не больше ${MAX_STUDENT_FILES} файлов.`, "error");
      input.value = "";
      button.disabled = true;
      return;
    }

    showUploadMessage("", null);
    button.disabled = input.files.length === 0;
  };

  button.onclick = uploadFiles;
  loadUploads();
}

async function loadUploads() {
  const box = document.getElementById("upload-list");
  if (!box) return;
  try {
    const { files } = await api(`/api/uploads/assignment/${activeAssignment.id}`);
    uploadedFiles = files;
    if (files.length === 0) {
      box.innerHTML = '<p class="muted">Пока ничего не приложено.</p>';
      return;
    }
    box.innerHTML = "";
    files.forEach((file) => {
      const div = document.createElement("div");
      div.className = "file-item";
      div.innerHTML = `
        <a href="/api/uploads/${file.id}/download">${escapeHtml(file.originalName)}</a>
        <span class="muted">${formatSize(file.size)}</span>`;
      const del = document.createElement("button");
      del.className = "secondary";
      del.style.padding = "2px 8px";
      del.style.fontSize = "12px";
      del.textContent = "Удалить";
      del.onclick = () => deleteUpload(file);
      div.appendChild(del);
      box.appendChild(div);
    });
  } catch (err) {
    box.innerHTML = `<p class="muted">Не удалось загрузить список: ${escapeHtml(err.message)}</p>`;
  }
}

async function uploadFiles() {
  const input = document.getElementById("upload-input");
  const button = document.getElementById("upload-btn");
  const chosen = Array.from(input.files);
  if (chosen.length === 0) return;

  button.disabled = true;
  button.textContent = "Загрузка…";
  try {
    const files = await Promise.all(
      chosen.map(
        (file) =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve({ name: file.name, data: reader.result });
            reader.onerror = () => reject(new Error(`Не удалось прочитать "${file.name}"`));
            reader.readAsDataURL(file);
          })
      )
    );
    await api(`/api/uploads/assignment/${activeAssignment.id}`, {
      method: "POST",
      body: JSON.stringify({ files }),
    });
    input.value = "";
    showUploadMessage("Файлы приложены.", "success");
    await loadUploads();
    await refreshDeadlineState();
  } catch (err) {
    showUploadMessage(err.message, "error");
  } finally {
    button.disabled = true;
    button.textContent = "Attach";
  }
}

async function deleteUpload(file) {
  if (!confirm(`Удалить "${file.originalName}"?`)) return;
  try {
    await api(`/api/uploads/${file.id}`, { method: "DELETE" });
    showUploadMessage("", null);
    await loadUploads();
    await refreshDeadlineState();
  } catch (err) {
    showUploadMessage(err.message, "error");
  }
}

// ---------------------------------------------------------------------
// Project files
// ---------------------------------------------------------------------

const JAVA_FILENAME = /^[A-Za-z_][A-Za-z0-9_]*\.java$/;

// Data files in a project, mirrored from projectFiles.js. These are the names
// a person may add by hand; a file the student's own program writes keeps
// whatever name it chose.
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

function fileExtension(filename) {
  const dot = String(filename || "").lastIndexOf(".");
  return dot <= 0 ? "" : String(filename).slice(dot + 1).toLowerCase();
}

// A name a student is allowed to type or upload: a text data format, or no
// extension at all.
function isAllowedDataName(filename) {
  if (!DATA_FILENAME.test(filename)) return false;
  const ext = fileExtension(filename);
  return ext === "" || DATA_EXTENSIONS.includes(ext);
}

// Size of a file as stored, for the tree.
function fileSize(file) {
  if (isBinaryFile(file)) {
    // Base64 carries 3 bytes in every 4 characters.
    const text = file.content || "";
    const padding = (text.match(/=+$/) || [""])[0].length;
    return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
  }
  return new TextEncoder().encode(file.content || "").length;
}

function currentFile() {
  return projectFiles.find((f) => f.filename === activeFile) || projectFiles[0];
}

// Which file a Run starts from. Data files can be opened in the editor like
// anything else, but a run has to begin at a class with main().
function entryFile() {
  if (entryJavaFile && projectFiles.some((f) => f.filename === entryJavaFile)) {
    return entryJavaFile;
  }
  const firstJava = projectFiles.find((f) => isJavaFile(f.filename));
  return firstJava ? firstJava.filename : null;
}

// The editor is the single source of truth while a file is open, so its text
// has to be written back before anything reads the project. A binary file is
// never in the editor, so there is nothing to write back for it.
// ---------- Process data: reporting edits (off unless enabled) ----------
//
// The server logs everything it can see by itself - runs, submissions, marks.
// Editing happens here in the browser, so if the course wants edit data, the
// editor has to send it. The server decides whether it wants it at all
// (PROGSNAP_EDIT_CAPTURE) and how often (PROGSNAP_EDIT_INTERVAL_SECONDS); this
// side only obeys, and the server enforces the interval regardless.
//
// What travels is a snapshot of the project, the same thing a run sends -
// never keystrokes, and never anything the student did not type into a file.

let editCapture = { enabled: false, intervalSeconds: 60 };
let editCaptureTimer = null;
let editSinceLastReport = false;
let lastReportedCodeState = null;

async function loadEditCaptureConfig() {
  try {
    const cfg = await api("/api/progsnap/config");
    editCapture = {
      enabled: !!(cfg.enabled && cfg.editCapture),
      intervalSeconds: cfg.editIntervalSeconds || 60,
    };
  } catch {
    editCapture = { enabled: false, intervalSeconds: 60 };
  }
  if (editCapture.enabled) startEditCapture();
}

function startEditCapture() {
  if (editCaptureTimer) clearInterval(editCaptureTimer);
  editCaptureTimer = setInterval(reportEdit, editCapture.intervalSeconds * 1000);
}

// Called by the editor on every change: just a flag, so typing costs nothing.
function noteEdit() {
  if (editCapture.enabled) editSinceLastReport = true;
}

async function reportEdit() {
  if (!editCapture.enabled || !editSinceLastReport) return;
  if (!activeAssignment || !isEditable()) return;

  syncEditorToFile();
  const files = projectFiles.map((f) => ({
    filename: f.filename,
    content: f.content,
    encoding: f.encoding || "text",
  }));
  if (files.length === 0) return;

  // Nothing new since the last report means nothing to say - the student may
  // have typed a character and deleted it again.
  const fingerprint = JSON.stringify(files);
  if (fingerprint === lastReportedCodeState) {
    editSinceLastReport = false;
    return;
  }

  try {
    await api("/api/progsnap/edit", {
      method: "POST",
      body: JSON.stringify({
        assignmentId: activeAssignment.id,
        entry: entryFile(),
        filename: activeFile,
        clientTimestamp: new Date().toISOString(),
        files,
      }),
    });
    lastReportedCodeState = fingerprint;
    editSinceLastReport = false;
  } catch {
    // A lost snapshot is a lost row of research data; the lesson goes on.
  }
}

function syncEditorToFile() {
  if (!editor) return;
  const file = currentFile();
  if (file && !isBinaryFile(file)) file.content = editor.getValue();
}

function renderFileTree() {
  const list = document.getElementById("file-list");
  if (!list) return;
  list.innerHTML = "";

  const entry = entryFile();

  projectFiles.forEach((file) => {
    const div = document.createElement("div");
    div.className = "file-node" + (file.filename === activeFile ? " active" : "");

    const name = document.createElement("span");
    name.className = "file-node-name";
    name.textContent = file.filename;
    // Data files show their size: the point of them is the content, and a
    // zero-byte result is the usual first symptom of a stream bug.
    name.title = isJavaFile(file.filename)
      ? file.filename
      : `${file.filename} — ${formatSize(fileSize(file))}${
          isBinaryFile(file) ? ", двоичный файл" : ""
        }`;
    name.onclick = () => openFile(file.filename);
    div.appendChild(name);

    if (!isJavaFile(file.filename)) {
      const badge = document.createElement("span");
      badge.className = "data-badge" + (isBinaryFile(file) ? " binary" : "");
      badge.textContent = isBinaryFile(file) ? "двоич." : "данные";
      badge.title = isBinaryFile(file)
        ? "Двоичный файл — открыть в редакторе нельзя, можно скачать"
        : "Файл данных — программа может читать и перезаписывать его";
      div.appendChild(badge);

      // The only way to look at a serialised object, and the quickest way to
      // check a result file.
      const download = document.createElement("button");
      download.className = "download-file";
      download.textContent = "↓";
      download.title = "Скачать файл";
      download.onclick = (e) => {
        e.stopPropagation();
        downloadProjectFile(file);
      };
      div.appendChild(download);
    }

    // The .java file a Run starts from - marked the way an IDE does.
    if (file.filename === entry) {
      const badge = document.createElement("span");
      badge.className = "entry-badge";
      badge.textContent = "main";
      badge.title = "Запуск начинается с этого файла";
      div.appendChild(badge);
    } else if (isEditable() && projectFiles.length > 1) {
      const del = document.createElement("button");
      del.className = "delete-file";
      del.textContent = "×";
      del.title = "Удалить файл";
      del.onclick = (e) => {
        e.stopPropagation();
        deleteFile(file.filename);
      };
      div.appendChild(del);
    }

    list.appendChild(div);
  });

  const newBtn = document.getElementById("new-file-btn");
  if (newBtn) newBtn.disabled = !isEditable();
  const addLocalBtn = document.getElementById("add-local-file-btn");
  if (addLocalBtn) addLocalBtn.disabled = !isEditable();

  const hint = document.getElementById("entry-hint");
  if (hint) {
    // The example names a real text file from the project when there is one -
    // a binary file makes a poor illustration of a path.
    const example =
      (projectFiles.find((f) => !isJavaFile(f.filename) && !isBinaryFile(f)) || {})
        .filename || "data.txt";
    hint.textContent = entry
      ? `Файлы данных лежат рядом с программой: new File("${example}") — это относительный путь.`
      : "Добавьте файл .java, чтобы проект можно было запустить";
  }

  renderNetworkHint();
}

// Assignments with network access can download from the platform's own file
// server; nothing else is reachable from a run, so the addresses are worth
// showing right next to the editor.
async function renderNetworkHint() {
  const box = document.getElementById("network-hint");
  if (!box) return;
  if (!activeAssignment || !activeAssignment.network_access) {
    box.innerHTML = "";
    return;
  }
  try {
    const data = await api("/api/mirror");
    const files = data.files || [];
    box.innerHTML =
      files.length === 0
        ? `<span class="muted">Сеть в этом задании открыта на <code>${escapeHtml(
            data.baseUrl
          )}</code>, но файлов там пока нет.</span>`
        : `<span class="muted">Программе доступны по сети:</span> ${files
            .map((f) => `<code>${escapeHtml(f.url)}</code>`)
            .join(", ")}`;
  } catch {
    box.innerHTML = "";
  }
}

// Shows a file in the editor. Opening a .java file also makes it the entry
// point; opening a data file does not - it is data, not a program.
function openFile(filename) {
  syncEditorToFile();
  activeFile = filename;
  const file = currentFile();
  if (file && isJavaFile(file.filename)) entryJavaFile = file.filename;
  applyEditorToActiveFile();
  renderFileTree();
}

// Puts the open file in front of the student: text in Monaco, a binary file
// as a note where the editor would be (nothing sensible to show, and letting
// it be edited would corrupt it).
function applyEditorToActiveFile() {
  const file = currentFile();
  const wrap = document.getElementById("editor-container");
  const note = document.getElementById("binary-note");
  if (!wrap || !note) return;

  if (file && isBinaryFile(file)) {
    wrap.hidden = true;
    note.hidden = false;
    note.innerHTML = `<strong>${escapeHtml(file.filename)}</strong> — двоичный файл,
      ${formatSize(fileSize(file))}.<br>
      Его нельзя показать как текст: он таким и не является (например, это
      сериализованный объект). Программа читает и перезаписывает его как
      обычно, а посмотреть содержимое можно, скачав файл кнопкой «↓» в дереве
      проекта.`;
    return;
  }

  note.hidden = true;
  wrap.hidden = false;
  if (!editor) return;
  editor.setValue(file ? file.content : "");
  // Java gets Java highlighting; a data file is plain text.
  const model = editor.getModel();
  if (model) {
    monaco.editor.setModelLanguage(
      model,
      file && isJavaFile(file.filename) ? "java" : "plaintext"
    );
  }
  editor.updateOptions({ readOnly: !isEditable() });
}

// Hands the file to the browser as a download, straight from what the editor
// already has - no round trip to the server.
function downloadProjectFile(file) {
  const bytes = isBinaryFile(file)
    ? Uint8Array.from(atob(file.content || ""), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(file.content || "");
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.filename;
  link.click();
  // Give the browser a moment to start the download before dropping the blob.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// A new file typed by hand. A name ending in .java gets a class skeleton;
// anything else is treated as a data file and starts out empty.
function addFile() {
  if (!isEditable()) return;
  const raw = prompt(
    "New file name — Helper.java for code, input.txt for data:",
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
  if (projectFiles.some((f) => f.filename === filename)) {
    alert(`Файл «${filename}» уже есть в проекте.`);
    return;
  }

  syncEditorToFile();
  projectFiles.push({
    filename,
    content: isJava
      ? `public class ${filename.replace(/\.java$/, "")} {\n    \n}\n`
      : "",
    encoding: "text",
  });
  openFile(filename);
}

function dataNameMessage(filename) {
  return (
    `"${filename}" нельзя добавить в проект.\n\n` +
    "Имя: буквы, цифры, точка, дефис и подчёркивание, без папок.\n" +
    "Расширение: любой текстовый формат данных — " +
    DATA_EXTENSIONS.join(", ") +
    " — либо файл вообще без расширения.\n\n" +
    "Архивы, программы и документы Word/Excel сюда не кладутся: программа " +
    "должна читать данные как текст. Двоичные файлы в проекте появляются " +
    "только тогда, когда их создаёт сама программа."
  );
}

// "Add local file": picks a file off the student's own computer and puts it
// into the project, so a program can read real data. Text only - see
// dataNameMessage for why.
function addLocalFile() {
  if (!isEditable()) return;
  const picker = document.getElementById("local-file-input");
  if (picker) picker.click();
}

async function onLocalFilesChosen(event) {
  const chosen = Array.from(event.target.files || []);
  event.target.value = ""; // picking the same file twice must fire again
  if (chosen.length === 0) return;
  if (!isEditable()) return;

  syncEditorToFile();
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
        `"${filename}" — ${formatSize(file.size)}, это больше ${MAX_DATA_FILE_KB} КБ. ` +
          "Возьмите файл меньше или урежьте данные."
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
    // A file that isn't text comes back with replacement characters; adding it
    // as text would quietly corrupt it.
    if (text.includes("�")) {
      alert(
        `"${filename}" не является текстовым файлом (внутри двоичные данные). ` +
          "В проект можно добавить только текстовые данные."
      );
      continue;
    }

    const existing = projectFiles.find((f) => f.filename === filename);
    if (existing) {
      if (!confirm(`"${filename}" уже есть в проекте. Заменить содержимое?`)) continue;
      existing.content = text;
      existing.encoding = "text";
    } else {
      projectFiles.push({ filename, content: text, encoding: "text" });
    }
    lastAdded = filename;
  }

  if (lastAdded) openFile(lastAdded);
  else renderFileTree();
}

function deleteFile(filename) {
  if (!isEditable()) return;
  if (projectFiles.length <= 1) return;
  if (!confirm(`Удалить ${filename}? Это затронет только несохранённый проект.`)) return;

  projectFiles = projectFiles.filter((f) => f.filename !== filename);
  if (entryJavaFile === filename) entryJavaFile = null;
  if (activeFile === filename) {
    activeFile = (entryFile() || projectFiles[0].filename);
    applyEditorToActiveFile();
  }
  renderFileTree();
}

// Replaces the whole project - used when a saved version is opened.
function loadProject(files, entryFilename) {
  projectFiles = files.map((f) => ({
    filename: f.filename,
    content: f.content,
    encoding: f.encoding === "base64" ? "base64" : "text",
  }));
  entryJavaFile =
    entryFilename && projectFiles.some((f) => f.filename === entryFilename)
      ? entryFilename
      : null;
  activeFile = entryFile() || projectFiles[0].filename;
  applyEditorToActiveFile();
  renderFileTree();
}

// Takes back the data files as the program left them: a file it created
// appears in the tree, one it rewrote is updated, one it deleted goes away.
// This is what makes a two-step lab work - write a file in one run, read it in
// the next - and what gets snapshotted when the version is saved.
function mergeFilesFromRun(files, warnings) {
  if (!Array.isArray(files)) return;
  syncEditorToFile();

  const before = new Map(
    projectFiles.filter((f) => !isJavaFile(f.filename)).map((f) => [f.filename, f])
  );
  const added = [];
  const changed = [];

  for (const file of files) {
    const encoding = file.encoding === "base64" ? "base64" : "text";
    const existing = before.get(file.filename);
    if (!existing) {
      projectFiles.push({ filename: file.filename, content: file.content, encoding });
      added.push(file.filename);
    } else if (existing.content !== file.content || existing.encoding !== encoding) {
      existing.content = file.content;
      existing.encoding = encoding;
      changed.push(file.filename);
    }
    before.delete(file.filename);
  }

  // Whatever is left in `before` was in the working directory when the program
  // started and is not there now - the program deleted it.
  const removed = [...before.keys()];
  if (removed.length > 0) {
    projectFiles = projectFiles.filter((f) => !removed.includes(f.filename));
    if (removed.includes(activeFile)) {
      activeFile = entryFile() || projectFiles[0].filename;
    }
  }

  const parts = [];
  if (added.length) parts.push(`новые: ${added.join(", ")}`);
  if (changed.length) parts.push(`изменены: ${changed.join(", ")}`);
  if (removed.length) parts.push(`удалены: ${removed.join(", ")}`);
  if (parts.length) appendConsole("status", `\n— Файлы проекта (${parts.join("; ")})\n`);
  for (const warning of warnings || []) {
    appendConsole("status", `— ${warning}\n`);
  }

  if (parts.length || (warnings || []).length) {
    applyEditorToActiveFile();
    renderFileTree();
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Handouts the teacher attached to the assignment (PDF, DOCX, ...).
async function loadAssignmentFiles() {
  const { files } = await api(`/api/assignments/${activeAssignment.id}/files`);
  const box = document.getElementById("assignment-files");
  if (!box) return;
  if (!files || files.length === 0) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML =
    `<div class="file-list"><h4>Методички</h4>` +
    files
      .map(
        (f) =>
          `<div class="file-item">
             <a href="/api/assignments/${activeAssignment.id}/files/${f.id}/download">${escapeHtml(f.originalName)}</a>
             <span class="muted">${formatSize(f.size)}</span>
           </div>`
      )
      .join("") +
    `</div>`;
}

// The newest version (the list comes back ordered by version_number DESC).
function latestVersion() {
  return versions.length > 0 ? versions[0] : null;
}

// Only the latest version is editable; older ones are read-only history.
function isEditable() {
  const latest = latestVersion();
  if (!latest) return true; // nothing saved yet - starter code is editable
  return activeVersion !== null && activeVersion.id === latest.id;
}

// ---------------------------------------------------------------------
// Version names
//
// A student may put a name on a version ("цикл наконец работает") so the
// history reads as something other than a list of numbers. The name is typed
// before saving; a draft can also be renamed afterwards.
// ---------------------------------------------------------------------

function versionTitleValue() {
  const box = document.getElementById("version-title");
  return box ? box.value.trim() : "";
}

function setVersionTitleField(value) {
  const box = document.getElementById("version-title");
  if (box) box.value = value || "";
}

// Shows the name next to the number, e.g. v3 «перед сдачей».
function versionLabel(v) {
  return `v${v.version_number}${v.title ? ` «${v.title}»` : ""}`;
}

async function renameVersion() {
  if (!activeVersion) return;
  const button = document.getElementById("rename-version-btn");
  button.disabled = true;
  try {
    const { submission } = await api(`/api/submissions/${activeVersion.id}/title`, {
      method: "PATCH",
      body: JSON.stringify({ title: versionTitleValue() }),
    });
    activeVersion = { ...activeVersion, title: submission.title };
    setVersionTitleField(submission.title);
    await loadVersions();
  } catch (err) {
    alert("Не удалось переименовать версию: " + err.message);
  } finally {
    button.disabled = false;
  }
}

// Loads a version's whole project into the editor and switches edit/read-only
// mode.
async function openVersion(v) {
  setVersionTitleField(v.title);
  // A text answer is a single blob - no editor, no project tree.
  if (assignmentType() === "text") {
    activeVersion = v;
    const box = document.getElementById("text-editor");
    if (box) box.value = v.code || "";
    await loadVersions();
    return;
  }

  await editorReady;
  activeVersion = v;
  try {
    const { files } = await api(`/api/submissions/${v.id}/files`);
    const entry = (files.find((f) => f.isEntry) || files[0] || {}).filename;
    loadProject(files.length ? files : [{ filename: "Main.java", content: v.code }], entry);
  } catch {
    // Fall back to the single-file view rather than leaving the editor blank.
    loadProject([{ filename: "Main.java", content: v.code }], "Main.java");
  }
  renderOutput(v.last_run_stdout, v.last_run_stderr, v.last_run_status);
  await loadVersions();
}

// Reflects the current mode in the UI: Monaco read-only flag, the save/submit
// buttons, and a banner offering a way back to the latest version.
function applyEditMode() {
  const editable = isEditable();
  if (editor) editor.updateOptions({ readOnly: !editable });
  const textBox = document.getElementById("text-editor");
  if (textBox) textBox.readOnly = !editable;
  // The tree shows delete buttons only while the project is editable.
  if (assignmentType() === "code") renderFileTree();

  const saveBtn = document.getElementById("save-draft-btn");
  const submitBtn = document.getElementById("submit-btn");
  if (saveBtn) saveBtn.disabled = !editable;
  if (submitBtn) submitBtn.disabled = !editable;

  // A version's name can still be changed while it is a draft, including an
  // older one - the name is a label, not part of the work.
  const isDraft = !!activeVersion && activeVersion.status === "draft";
  const renameBtn = document.getElementById("rename-version-btn");
  const titleBox = document.getElementById("version-title");
  if (renameBtn) renameBtn.hidden = !isDraft;
  if (titleBox) titleBox.disabled = !editable && !isDraft;

  const banner = document.getElementById("readonly-banner");
  if (!banner) return;
  if (editable) {
    banner.innerHTML = "";
    return;
  }
  const latest = latestVersion();
  banner.innerHTML = `<p class="muted" style="font-size:12px">
      Открыта версия v${activeVersion.version_number} — старые версии доступны только для чтения.
      Чтобы продолжить работу, вернитесь к v${latest.version_number}.
    </p>
    <button class="secondary" id="back-to-latest-btn">К последней версии (v${latest.version_number})</button>`;
  document.getElementById("back-to-latest-btn").onclick = () => openVersion(latest);
}

async function loadVersions() {
  const { submissions } = await api(`/api/submissions/assignment/${activeAssignment.id}`);
  versions = submissions;

  // On first load, start the student off on their latest version rather than
  // the starter code - that's the only version they're allowed to build on.
  if (!activeVersion && versions.length > 0 && assignmentType() === "text") {
    const latest = latestVersion();
    activeVersion = latest;
    setVersionTitleField(latest.title);
    const box = document.getElementById("text-editor");
    if (box) box.value = latest.code || "";
  } else if (!activeVersion && versions.length > 0) {
    const latest = latestVersion();
    await editorReady;
    activeVersion = latest;
    setVersionTitleField(latest.title);
    try {
      const { files } = await api(`/api/submissions/${latest.id}/files`);
      const entry = (files.find((f) => f.isEntry) || files[0] || {}).filename;
      loadProject(
        files.length ? files : [{ filename: "Main.java", content: latest.code }],
        entry
      );
    } catch {
      loadProject([{ filename: "Main.java", content: latest.code }], "Main.java");
    }
    renderOutput(latest.last_run_stdout, latest.last_run_stderr, latest.last_run_status);
  }

  const list = document.getElementById("version-list");
  if (!list) return;
  applyEditMode();
  if (versions.length === 0) {
    list.innerHTML = '<p class="muted">Сохранённых версий пока нет.</p>';
    return;
  }
  list.innerHTML = "";
  versions.forEach((v, idx) => {
    const div = document.createElement("div");
    div.className = "version-item" + (activeVersion && activeVersion.id === v.id ? " active" : "");
    const tag = idx === 0 ? " — последняя" : " — только чтение";
    div.textContent = `${versionLabel(v)} — ${versionStatusLabel(v.status)} — ${new Date(
      v.created_at
    ).toLocaleString()}${tag}`;
    div.onclick = () => openVersion(v);
    list.appendChild(div);
  });
}

// Shows the recorded result of a saved version, or a compile error.
//
// Writes into the transcript span rather than replacing the panel: the live
// console's input field lives inside this same panel, and clearing its
// innerHTML would delete it - leaving a run with nowhere to print and nowhere
// to type.
function renderOutput(stdout, stderr, status) {
  const panel = document.getElementById("output-panel");
  const target = document.getElementById("terminal-text");
  if (!panel || !target) return;

  const hasError = stderr && stderr.trim().length > 0;
  panel.className = "output-panel terminal" + (hasError ? " error" : "");

  target.textContent = "";
  const statusLine = document.createElement("div");
  statusLine.className = "status-line";
  statusLine.textContent = `Статус: ${runStatusLabel(status)}`;
  target.appendChild(statusLine);
  const body = document.createElement("div");
  body.textContent = (stdout || "") + (stderr ? "\n" + stderr : "") || "(no output)";
  target.appendChild(body);
}

// ---------------------------------------------------------------------
// Running the program interactively
//
// The program stays alive while it runs: output appears as it is printed and
// the student types values when the program asks for them, exactly like a
// console. Anything in the "prepared input" box is sent the moment it starts.
// ---------------------------------------------------------------------

// Appends a chunk to the console transcript, keeping it scrolled to the end.
function appendConsole(type, text) {
  const panel = document.getElementById("output-panel");
  const target = document.getElementById("terminal-text");
  if (!panel || !target) return;
  const span = document.createElement("span");
  span.className = `console-${type}`;
  span.textContent = text;
  target.appendChild(span);
  panel.scrollTop = panel.scrollHeight;
}

function setConsoleRunning(running) {
  const line = document.getElementById("console-line");
  const stop = document.getElementById("console-stop");
  const btn = document.getElementById("run-btn");
  if (line) {
    line.hidden = !running;
    if (running) {
      line.value = "";
      line.focus();
    }
  }
  if (stop) stop.hidden = !running;
  if (btn) {
    btn.disabled = running;
    btn.textContent = running ? "Выполняется…" : "▶ Запустить";
  }
}

function closeRunStream() {
  if (runStream) {
    runStream.close();
    runStream = null;
  }
  runSessionId = null;
}

async function runCode() {
  await editorReady;
  syncEditorToFile();
  closeRunStream();

  const panel = document.getElementById("output-panel");
  const target = document.getElementById("terminal-text");
  if (panel) panel.className = "output-panel terminal";
  if (target) target.textContent = "";
  // Everything typed during this run becomes the input the submitted version
  // is replayed with, so the teacher sees the same result.
  typedThisRun = [];
  setConsoleRunning(true);

  const entry = entryFile();
  if (!entry) {
    setConsoleRunning(false);
    renderOutput("", "В проекте нет файла .java, который можно запустить.", "Error");
    return;
  }

  let started;
  try {
    started = await api("/api/submissions/interactive", {
      method: "POST",
      // Every .java file is compiled; the entry one holds main(). Data files
      // travel with it and become the program's working directory.
      // assignmentId lets the server decide whether this run may reach the
      // file mirror - the permission lives on the assignment, not here.
      body: JSON.stringify({
        files: projectFiles,
        entry,
        assignmentId: activeAssignment ? activeAssignment.id : null,
      }),
    });
  } catch (err) {
    setConsoleRunning(false);
    renderOutput("", err.message, "Error");
    return;
  }

  // A program that doesn't compile never starts - show the errors as before.
  if (started.compileFailed) {
    setConsoleRunning(false);
    const r = started.result;
    renderOutput(r.stdout, r.stderr || r.compileOutput, r.status);
    return;
  }

  runSessionId = started.sessionId;
  runStream = new EventSource(`/api/submissions/interactive/${runSessionId}/stream`);

  runStream.onmessage = (event) => {
    const chunk = JSON.parse(event.data);
    if (chunk.type === "exit") {
      appendConsole("status", `\n— ${chunk.text}\n`);
      // Files the program wrote come with the exit event.
      mergeFilesFromRun(chunk.files, chunk.warnings);
      closeRunStream();
      setConsoleRunning(false);
      return;
    }
    appendConsole("output", chunk.text);
  };

  runStream.onerror = () => {
    // The stream ends on its own when the program exits; anything else means
    // the connection dropped.
    if (runSessionId) {
      appendConsole("status", "\n— Соединение с программой потеряно.\n");
      closeRunStream();
      setConsoleRunning(false);
    }
  };

}

async function sendConsoleLine(text) {
  if (!runSessionId) return;
  typedThisRun.push(text);
  try {
    await api(`/api/submissions/interactive/${runSessionId}/input`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    appendConsole("status", `\n— ${err.message}\n`);
  }
}

async function stopRun() {
  if (!runSessionId) return;
  try {
    await api(`/api/submissions/interactive/${runSessionId}/stop`, { method: "POST" });
  } catch {
    // The run may have finished on its own between click and request.
  }
}

async function saveVersion(status) {
  const isText = assignmentType() === "text";
  if (!isText) await editorReady;
  if (!isEditable()) {
    alert("Это старая версия, её нельзя сохранить или сдать. Сначала вернитесь к последней версии.");
    return;
  }
  if (isText && textAnswer().trim() === "") {
    alert("Напишите ответ, прежде чем сохранять.");
    return;
  }
  if (!isText) syncEditorToFile();
  const btn = status === "submitted" ? document.getElementById("submit-btn") : document.getElementById("save-draft-btn");
  btn.disabled = true;
  try {
    const { submission } = await api(`/api/submissions/assignment/${activeAssignment.id}`, {
      method: "POST",
      body: JSON.stringify({
        // A text answer travels as a single blob; code sends the project
        // together with the console input it should be run against.
        ...(isText
          ? { code: textAnswer() }
          : {
              files: projectFiles,
              entry: entryFile() || activeFile,
              stdin: consoleInput(),
            }),
        status,
        // Optional name for this version, shown in the history instead of a
        // bare number.
        title: versionTitleValue(),
        // Tells the server which version this edit is based on; it rejects
        // anything that isn't the latest one.
        baseVersionId: activeVersion ? activeVersion.id : null,
      }),
    });
    activeVersion = submission;
    setVersionTitleField(submission.title);
    if (!isText) {
      renderOutput(
        submission.last_run_stdout,
        submission.last_run_stderr,
        submission.last_run_status
      );
    }
    await loadVersions();
    // Submitting clears the deadline warning, so refresh what depends on it.
    if (status === "submitted") await refreshDeadlineState();
  } catch (err) {
    alert("Не удалось сохранить: " + err.message);
    await loadVersions(); // re-sync in case another tab added a newer version
  } finally {
    applyEditMode();
  }
}

async function loadDiscussion() {
  const { messages } = await api(`/api/discussions/assignment/${activeAssignment.id}`);
  const list = document.getElementById("discussion-list");
  if (!list) return;
  list.innerHTML = "";
  if (messages.length === 0) {
    list.innerHTML = '<p class="muted">Сообщений пока нет. Задайте вопрос или оставьте заметку о своей работе.</p>';
    return;
  }
  messages.forEach((m) => {
    const div = document.createElement("div");
    div.className = "message " + (m.authorRole === "teacher" ? "teacher" : "student");
    let linked = "";
    if (m.linkedVersion) {
      linked = `<span class="linked-version" data-submission="${m.submission_id}">→ к версии v${m.linkedVersion}</span>`;
    }
    // A student may delete only their own messages.
    const canDelete = currentUser && m.author_id === currentUser.id;
    const deleteBtn = canDelete
      ? `<button class="delete-message" data-message="${m.id}" title="Удалить сообщение">×</button>`
      : "";
    div.innerHTML = `<div class="meta">${escapeHtml(m.authorName)} · ${new Date(m.created_at).toLocaleString()}${deleteBtn}</div>
      <div class="body">${escapeHtml(m.body)}</div>${linked}`;
    list.appendChild(div);
  });
  list.scrollTop = list.scrollHeight;

  list.querySelectorAll(".delete-message").forEach((el) => {
    el.onclick = async () => {
      if (!confirm("Удалить сообщение? Это действие нельзя отменить.")) return;
      try {
        await api(`/api/discussions/messages/${el.dataset.message}`, { method: "DELETE" });
        await loadDiscussion();
      } catch (err) {
        alert("Не удалось удалить сообщение: " + err.message);
      }
    };
  });

  list.querySelectorAll(".linked-version").forEach((el) => {
    el.onclick = async () => {
      const subId = parseInt(el.dataset.submission, 10);
      const v = versions.find((x) => x.id === subId);
      if (v) await openVersion(v); // may switch the editor to read-only mode
    };
  });
}

async function sendMessage() {
  const input = document.getElementById("message-input");
  const body = input.value.trim();
  if (!body) return;
  try {
    await api(`/api/discussions/assignment/${activeAssignment.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body, submissionId: activeVersion ? activeVersion.id : null }),
    });
    input.value = "";
    await loadDiscussion();
  } catch (err) {
    alert("Не удалось отправить сообщение: " + err.message);
  }
}


// ---------- Page start-up ----------
//
// The student's side is two pages - the dashboard and one assignment's working
// screen - and both load this file plus a small script of their own. What they
// share happens here: who is logged in, the sidebar, the announcement banners
// and the Log out button.

async function initStudentPage({ withEditor = false } = {}) {
  if (withEditor) initEditor();

  const logout = document.getElementById("logout-btn");
  if (logout) {
    logout.onclick = async () => {
      await api("/api/auth/logout", { method: "POST" });
      window.location.href = "/login.html";
    };
  }

  await loadMe();
  await loadAssignments();
  // ui.js already asked for these on load; this call is what reliably fills
  // the sidebar list, whose renderer is defined in this file.
  await loadNotifications();
  // Does the course collect edit data, and how often? Off by default, so
  // this usually sets a flag and stops there.
  await loadEditCaptureConfig();
}
