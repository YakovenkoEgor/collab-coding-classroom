// What the browser contributes to the process log.
//
// Everything else is logged where it happens on the server. Edits are the
// exception: they happen in the editor, and only the browser knows about
// them. The editor asks here whether to report them at all, and how often.
//
// This is off unless PROGSNAP_EDIT_CAPTURE=on, because an edit log grows
// fast: one snapshot per student per interval, for the whole lesson.

const express = require("express");
const db = require("../db/database");
const { requireLogin, requireRole } = require("../middleware/auth");
const progsnap = require("../progsnap");

const router = express.Router();

// How many files one editor may report in a single snapshot - the same cap
// the project itself has.
const MAX_FILES = 20;

// The browser's clock is the student's clock and can be anything at all. A
// timestamp more than a day away from the server's is dropped rather than
// stored, so an analysis is never handed a 1970 or a 2031.
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

function clientTimestamp(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  if (Math.abs(when - Date.now()) > MAX_CLOCK_SKEW_MS) return null;
  return new Date(when).toISOString().replace("T", " ").slice(0, 19);
}

// The editor reads this on load: whether to report edits, and the shortest
// gap between reports it is allowed to use.
router.get("/config", requireLogin, (req, res) => {
  res.json(progsnap.config());
});

// Server-side floor on the reporting rate, per student. The browser is asked
// to keep to the interval; this makes sure it does, whatever it sends.
const lastEditAt = new Map();

router.post("/edit", requireLogin, requireRole("student"), (req, res) => {
  const cfg = progsnap.config();
  if (!cfg.enabled || !cfg.editCapture) {
    // Not an error: the editor may be running from a cached page that still
    // thinks capture is on.
    return res.json({ logged: false, reason: "capture is off" });
  }

  const studentId = req.session.user.id;
  const now = Date.now();
  const previous = lastEditAt.get(studentId) || 0;
  if (now - previous < cfg.editIntervalSeconds * 1000) {
    return res.json({ logged: false, reason: "too soon" });
  }

  const files = Array.isArray(req.body.files) ? req.body.files.slice(0, MAX_FILES) : [];
  if (files.length === 0) return res.json({ logged: false, reason: "nothing to record" });

  const assignmentId = parseInt(req.body.assignmentId, 10);
  const assignment = Number.isNaN(assignmentId)
    ? null
    : db.prepare("SELECT id FROM assignments WHERE id = ?").get(assignmentId);

  const codeStateId = progsnap.recordCodeState(files, req.body.entry);
  const eventId = progsnap.logEvent({
    eventType: progsnap.EventType.FILE_EDIT,
    subjectId: studentId,
    sessionId: req.sessionID,
    assignmentId: assignment ? assignment.id : null,
    codeStateId,
    // Which file was being edited when the snapshot was taken.
    codeStateSection: typeof req.body.filename === "string" ? req.body.filename : null,
    clientTimestamp: clientTimestamp(req.body.clientTimestamp),
    // The snapshot covers everything typed since the last one, so the edit
    // is a span of work rather than a single keystroke.
    editType: "GenericEdit",
  });

  lastEditAt.set(studentId, now);
  res.json({ logged: eventId !== null });
});

module.exports = router;
