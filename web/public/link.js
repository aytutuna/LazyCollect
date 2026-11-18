const button = document.getElementById("go");
button.onclick = async () => {
  button.disabled = true;
  const t = new URLSearchParams(location.search).get("t");
  let res;
  try {
    res = await fetch("/api/auth/link", { method: "POST", headers: { "X-Collect": "1", "content-type": "application/json" }, body: JSON.stringify({ t }) });
  } catch {
    button.disabled = false;
    document.getElementById("note").textContent = "Could not reach the server. Check your connection and try again.";
    return;
  }
  if (res.ok) location = "/";
  else if (res.status === 429) {
    button.disabled = false;
    document.getElementById("note").textContent = "Too many tries. Wait a minute and try again.";
  } else document.body.textContent = "This link is invalid or has expired.";
};
