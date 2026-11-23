export type Call = { method: string; path: string; headers: Headers; form: Record<string, string> };

export type FakeSub = {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  trial_end: number | null;
  items: { data: { current_period_end: number }[] };
};

export const stripeFake = {
  calls: [] as Call[],
  subs: new Map<string, FakeSub>(),
  replies: new Map<string, unknown>(),
  failing: false,
  next: 0,
  reset() {
    this.calls = [];
    this.subs.clear();
    this.replies.clear();
    this.failing = false;
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
    if (method === "POST" && url.pathname === "/v1/checkout/sessions") return reply({ id: `cs_${++this.next}`, url: `https://checkout.stripe.test/cs_${this.next}` });
    if (method === "POST" && url.pathname === "/v1/billing_portal/sessions") return reply({ url: `https://portal.stripe.test/p_${++this.next}` });
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
