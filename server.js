require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");

const authRoutes = require("./routes/auth");
const assignmentRoutes = require("./routes/assignments");
const submissionRoutes = require("./routes/submissions");
const discussionRoutes = require("./routes/discussions");
const gradeRoutes = require("./routes/grades");
const uploadRoutes = require("./routes/uploads");

const app = express();

// Assignment handouts are uploaded as base64 inside the JSON body, so the
// limit has to cover a batch of files plus ~33% encoding overhead.
app.use(express.json({ limit: "60mb" }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
      httpOnly: true,
    },
  })
);

app.use("/api/auth", authRoutes);
app.use("/api/assignments", assignmentRoutes);
app.use("/api/submissions", submissionRoutes);
app.use("/api/discussions", discussionRoutes);
app.use("/api/grades", gradeRoutes);
app.use("/api/uploads", uploadRoutes);

app.use(express.static(path.join(__dirname, "public")));

// Fallback: send login page for any unmatched route (simple SPA-ish behavior)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Keep failures as JSON - an oversized upload otherwise returns Express's
// HTML error page, which the frontend can't parse into a message.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Upload is too large" });
  }
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Java Classroom running at http://localhost:${PORT}`);
});
