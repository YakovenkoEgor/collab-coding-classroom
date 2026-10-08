// Behaviour shared by the student and teacher dashboards: a code editor whose
// height the user can drag, and the rule that opening something puts the
// reader back at the top of the page.

// ---------------------------------------------------------------------
// Resizable editor
//
// The .editor-layout element owns the height; the file tree and the Monaco
// container inside it fill whatever it is given (see style.css). Monaco is
// created with automaticLayout, so it follows the container by itself.
// The chosen height is remembered per browser, so it survives switching
// assignments and reloading the page.
// ---------------------------------------------------------------------

const EDITOR_HEIGHT_KEY = "classroom.editorHeight";
const DEFAULT_EDITOR_HEIGHT = 420;
const MIN_EDITOR_HEIGHT = 200;
const MAX_EDITOR_HEIGHT = 1400;

function clampEditorHeight(px) {
  return Math.min(MAX_EDITOR_HEIGHT, Math.max(MIN_EDITOR_HEIGHT, Math.round(px)));
}

// Private browsing and blocked site data make localStorage throw, so a saved
// height is a convenience, never a requirement.
function storedEditorHeight() {
  try {
    const saved = parseInt(localStorage.getItem(EDITOR_HEIGHT_KEY), 10);
    return Number.isFinite(saved) ? clampEditorHeight(saved) : DEFAULT_EDITOR_HEIGHT;
  } catch {
    return DEFAULT_EDITOR_HEIGHT;
  }
}

function rememberEditorHeight(px) {
  try {
    localStorage.setItem(EDITOR_HEIGHT_KEY, String(px));
  } catch {
    // Nothing to do - the height still applies for this page.
  }
}

function applyEditorHeight(layout, px) {
  const height = clampEditorHeight(px);
  layout.style.setProperty("--editor-height", `${height}px`);
  return height;
}

// ---------------------------------------------------------------------
// Resizable file tree
//
// The same idea applied the other way round: a grip between the tree and the
// editor sets how the width is split between them.
// ---------------------------------------------------------------------

const TREE_WIDTH_KEY = "classroom.treeWidth";
const DEFAULT_TREE_WIDTH = 190;
const MIN_TREE_WIDTH = 110;
// The editor keeps at least this much, so dragging the tree wide can never
// squeeze the code out of sight.
const MIN_EDITOR_WIDTH = 220;

// Whichever pane sits next to the tree: the editor, or the note that replaces
// it when the open file is binary.
function visiblePane(layout) {
  return Array.from(layout.children).find(
    (el) => !el.classList.contains("file-tree") && !el.classList.contains("tree-resizer") && !el.hidden
  );
}

// The tree may grow by exactly as much as the pane next to it can give up.
// Measuring the pane rather than the whole layout keeps the grip itself and
// the gaps out of the arithmetic - they would otherwise be counted as room
// the editor has, and the editor would end up narrower than the minimum.
function clampTreeWidth(layout, px) {
  const wanted = Math.max(MIN_TREE_WIDTH, Math.round(px));
  const tree = layout.querySelector(".file-tree");
  const pane = visiblePane(layout);
  // Nothing is laid out yet (the card was just built): take the value as is;
  // the next call, during a drag, will clamp it.
  if (!tree || !pane || layout.clientWidth === 0) return wanted;

  const current = tree.getBoundingClientRect().width;
  const spare = pane.getBoundingClientRect().width - MIN_EDITOR_WIDTH;
  const max = Math.max(MIN_TREE_WIDTH, current + spare);
  return Math.min(max, wanted);
}

function storedTreeWidth() {
  try {
    const saved = parseInt(localStorage.getItem(TREE_WIDTH_KEY), 10);
    return Number.isFinite(saved) ? saved : DEFAULT_TREE_WIDTH;
  } catch {
    return DEFAULT_TREE_WIDTH;
  }
}

function rememberTreeWidth(px) {
  try {
    localStorage.setItem(TREE_WIDTH_KEY, String(px));
  } catch {
    // Nothing to do - the width still applies for this page.
  }
}

function applyTreeWidth(layout, px) {
  const width = clampTreeWidth(layout, px);
  layout.style.setProperty("--tree-width", `${width}px`);
  return width;
}

function addTreeResizer(layout) {
  const tree = layout.querySelector(".file-tree");
  if (!tree) return;
  applyTreeWidth(layout, storedTreeWidth());

  const grip = document.createElement("div");
  grip.className = "tree-resizer";
  grip.title = "Потяните, чтобы изменить ширину дерева проекта (двойной клик — вернуть обычную)";
  tree.after(grip);

  grip.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    try {
      grip.setPointerCapture(event.pointerId);
    } catch {
      // See the height grip: capture is a convenience, not a requirement.
    }
    const startX = event.clientX;
    const startWidth = tree.getBoundingClientRect().width;

    const onMove = (move) => {
      rememberTreeWidth(applyTreeWidth(layout, startWidth + (move.clientX - startX)));
    };
    const onUp = () => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
    };

    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  });

  grip.addEventListener("dblclick", () => {
    rememberTreeWidth(applyTreeWidth(layout, DEFAULT_TREE_WIDTH));
  });
}

// Gives an .editor-layout a grip underneath that drags its height, and one
// between the file tree and the editor that drags the width between them.
function makeEditorResizable(layout) {
  if (!layout || layout.dataset.resizable === "1") return;
  layout.dataset.resizable = "1";
  layout.classList.add("resizable");
  applyEditorHeight(layout, storedEditorHeight());
  addTreeResizer(layout);

  const grip = document.createElement("div");
  grip.className = "editor-resizer";
  grip.title = "Потяните, чтобы изменить высоту редактора (двойной клик — вернуть обычную)";
  layout.after(grip);

  grip.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    // Capture keeps the drag alive when the pointer leaves the thin grip -
    // including when it passes over the editor, which swallows plain events.
    try {
      grip.setPointerCapture(event.pointerId);
    } catch {
      // Some pointer sources refuse capture; the drag still works, it just
      // ends if the pointer wanders off the grip.
    }
    const startY = event.clientY;
    const startHeight = layout.getBoundingClientRect().height;

    const onMove = (move) => {
      rememberEditorHeight(
        applyEditorHeight(layout, startHeight + (move.clientY - startY))
      );
    };
    const onUp = () => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
    };

    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  });

  grip.addEventListener("dblclick", () => {
    rememberEditorHeight(applyEditorHeight(layout, DEFAULT_EDITOR_HEIGHT));
  });
}

// ---------------------------------------------------------------------
// Collapsible sidebar
//
// The arrow next to the first heading folds the whole panel away, leaving a
// strip just wide enough to hold the arrow itself - so a long assignment or
// class list can be put aside while reading code. The choice is remembered
// per browser.
// ---------------------------------------------------------------------

const SIDEBAR_KEY = "classroom.sidebarCollapsed";

function setSidebarCollapsed(collapsed) {
  const layout = document.querySelector(".layout");
  const toggle = document.getElementById("sidebar-toggle");
  if (!layout || !toggle) return;

  layout.classList.toggle("sidebar-collapsed", collapsed);
  // ‹ folds it away, › brings it back - the arrow points where it goes.
  toggle.textContent = collapsed ? "›" : "‹";
  toggle.title = collapsed ? "Показать панель" : "Свернуть панель";
  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  } catch {
    // Remembering it is a nicety; the toggle itself still works.
  }
}

function setupSidebarToggle() {
  const toggle = document.getElementById("sidebar-toggle");
  if (!toggle) return;
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    collapsed = false;
  }
  setSidebarCollapsed(collapsed);
  toggle.onclick = () => {
    const layout = document.querySelector(".layout");
    setSidebarCollapsed(!(layout && layout.classList.contains("sidebar-collapsed")));
  };
}

setupSidebarToggle();

// ---------------------------------------------------------------------
// Back to the top when something is opened
//
// Both dashboards replace the whole main panel on a click. Without this, a
// teacher who scrolled to the end of a long class list and clicked a student
// would land halfway down the new page and have to scroll back up.
// ---------------------------------------------------------------------

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: "auto" });
  // The panels are scroll containers of their own on short viewports.
  document.querySelectorAll(".main, .sidebar").forEach((box) => {
    box.scrollTop = 0;
  });
}

// Clicks that open something new, as opposed to clicks that work inside what
// is already open (typing in the editor, picking a file, deleting a message).
const NAVIGATION_SELECTOR = [
  ".assignment-item", // an assignment or a student in the sidebar
  "tr.student-row", // a row in a roster or profile table
  ".version-item", // a saved version
  ".linked-version", // "→ referring to v2" in the discussion
  "#back-to-overview",
  "#new-assignment-btn",
  "#edit-assignment-btn",
].join(", ");

// Capture phase: the handlers that repaint the panel run afterwards, so the
// scroll happens before the new content lands rather than fighting it.
document.addEventListener(
  "click",
  (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest(NAVIGATION_SELECTOR)) {
      scrollToTop();
    }
  },
  true
);
