import { Hono } from "hono";
import { auth } from "./auth";
import { csrf } from "./csrf";
import { loadSession, type AppEnv } from "./session";

const app = new Hono<AppEnv>();

app.use("/api/*", csrf, loadSession);
app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api", auth);

export default app;
