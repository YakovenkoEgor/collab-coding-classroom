# Java Classroom

A small classroom app: students write, compile, run, and submit versioned
Java code; teachers review it, grade it, and hold a full discussion thread
with students that can point at specific code versions.

## How it's built (so you can maintain it)

- **Backend**: Node.js + Express. All server code is in `server.js` and `routes/`.
- **Database**: SQLite (via `better-sqlite3`), stored in a single file
  `classroom.db` that's created automatically the first time you run the app.
  No separate database server to install.
- **Frontend**: Plain HTML/CSS/JS in `public/` — no build step, no framework.
  The code editor is [Monaco](https://microsoft.github.io/monaco-editor/)
  (the editor VS Code uses), loaded from a CDN.
- **Code execution**: a small built-in sandbox (`sandbox.js`) that compiles
  and runs each submission inside a throwaway Docker container — no
  network access, and hard limits on memory, CPU, and process count. Each
  run is two `docker run` calls (compile, then execute) against the
  official `openjdk` image; the container is destroyed immediately after.
  This needs nothing but Docker itself — no Redis, no separate database,
  no third-party API or account.

## Setup

### 1. Install Node.js

You need Node.js 18+ installed. Check with `node -v`. If you don't have it,
get it from [nodejs.org](https://nodejs.org/).

### 2. Install dependencies

```bash
cd java-classroom
npm install
```

### 3. Make sure Docker is installed and running

That's it — no account, no API key, no separate services to configure.
The sandbox (`sandbox.js`) shells out to `docker run` directly. Docker
Desktop (Windows/Mac) or Docker Engine (Linux) both work.

The first time you run code, Docker will pull the `eclipse-temurin:21-jdk`
image (a few hundred MB, one-time download); after that it's cached
locally and runs are fast.

You can sanity-check Docker works with:

```bash
docker run --rm eclipse-temurin:21-jdk java -version
```

### 4. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in `SESSION_SECRET` (any random string). The
sandbox settings (`SANDBOX_*`) are optional — sensible defaults are
used if you leave them commented out.

### 5. Create your teacher account and sample data

```bash
npm run seed
```

This creates:
- Teacher: `teacher` / `teacher123`
- Sample students: `student1` / `student123`, `student2` / `student123`

**Change these passwords or edit `scripts/seed.js` before real use.**

### 6. Run it

```bash
npm start
```

Visit http://localhost:3000

## Using the app

### As the teacher

1. Log in, click **+ New assignment**, give it a title, description, and
   optional starter code.
2. Click **+ Add student** in the sidebar to create accounts — give each
   student their username/password directly (there's no self-signup, by
   design, so you control who's in your class).
3. Click an assignment to see every student's latest submission status.
4. Click a student's row to see their full version history, view any
   version's code and output, leave a grade, and hold a discussion thread.

### As a student

1. Log in, pick an assignment from the sidebar.
2. Write code in the editor (must have a `public class Main`), click
   **Run** to compile and test it (doesn't save anything).
3. **Save draft** to save your progress as a version without marking it
   done; **Submit** to mark a version as your submission for grading.
4. Every save creates a new version — nothing is overwritten, so you and
   your teacher can always look back at earlier attempts.
5. Use the discussion box to ask questions. Whichever version is currently
   loaded in your editor gets linked to your next message automatically,
   so your teacher can jump straight to the code you're asking about.

## Known limitations / things to improve next

- **No automated test cases** — by design, per your requirements. Grading
  is fully manual.
- **Single Java class per submission** — the current editor assumes one
  file (`Main.java`). Multi-file submissions would need changes to both
  the editor and `sandbox.js` (which currently always compiles a single
  `Main.java`).
- **Student accounts are teacher-created only** — no self-signup, no
  password reset flow. For a small class this is usually fine; you might
  want to add a "reset password" feature if it becomes a pain.
- **No email notifications** — students/teachers won't know a new message
  arrived unless they check the app.
- **Sandbox isolation is deliberately proportionate, not maximal** — this
  is a container-level sandbox (no network, memory/CPU/process limits,
  read-only filesystem), which is solid protection against the realistic
  risks in a small trusted classroom (infinite loops, memory leaks, fork
  bombs, reading other students' files). It is intentionally simpler than
  a hardened multi-tenant judge like Judge0 (no seccomp syscall
  filtering, no kernel-level namespace sandboxing beyond what Docker
  itself provides). If you ever open this up beyond your own students,
  revisit this.
- **One submission = two container starts** — compile and run are
  separate `docker run` calls, so there's a small fixed overhead per
  submission (typically well under a second once the image is cached).
  For a classroom's request volume this is a non-issue.

## Project structure

```
java-classroom/
├── server.js              # Express app entry point
├── sandbox.js               # Docker-based code execution sandbox
├── db/database.js          # SQLite connection + schema
├── middleware/auth.js      # Login/role-check middleware
├── routes/
│   ├── auth.js              # Login, logout, user management
│   ├── assignments.js       # Create/list assignments
│   ├── submissions.js       # Run code, save versions
│   ├── discussions.js       # Discussion threads + messages
│   └── grades.js            # Grading
├── public/
│   ├── login.html / js/login.js
│   ├── student.html / js/student.js
│   ├── teacher.html / js/teacher.js
│   └── css/style.css
└── scripts/seed.js         # Creates initial accounts
```
