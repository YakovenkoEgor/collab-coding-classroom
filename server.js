require("dotenv").config();
const crypto = require("crypto");
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

// Set NODE_ENV=production when the app is reachable from the internet. It
// turns on the two things that only make sense behind a TLS proxy: trusting
// the proxy's headers, and marking the session cookie as HTTPS-only.
const isProduction = process.env.NODE_ENV === "production";

// ---------------------------------------------------------------------
// Session secret
//
// The cookie is signed with this. A known value means anyone who has it can
// forge a session - including a teacher's - so a fixed fallback baked into
// the source would be an open door once the app is public. In production it
// has to be provided; locally we generate a throwaway one per start (which
// simply logs everyone out when the server restarts).
// ---------------------------------------------------------------------
const sessionSecret = process.env.SESSION_SECRET;
if (isProduction && (!sessionSecret || sessionSecret.length < 16)) {
  console.error(
    "\nSESSION_SECRET is missing (or too short) and NODE_ENV=production.\n" +
      "Put a long random value in .env before exposing the app, e.g.:\n" +
      "  node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"\n"
  );
  process.exit(1);
}
const secret = sessionSecret || crypto.randomBytes(48).toString("hex");
if (!sessionSecret) {
  console.warn(
    "[auth] SESSION_SECRET not set - using a temporary one; sessions end when the server restarts."
  );
}

// Behind a reverse proxy (Caddy/nginx) Express only learns the request was
// HTTPS from X-Forwarded-Proto. Without this, secure cookies are never sent.
if (isProduction) app.set("trust proxy", 1);

// Assignment handouts are uploaded as base64 inside the JSON body, so the
// limit has to cover a batch of files plus ~33% encoding overhead.
app.use(express.json({ limit: "60mb" }));
app.use(
  session({
    secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
      httpOnly: true,
      // Only ever sent over HTTPS in production. COOKIE_SECURE=false is an
      // escape hatch for the odd case of production behind plain HTTP.
      secure: isProduction && process.env.COOKIE_SECURE !== "false",
      // Blocks the cookie from riding along with cross-site requests, which
      // is what a CSRF attempt looks like.
      sameSite: "lax",
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
