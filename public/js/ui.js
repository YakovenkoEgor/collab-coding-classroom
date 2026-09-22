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

// Gives an .editor-layout a grip underneath that drags its height.
function makeEditorResizable(layout) {
  if (!layout || layout.dataset.resizable === "1") return;
  layout.dataset.resizable = "1";
  layout.classList.add("resizable");
  applyEditorHeight(layout, storedEditorHeight());

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
