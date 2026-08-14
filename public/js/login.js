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
      errorBox.textContent = data.error || "Login failed";
      errorBox.style.display = "block";
      return;
    }
    window.location.href = data.user.role === "teacher" ? "/teacher.html" : "/student.html";
  } catch (err) {
    errorBox.textContent = "Could not reach the server.";
    errorBox.style.display = "block";
  }
});

// If already logged in, redirect straight to the right dashboard.
(async () => {
  try {
    const res = await fetch("/api/auth/me");
    const data = await res.json();
    if (data.user) {
      window.location.href = data.user.role === "teacher" ? "/teacher.html" : "/student.html";
    }
  } catch (e) {}
})();
