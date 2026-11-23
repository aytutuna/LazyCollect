export type Call = { method: string; path: string; headers: Headers; form: Record<string, string> };

export type FakeSub = {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  trial_end: number | null;
  cancel_at?: number | null;
  latest_invoice?: string;
  items: { data: { current_period_end: number }[] };
};

export const stripeFake = {
  calls: [] as Call[],
  subs: new Map<string, FakeSub>(),
  replies: new Map<string, unknown>(),
  sessions: new Map<string, { id: string; customer: string; status: string }>(),
  payments: new Map<string, { status: string; payment: { payment_intent: string } }[]>(),
  gone: new Set<string>(),
  failing: false,
  refund: "ok" as "ok" | "already" | "fail",
  next: 0,
  reset() {
    this.calls = [];
    this.subs.clear();
    this.replies.clear();
    this.sessions.clear();
    this.payments.clear();
    this.gone.clear();
    this.failing = false;
    this.refund = "ok";
    this.next = 0;
  },
  sub(id: string, customer: string, over: Partial<FakeSub> & { end?: number } = {}): FakeSub {
    const { end = Date.now() + 30 * 86_400_000, ...rest } = over;
    const sub = { id, customer, status: "active", cancel_at_period_end: false, trial_end: null, items: { data: [{ current_period_end: Math.floor(end / 1000) }] }, ...rest };
    this.subs.set(id, sub);
    return sub;
  },
  async handle(url: URL, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    this.calls.push({ method, path: url.pathname, headers, form });
    if (this.failing) return new Response("nope", { status: 500 });
    if (headers.get("authorization") !== "Bearer sk_test_123") return new Response("auth", { status: 401 });
    const key = headers.get("idempotency-key");
    if (method === "POST" && key && this.replies.has(key)) return Response.json(this.replies.get(key));
    const reply = (body: unknown) => {
      if (key) this.replies.set(key, body);
      return Response.json(body);
    };
    if (method === "POST" && url.pathname === "/v1/customers") return reply({ id: `cus_${++this.next}` });
    if (method === "POST" && url.pathname === "/v1/checkout/sessions") {
      const id = `cs_${++this.next}`;
      this.sessions.set(id, { id, customer: form.customer, status: "open" });
      return reply({ id, url: `https://checkout.stripe.test/${id}` });
    }
    if (method === "GET" && url.pathname === "/v1/checkout/sessions") {
      const { customer, status } = Object.fromEntries(url.searchParams);
      return Response.json({ data: [...this.sessions.values()].filter((s) => s.customer === customer && s.status === status) });
    }
    const path = url.pathname.split("/");
    if (method === "POST" && url.pathname.startsWith("/v1/checkout/sessions/") && path[5] === "expire") {
      const found = this.sessions.get(path[4]);
      if (!found) return new Response("missing", { status: 404 });
      found.status = "expired";
      return Response.json(found);
    }
    if (method === "GET" && url.pathname === "/v1/invoice_payments") return Response.json({ data: this.payments.get(url.searchParams.get("invoice") ?? "") ?? [] });
    if (method === "POST" && url.pathname === "/v1/refunds" && this.refund === "fail") return new Response("nope", { status: 500 });
    if (method === "POST" && url.pathname === "/v1/refunds" && this.refund === "already") return Response.json({ error: { code: "charge_already_refunded" } }, { status: 400 });
    if (method === "POST" && url.pathname === "/v1/refunds") return reply({ id: `re_${++this.next}` });
    if (method === "DELETE" && url.pathname.startsWith("/v1/customers/")) {
      if (this.gone.has(path[3])) return new Response("missing", { status: 404 });
      this.gone.add(path[3]);
      return Response.json({ id: path[3], deleted: true });
    }
    if (method === "POST" && url.pathname === "/v1/billing_portal/sessions") return reply({ url: `https://portal.stripe.test/p_${++this.next}` });
    if (method === "GET" && url.pathname === "/v1/subscriptions") {
      const customer = url.searchParams.get("customer");
      if (this.gone.has(customer ?? "")) return new Response("missing", { status: 404 });
      const limit = Number(url.searchParams.get("limit") ?? 10);
      return Response.json({ data: [...this.subs.values()].filter((s) => s.customer === customer).slice(0, limit) });
    }
    const sub = /^\/v1\/subscriptions\/([\w-]+)$/.exec(url.pathname);
    if (sub && method === "GET") {
      const found = this.subs.get(sub[1]);
      return found ? Response.json(found) : new Response("missing", { status: 404 });
    }
    if (sub && method === "DELETE") {
      const found = this.subs.get(sub[1]);
      if (!found) return new Response("missing", { status: 404 });
      found.status = "canceled";
      return Response.json(found);
    }
    return new Response("unknown", { status: 404 });
  },
};
