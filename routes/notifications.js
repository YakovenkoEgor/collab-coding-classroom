// Class-wide announcements.
//
// The teacher writes a notification and says how long it stays up; every
// student sees it as a banner above the working area until then. A student can
// close a banner, and it stays closed for the rest of their session - the
// dismissed ids live in the session itself, so logging out (or coming back
// tomorrow) brings a still-active notification back.

const express = require("express");
const db = require("../db/database");
const { requireLogin, requireRole } = require("../middleware/auth");
const { normalizeDeadline, DeadlineError } = require("../deadlines");

const router = express.Router();

const MAX_BODY = 2000;

function readBody(raw) {
  const body = String(raw === undefined || raw === null ? "" : raw).trim();
  if (body === "") throw new DeadlineError("Notification text is required");
  if (body.length > MAX_BODY) {
    throw new DeadlineError(`Notification text is longer than ${MAX_BODY} characters`);
  }
  return body;
}

function readActiveUntil(raw) {
  const activeUntil = normalizeDeadline(raw);
  if (!activeUntil) {
    throw new DeadlineError("Say until when the notification stays active");
  }
  return activeUntil;
}

// Ids this session has closed. Kept on the session rather than in the
// browser, so "until the end of the session" means the same thing in every
// tab, and so a fresh login starts clean.
function dismissedIds(req) {
  if (!Array.isArray(req.session.dismissedNotifications)) {
    req.session.dismissedNotifications = [];
  }
  return req.session.dismissedNotifications;
}

function activeRows() {
  return db
    .prepare(
      `SELECT id, body, active_until AS activeUntil, created_at AS createdAt
       FROM notifications
       WHERE active_until > datetime('now', 'localtime')
       ORDER BY created_at DESC`
    )
    .all();
}

// What a student's screen needs: everything still active, with the ones they
// closed this session marked rather than removed - the sidebar list keeps
// showing them, only the banner goes away.
router.get("/", requireLogin, (req, res) => {
  const dismissed = dismissedIds(req);
  res.json({
    notifications: activeRows().map((row) => ({
      ...row,
      dismissed: dismissed.includes(row.id),
    })),
  });
});

// Teacher-only: the whole list, expired ones included.
router.get("/all", requireLogin, requireRole("teacher"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT n.id, n.body, n.active_until AS activeUntil, n.created_at AS createdAt,
              u.display_name AS authorName,
              CASE WHEN n.active_until > datetime('now', 'localtime') THEN 1 ELSE 0 END AS active
       FROM notifications n
       LEFT JOIN users u ON u.id = n.created_by
       -- Active ones first, newest first within each group: what the teacher
       -- just wrote is what they are most likely looking for.
       ORDER BY active DESC, n.created_at DESC`
    )
    .all();
  res.json({ notifications: rows.map((r) => ({ ...r, active: !!r.active })) });
});

router.post("/", requireLogin, requireRole("teacher"), (req, res) => {
  let body;
  let activeUntil;
  try {
    body = readBody(req.body.body);
    activeUntil = readActiveUntil(req.body.activeUntil);
  } catch (err) {
    if (err instanceof DeadlineError) return res.status(400).json({ error: err.message });
    throw err;
  }

  const info = db
    .prepare(
      `INSERT INTO notifications (body, active_until, created_by) VALUES (?, ?, ?)`
    )
    .run(body, activeUntil, req.session.user.id);

  res.json({
    notification: db
      .prepare(
        `SELECT id, body, active_until AS activeUntil, created_at AS createdAt
         FROM notifications WHERE id = ?`
      )
      .get(info.lastInsertRowid),
  });
});

router.put("/:id", requireLogin, requireRole("teacher"), (req, res) => {
  const existing = db
    .prepare("SELECT id FROM notifications WHERE id = ?")
    .get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Notification not found" });

  let body;
  let activeUntil;
  try {
    body = readBody(req.body.body);
    activeUntil = readActiveUntil(req.body.activeUntil);
  } catch (err) {
    if (err instanceof DeadlineError) return res.status(400).json({ error: err.message });
    throw err;
  }

  db.prepare("UPDATE notifications SET body = ?, active_until = ? WHERE id = ?").run(
    body,
    activeUntil,
    existing.id
  );
  res.json({ ok: true });
});

router.delete("/:id", requireLogin, requireRole("teacher"), (req, res) => {
  db.prepare("DELETE FROM notifications WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Closing a banner. Unknown or expired ids are accepted silently: the student
// is only ever saying "don't show me this again", and refusing that because
// the notification has just expired would be pointless noise.
router.post("/:id/dismiss", requireLogin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Bad notification id" });
  const dismissed = dismissedIds(req);
  if (!dismissed.includes(id)) dismissed.push(id);
  res.json({ ok: true });
});

module.exports = router;
