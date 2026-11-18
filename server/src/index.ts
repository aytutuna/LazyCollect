import { Hono } from "hono";

type Bindings = {
  CONTROL: D1Database;
  DB_NA: D1Database;
  FILES_NA: R2Bucket;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/api/health", (c) => c.json({ ok: true }));

export default app;
