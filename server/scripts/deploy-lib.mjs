const encoder = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// the same two values src/keycheck.ts computes inside the worker
export async function fingerprint(key) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(`fingerprint:${key}`))).slice(0, 16);
}

export async function keyGate(hashKey) {
  const k = await crypto.subtle.importKey("raw", encoder.encode(hashKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, encoder.encode("key-check")));
}

// what the live key check says against the keys on this PC; an empty list means go ahead
export async function keyProblems(status, body, masterKey) {
  if (status === 404) return ["the live worker did not accept the link key from the Keys folder (or has no key check yet)"];
  if (status !== 200 || !body) return [`the key check answered ${status}`];
  const problems = [];
  if (body.master === "fail") problems.push("the live master key does not open the stored document key");
  if (body.link === "fail") problems.push("the live link key does not open the stored link");
  if (body.masterFingerprint !== (await fingerprint(masterKey))) problems.push("the live master key is not the one in the Keys folder");
  return problems;
}
