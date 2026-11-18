document.getElementById("go").onclick = async () => {
  const t = new URLSearchParams(location.search).get("t");
  const res = await fetch("/api/auth/link", { method: "POST", headers: { "X-Collect": "1", "content-type": "application/json" }, body: JSON.stringify({ t }) });
  if (res.ok) location = "/";
  else document.body.textContent = "This link is invalid or has expired.";
};
