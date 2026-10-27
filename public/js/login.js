document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;
  const errorBox = document.getElementById("login-error");
  errorBox.style.display = "none";

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorBox.textContent = data.error || "Не удалось войти";
      errorBox.style.display = "block";
      return;
    }
    window.location.href = data.user.role === "teacher" ? "/teacher/dashboard" : "/student/dashboard";
  } catch (err) {
    errorBox.textContent = "Сервер недоступен.";
    errorBox.style.display = "block";
  }
});

// ---------------------------------------------------------------------
// First-run: create the very first teacher account
//
// The offer only appears while the system has no teacher at all. The server
// enforces the same rule - this is just what makes it visible.
// ---------------------------------------------------------------------

document.getElementById("bootstrap-toggle").addEventListener("click", () => {
  const form = document.getElementById("bootstrap-form");
  const open = form.style.display !== "none";
  form.style.display = open ? "none" : "block";
  document.getElementById("bootstrap-toggle").textContent = open
    ? "Создать учётную запись преподавателя"
    : "Отмена";
});

document.getElementById("bootstrap-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorBox = document.getElementById("bootstrap-error");
  errorBox.style.display = "none";

  const payload = {
    firstName: document.getElementById("t-first").value.trim(),
    lastName: document.getElementById("t-last").value.trim(),
    username: document.getElementById("t-username").value.trim(),
    email: document.getElementById("t-email").value.trim(),
    password: document.getElementById("t-password").value,
  };

  try {
    const res = await fetch("/api/auth/bootstrap-teacher", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      errorBox.textContent = data.error || "Не удалось создать учётную запись";
      errorBox.style.display = "block";
      return;
    }
    // Sign straight in with what was just created.
    const login = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: payload.username, password: payload.password }),
    });
    window.location.href = login.ok ? "/teacher/dashboard" : "/login.html";
  } catch (err) {
    errorBox.textContent = "Сервер недоступен.";
    errorBox.style.display = "block";
  }
});

async function refreshBootstrapOffer() {
  try {
    const res = await fetch("/api/auth/bootstrap-status");
    const { teacherExists } = await res.json();
    const section = document.getElementById("bootstrap-section");
    section.style.display = teacherExists ? "none" : "block";
    if (!teacherExists) {
      document.getElementById("bootstrap-note").textContent =
        "Учётной записи преподавателя ещё нет. Создайте первую, чтобы начать работу.";
    }
  } catch (e) {}
}

// If already logged in, redirect straight to the right dashboard.
(async () => {
  try {
    const res = await fetch("/api/auth/me");
    const data = await res.json();
    if (data.user) {
      window.location.href = data.user.role === "teacher" ? "/teacher/dashboard" : "/student/dashboard";
      return;
    }
  } catch (e) {}
  refreshBootstrapOffer();
})();
