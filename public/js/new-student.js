// Standalone page for creating a student account (teacher only).

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 401) {
    window.location.href = "/login.html";
    throw new Error("Not logged in");
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function loadMe() {
  const { user } = await api("/api/auth/me");
  if (!user || user.role !== "teacher") {
    window.location.href = "/login.html";
    return;
  }
  document.getElementById("whoami").textContent = `${user.displayName} (teacher)`;
}

function showMessage(text, kind) {
  const box = document.getElementById("form-message");
  box.className = kind === "error" ? "form-message error" : "form-message success";
  box.textContent = text;
}

function fields() {
  return {
    firstName: document.getElementById("s-first").value.trim(),
    lastName: document.getElementById("s-last").value.trim(),
    groupName: document.getElementById("s-group").value.trim(),
    username: document.getElementById("s-username").value.trim(),
    password: document.getElementById("s-password").value,
  };
}

function clearForm(keepGroup) {
  const group = document.getElementById("s-group").value;
  ["s-first", "s-last", "s-username", "s-password", "s-group"].forEach((id) => {
    document.getElementById(id).value = "";
  });
  // Adding a whole group in one go is the common case, so the group sticks.
  if (keepGroup) document.getElementById("s-group").value = group;
  document.getElementById("s-first").focus();
}

async function createStudent(stayOnPage) {
  const data = fields();

  if (!data.firstName || !data.lastName || !data.username || !data.password) {
    showMessage("First name, last name, username and password are required.", "error");
    return;
  }
  if (data.password.length < 6) {
    showMessage("Password must be at least 6 characters.", "error");
    return;
  }

  const buttons = [
    document.getElementById("create-btn"),
    document.getElementById("create-another-btn"),
  ];
  buttons.forEach((b) => (b.disabled = true));

  try {
    const { user } = await api("/api/auth/users", {
      method: "POST",
      body: JSON.stringify({ ...data, role: "student" }),
    });
    if (stayOnPage) {
      showMessage(
        `Created ${user.displayName}${user.groupName ? " (" + user.groupName + ")" : ""} — username "${user.username}".`,
        "success"
      );
      clearForm(true);
    } else {
      window.location.href = "/teacher.html";
    }
  } catch (err) {
    showMessage("Could not create student: " + err.message, "error");
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

document.getElementById("create-btn").onclick = () => createStudent(false);
document.getElementById("create-another-btn").onclick = () => createStudent(true);

document.querySelectorAll("input").forEach((input) => {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") createStudent(false);
  });
});

document.getElementById("logout-btn").onclick = async () => {
  await api("/api/auth/logout", { method: "POST" });
  window.location.href = "/login.html";
};

loadMe();
