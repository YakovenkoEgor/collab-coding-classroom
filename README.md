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

## Backups

```bash
npm run backup
```

Writes `backups/classroom-<timestamp>.tar.gz` holding the database
(`classroom.db`), a JSON dump of every table, the `uploads/` directory
and a `summary.json` with row counts. Safe to run while the app is
serving: the database is snapshotted with SQLite's own `VACUUM INTO`, so
the copy is consistent even under writes, and the JSON dumps are read
back out of that snapshot rather than out of the live database.

`-- --keep N` sets how many archives to keep (default 10, older ones are
deleted); `-- --no-archive` leaves the folder unpacked. The script prints
the command for copying the archive off the server when it finishes.

To restore, stop the service and put `classroom.db` and `uploads/` back:

```bash
sudo systemctl stop classroom
```

```bash
sudo -u classroom bash -c 'cd /opt/classroom/app && tar -xzf backups/classroom-ДАТА.tar.gz -C /tmp && cp /tmp/classroom-ДАТА/classroom.db . && rm -f classroom.db-wal classroom.db-shm && cp -r /tmp/classroom-ДАТА/uploads .'
```

```bash
sudo systemctl start classroom
```

The old `-wal`/`-shm` files have to go: they belong to the database you
are replacing, and leaving them next to a restored file is how a
database gets corrupted.

## The teacher's pages

Each section is its own page at its own path, so a link to an assignment or a
student can be bookmarked, shared, and opened in a second tab:

| Path | What it is |
| --- | --- |
| `/teacher/dashboard` | where logging in lands: the four sections, the CSV downloads, and the two buttons that run `backup-db.js` and `export-progsnap2.js` on the server |
| `/assignments` | assignments as tiles - title, type, when it was created, how much of it is waiting to be marked |
| `/assignments?id=N` | one assignment: the roster, reviewing a student's work, the mark, the discussion, editing and deleting |
| `/assignments/new` | the creation form |
| `/students` | the roster as a list - surname, name, login, group - with a filter per column, sortable headings, and Изменить / × on every row |
| `/students?id=N` | one student: everything they have done, with a row per assignment |
| `/students?id=N&edit=1` | their details: surname, name, login, group, e-mail, and a new password when one is wanted |
| `/students/new` | adding one student, or importing a class from CSV |
| `/notifications` | announcements as tiles |
| `/notifications?id=N` | editing or deleting one |
| `/notifications/new` | writing one |
| `/mirror` | the files the sandbox can download (see *The file mirror* below) |
| `/student-assignment-work?student=S&assignment=A` | one student's work on one assignment: versions, the code, the mark, the discussion. Reached from the assignment's roster and from the student's own list, and `from` only decides where the back link goes |

A student-and-assignment pair has no id of its own in the database - a student
who has not started has nothing to point at - so that last address names both
halves rather than inventing a composite id to decode.


### The student's pages

| Path | What it is |
| --- | --- |
| `/student/dashboard` | where logging in lands: their own details, and a row per assignment - type, deadline, status, handed in on time or late, and the mark |
| `/student/work?id=N` | one assignment: the editor (or the answer box, the attachments, or the test), its versions, the mark and the discussion |

The sidebar - assignments and announcements - is on both, unchanged.
`public/js/student-core.js` holds the working screen and everything around it;
`public/js/pages/student-dashboard.js` and `student-work.js` only choose what
to show. Whether a hand-in counts as on time is decided by the *last* submitted
version, since that is the one the teacher marks.

`public/js/teacher-core.js` holds what the pages have in common - the review
screen, the assignment form, the student profile, the announcement form, the
mirror panel - and each page adds a small script of its own under
`public/js/pages/`. A page that shows a list hands `initTeacherPage` a
redraw function, which the shared code calls after anything that could change
what the list shows (a mark clears a review badge, for instance).

Deleting a student removes their work, marks, discussions, test attempts and
process-log events along with the account, and asks for their login typed out
as confirmation.

## Deadlines and top marks

Both exist **per study group only** - an assignment has none of its own. The
assignment form carries one row per group, each with a deadline and a maximum
score, either of which may be left empty.

A group with **neither** set has simply not been given the assignment: its
students see it in their list, greyed out and not clickable, with
*не требует выполнения* where the deadline would be. The server agrees - a
request to submit, attach files, or start the test is refused the same way, so
a typed address gets nowhere. The teacher's roster says the same thing in the
status column rather than calling it "не начато", which would read as a
reproach.

Consequences worth knowing:

- **A student with no study group gets nothing.** There is no rule that could
  apply to them, so every assignment reads *не требует выполнения* until they
  are given a group (which the roster's Изменить button does).
- **A deadline without a maximum score** leaves the assignment active but
  unmarkable: the grade panel says so, and `PUT /api/grades/...` refuses.
  Marks already given stay as they are.
- **Withdrawing an assignment** from a group does not delete marks already
  given. A student keeps seeing the mark on their dashboard; it drops out of
  the "баллов: N из M" total, because the scale it was marked on is gone.
- **Upgrading an existing install** does not withdraw anything: on first start
  after this change, every study group gets a rule carrying the assignment's
  old deadline and top mark (`[db] migrated deadlines and top marks to
  per-group rules`). It runs once, so a group created later starts out without
  a rule - which is exactly how "not given to them" is expressed.

`assignments.deadline` and `assignments.max_score` are still on the table so
old rows keep their history, but nothing reads them any more; everything goes
through `assignmentRules.js`.

## Using the app

### As the teacher

1. Log in - this lands on `/teacher/dashboard`, the four sections. Open
   **Задания** and click **+ Новое задание**: a title, a description, and
   optional starter code. The table *Сроки и баллы по группам* is what
   actually hands the assignment out - a group left blank there does not get
   it (see *Deadlines and top marks* above).
2. **Обучающиеся** is the roster: add or import accounts there, filter and
   sort by any column, change a student's details, or remove them. Give each
   student their username and password directly - there is no self-signup, by
   design, so you control who is in your class.
3. Click an assignment to see every student's latest submission status.
4. Click a student's row to see their full version history, view any
   version's code and output, leave a grade, and hold a discussion thread.
5. **Tests**: pick the *Test* type when creating an assignment. Two kinds —
   a graded test, where choice questions carry correct answers (an open
   question may carry one too, and goes to you for marking when it does
   not), and a survey, which has no right answers and is never scored. Set
   how long one attempt may last and, optionally, when solving opens; the
   deadline closes it. Reviewing a test shows how many answers came out
   right, wrong, and need reading, as counts out of the total and as
   percentages — the mark itself is yours to choose, out of the maximum you
   set for the assignment. Once a student has started, the questions are
   frozen; the dates, the time limit and the maximum can still change.
   Surveys never appear in the gradebook export.
6. **Уведомления**: write a class-wide announcement and
   say how long it stays up. Every student sees it as a banner above the
   working area until then; expired ones stay in your list so you can see
   what was announced.
7. **Файлы по сети**: upload the text files a program should
   be able to download, and hand out the URLs it prints next to each one
   (`http://files.local/<name>`). Then tick **Разрешить скачивание файлов
   по сети** on the assignment itself — that switch, and nothing else, is
   what gives a run any network at all. See *The file mirror* below.

### As a student

1. Log in - this lands on `/student/dashboard`: your own details and how you
   are doing on every assignment. Pick one there or from the sidebar.
2. Write code in the editor (must have a `public class Main`), click
   **Run** to compile and test it (doesn't save anything).
3. **Save draft** to save your progress as a version without marking it
   done; **Submit** to mark a version as your submission for grading.
4. Every save creates a new version — nothing is overwritten, so you and
   your teacher can always look back at earlier attempts.
5. A project can also hold data files, for labs about reading and writing
   files. **+ New file** creates one (`input.txt`, or a name with no
   extension at all); **+ Add local file** takes one off your own
   computer. They sit in the program's working directory, so
   `new File("input.txt")` finds them. Anything the program writes comes
   back into the tree when the run ends — including a serialised object,
   which shows up as a binary file you can download but not edit — and is
   saved with the version, so the next run can read it back.
6. A **test** is always listed, but can only be solved between the time it
   opens and its deadline — outside that window it says so and the
   questions stay hidden. Inside it, one button opens the questions and
   starts the clock. Answers are saved as you give them, so when the time
   runs out everything recorded is handed in automatically. One attempt
   each.
7. Announcements from the teacher appear as banners above the working
   area. Closing one hides it for the rest of your session; the
   **Уведомления** list in the sidebar still holds everything active,
   and clicking an entry brings its banner back.
8. Use the discussion box to ask questions. Whichever version is currently
   loaded in your editor gets linked to your next message automatically,
   so your teacher can jump straight to the code you're asking about.

## The file mirror (network labs)

Runs have no network: `--network=none`. That makes a lab like "download a
text file by its URL" impossible, so the platform serves the files itself.

- The teacher uploads text files under **Файлы по сети**. They keep their own
  names, because the name in the URL is the point of such a lab. Same policy
  as a project's data file: text formats only (`projectFiles.DATA_EXTENSIONS`),
  or no extension at all.
- An assignment with `network_access` on joins `jc-mirror-net` instead of
  getting no network. That network is created with `--internal`, and the only
  host on it is the mirror container, reachable as `files.local`.
- The mirror is `jwebserver` from the JDK image already in use - no extra
  image, and it only ever answers GET and HEAD, from a read-only mount. It
  starts on demand, on the first run that needs it (`mirror.ensureUp`), and
  the teacher's panel can start and stop it by hand.

What a run on that network can reach, measured from inside the sandbox:

| target | result |
| --- | --- |
| `http://files.local/<file>` | served |
| `https://example.com/` | `UnknownHostException` |
| `http://1.1.1.1/` | `SocketException: Network is unreachable` |
| the host, incl. this platform's own port | unreachable |
| a container on the default bridge (reachable from a normal container) | unreachable |

What it *can* reach is the other containers on the same network: two runs
happening in the same moment can see each other's ports. That is why network
access is per-assignment and off by default - switch it on for the lab that
needs it, not for the course.

Environment variables (all optional): `MIRROR_DIR` (default `./mirror`),
`MIRROR_NETWORK`, `MIRROR_CONTAINER`, `MIRROR_HOSTNAME` (default
`files.local`), `MIRROR_PORT` (default 80), `MIRROR_IMAGE`,
`MIRROR_MAX_FILES`, `MIRROR_MAX_FILE_BYTES`.

## Process data (ProgSnap2)

The platform keeps an append-only log of what students did while they worked -
sessions, edits, compiles, runs, submissions, marks - in the shape
[ProgSnap2](https://cssplice.org/progsnap2) defines (version 8, Beta). The
point of using a published format rather than an ad-hoc one is that the data
can be analysed with tooling other people have already written, and shared
without a translation step.

### What is logged

| ProgSnap2 event | When |
| --- | --- |
| `Session.Start` / `Session.End` | a student logs in / logs out (an expired session leaves no End) |
| `Compile`, `Compile.Error` | every compile, with the compiler's own message |
| `Run.Program` | every run: input, output, and `ExecutionResult` |
| `Submit` | handing work in |
| `Resource.View` | downloading a handout |
| `File.Edit` | editing, **only if switched on** - see below |
| `X-Draft.Save` | saving a draft (not a submission, so not `Submit`) |
| `X-Grade` | the teacher marking the work; `Score` normalised to 0..1 |
| `X-Test.Start`, `X-Test.Submit` | sitting a test (answers are not logged) |
| `X-Sandbox.Error` | the sandbox itself failed - no `Compile`/`Run.Program` is claimed, because nothing of the student's ran |

A run is logged as a `Compile` plus a `Run.Program`, linked by `ParentEventID`
and a shared `ExecutionID`. Code snapshots are stored once per distinct
content, so pressing Run twice without an edit costs one snapshot.

**Not logged, deliberately:** discussion threads between a student and the
teacher, feedback text on a mark, and anything a teacher does other than
marking. The log is about how students work.

### Edit capture

`File.Edit` is off by default: it is the one event that arrives by the
thousand. Turning it on makes each student's editor send a snapshot of the
project at most once per interval - not keystrokes, and only when something
actually changed.

```bash
PROGSNAP_EDIT_CAPTURE=on PROGSNAP_EDIT_INTERVAL_SECONDS=120 npm start
```

The interval is enforced on the server as well as respected by the browser,
with a floor of 5 seconds.

### Surrogate keys

Every student gets a `subject_key`: random, unique, and not derived from their
login, name or database id. That is what `SubjectID` holds in an export, so a
dataset cannot be traced back to a person without the classroom database -
which is never part of an export. A database trigger assigns the key, so every
way of creating an account gets one.

### Exporting

```bash
npm run export:progsnap
node scripts/export-progsnap2.js --out exports --term "2026 осень" --with-groups
```

Produces `exports/progsnap2-<timestamp>/` and a `.tar.gz` beside it:
`MainTable.csv`, `DatasetMetadata.csv`, `README.txt` (what the dataset is, what
the `X-` columns mean, what to watch out for when analysing it),
`CodeStates/<id>/` in the Directory format, and `LinkTables/Subject.csv`.
`--with-groups` adds the study group to the subject table; it is opt-in
because in a class of twenty a group narrows a person down to a handful.
Run `npm run validate:progsnap` afterwards - especially before sharing a
dataset with anyone.

### Checking an export before it goes anywhere

```bash
npm run validate:progsnap                       # the newest export under ./exports
node scripts/validate-progsnap2.js <dir> --no-privacy-check
```

Two things are checked. **Conformance**: the files and columns the spec
requires, its enumerations (`EventType`, `ExecutionResult`, `CompileResult`,
`EventInitiator`, `CodeStateRepresentation`), the columns each event type
requires, unique `EventID`, unique `Order` within the scope the metadata
declares, `Score` within 0..1, `ParentEventID` pointing at a real event, and a
directory on disk for every `CodeStateID` referenced.

**Privacy**: the export is read back and compared against the classroom
database, looking for logins, names, e-mail addresses, initial passwords,
feedback text and discussion messages - and for a `SubjectID` that is not one
of the surrogate keys. Those are reported as violations. A name inside a
student's own source file is reported as a note instead: that is their code,
not a leak by the exporter, but it is worth knowing before publishing.

Anything wrong makes it exit 1, so it can gate a release. An empty
`CodeStateID` on a student's first `Session.Start` is a note, not a violation.

Environment variables: `PROGSNAP_LOGGING` (`off` disables the whole log),
`PROGSNAP_EDIT_CAPTURE`, `PROGSNAP_EDIT_INTERVAL_SECONDS`,
`PROGSNAP_MAX_OUTPUT_CHARS` (default 20000 - program output is clipped at this
length), `PROGSNAP_COURSE_ID`, `PROGSNAP_TERM_ID`.

`npm run reset` deletes the log along with everything else, so export before
resetting if the data matters.

## Known limitations / things to improve next

- **No automated test cases** — by design, per your requirements. Grading
  is fully manual.
- **The program's working directory is writable and not `noexec`** — it
  is a bind mount, and Docker cannot add `noexec` to one; a bind mount
  takes the options of its source on the host. A program could therefore
  write a binary into its own working directory and execute it, still as
  an unprivileged user with no network. To close that off, point
  `SANDBOX_WORK_BASE` at a directory on a filesystem mounted `noexec`.
- **Data files are capped deliberately** — a project may hold up to 15
  data files, 256 KB each and 1 MB in total (`projectFiles.js`). A
  program that writes more than that has its extra files dropped, with a
  note in the console. Fine for labs about streams; not a file store.
- **Runs that share the mirror network can see each other** - Docker has no
  per-container "no peers" switch on a shared bridge, and a network per run
  would mean creating and removing one on every press of Run. Only
  assignments with network access are affected; the rest still get
  `--network=none`.
- **The process log only grows** - nothing prunes it. Code snapshots are
  deduplicated, so a term of work is megabytes rather than gigabytes, but
  with `File.Edit` capture on and a short interval it is worth watching.
- **Student accounts are teacher-created only** — no self-signup, no
  password reset flow. For a small class this is usually fine; you might
  want to add a "reset password" feature if it becomes a pain.
- **No email notifications** — students/teachers won't know a new message
  arrived unless they check the app.
- **Sandbox isolation is deliberately proportionate, not maximal** — this
  is a container-level sandbox (no network, memory/CPU/process limits,
  read-only filesystem apart from the project's own working directory,
  which is mounted read-write at `/work`), which is solid protection
  against the realistic
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
├── mirror.js                # The file server a networked run can download from
├── progsnap.js              # The process log, in ProgSnap2's shape
├── db/database.js          # SQLite connection + schema
├── middleware/auth.js      # Login/role-check middleware
├── routes/
│   ├── auth.js              # Login, logout, user management
│   ├── assignments.js       # Create/list assignments
│   ├── submissions.js       # Run code, save versions
│   ├── discussions.js       # Discussion threads + messages
│   ├── notifications.js     # Class-wide announcements
│   ├── mirror.js            # Files served to the sandbox over HTTP
│   ├── progsnap.js          # Edit capture config + the editor's reports
│   ├── maintenance.js       # Backup / ProgSnap2 export from the dashboard
│   ├── tests.js             # Sitting a test, reading the result
│   └── grades.js            # Grading
├── public/
│   ├── login.html / js/login.js
│   ├── teacher/             # One page per section (see below)
│   ├── student/             # The dashboard and one assignment's screen
│   ├── js/teacher-core.js   # Everything the teacher's pages share
│   ├── js/student-core.js   # Everything the student's pages share
│   ├── js/pages/            # One small script per page
│   └── css/style.css
└── scripts/
    ├── seed.js              # Creates initial accounts
    ├── backup-db.js         # Consistent snapshot of the database + files
    ├── export-progsnap2.js  # Process data as a ProgSnap2 dataset
    └── validate-progsnap2.js # Checks an export: conformance and privacy
```
