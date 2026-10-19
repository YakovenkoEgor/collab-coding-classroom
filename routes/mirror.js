// The file mirror the sandbox can download from.
//
// The teacher uploads text files here and hands out their URLs; a run of an
// assignment with network access switched on can fetch them over HTTP. See
// mirror.js for what that network does and does not reach.

const express = require("express");
const { requireLogin, requireRole } = require("../middleware/auth");
const mirror = require("../mirror");

const router = express.Router();

// Everyone who is logged in needs the list: a student has to know what is
// available and under which URL. Uploading and deleting is the teacher's.
router.get("/", requireLogin, (req, res) => {
  res.json({
    baseUrl: mirror.BASE_URL,
    hostname: mirror.HOSTNAME,
    files: mirror.listFiles(),
    maxFiles: mirror.MAX_FILES,
    maxBytes: mirror.MAX_FILE_BYTES,
  });
});

// Whether the serving container is actually up. Kept separate from the list
// because it asks Docker, which the plain list never needs to do.
router.get("/status", requireLogin, requireRole("teacher"), async (req, res) => {
  try {
    res.json(await mirror.status());
  } catch (err) {
    res.status(502).json({ error: `Не удалось опросить зеркало: ${err.message}` });
  }
});

router.post("/", requireLogin, requireRole("teacher"), (req, res) => {
  try {
    const stored = mirror.storeFiles(req.body.files);
    res.json({ files: stored, all: mirror.listFiles() });
  } catch (err) {
    if (err instanceof mirror.MirrorError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});

// Starting the mirror by hand. Runs do it themselves, but a teacher who is
// setting an assignment up wants to see that it works before the lesson.
router.post("/start", requireLogin, requireRole("teacher"), async (req, res) => {
  try {
    await mirror.ensureUp();
    res.json(await mirror.status());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post("/stop", requireLogin, requireRole("teacher"), async (req, res) => {
  try {
    await mirror.stop();
    res.json(await mirror.status());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// The file name itself is the id here, because the name is what the URL
// carries - that is the whole point of the mirror.
router.delete("/:filename", requireLogin, requireRole("teacher"), (req, res) => {
  try {
    mirror.removeFile(req.params.filename);
    res.json({ files: mirror.listFiles() });
  } catch (err) {
    if (err instanceof mirror.MirrorError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});

module.exports = router;
