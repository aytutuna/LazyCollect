import { useEffect, useState } from "preact/hooks";
import { ApiError, post, useAction } from "../api";
import { fmtDate } from "../format";
import { t } from "../i18n";
import type { Me } from "../types";
import { Confirm, ErrorNote, Field } from "../ui";

// mirrors the server's grace for a failed renewal
const GRACE = 7 * 86_400_000;

const APPLE_MANAGE_URL = "https://apps.apple.com/account/subscriptions";

type PlanFirm = Me["firm"];

const confirmed = (f: PlanFirm) => f.subscribed && f.plan_status !== "canceled";

function line(f: PlanFirm): string {
  const trialing = f.plan_status === "trialing" && (f.trial_ends_at ?? 0) > Date.now();
  if (f.plan_status === "active") {
    return t(f.cancel_at_period_end ? "settings.plan_cancelling" : "settings.plan_active", { date: fmtDate(f.current_period_end ?? Date.now()) });
  }
  if (f.plan_status === "past_due") {
    return f.usable ? t("settings.plan_past_due", { date: fmtDate((f.past_due_since ?? 0) + GRACE) }) : t("settings.plan_past_due_ended");
  }
  if (trialing) {
    const date = fmtDate(f.trial_ends_at!);
    if (f.subscribed) return t(f.cancel_at_period_end ? "settings.plan_trial_cancelling" : "settings.plan_trial_subscribed", { date });
    // Checkout bills at once when less than 48 hours of trial are left
    return t(f.trial_ends_at! < Date.now() + 2 * 86_400_000 ? "settings.plan_trial_soon" : "settings.plan_trial", { date });
  }
  return t("settings.plan_ended");
}

export function Plan({ me, onRefresh }: { me: Me; onRefresh: () => Promise<Me | undefined> }) {
  const { firm } = me;
  const owner = me.user.role === "owner";
  const { busy, error, run } = useAction();
  const [waiting, setWaiting] = useState(() => new URLSearchParams(location.search).get("billing") === "done" && !confirmed(firm));
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    // the return from Checkout comes before Stripe's webhook, so ask until the plan changes
    if (new URLSearchParams(location.search).has("billing")) history.replaceState(null, "", "/settings");
  }, []);

  useEffect(() => {
    if (!waiting) return;
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      const found = await onRefresh().catch(() => undefined);
      if (found && confirmed(found.firm)) setWaiting(false);
      else if (tries >= 15) {
        setWaiting(false);
        setSlow(true);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [waiting]);

  function go(path: string) {
    return run(async () => {
      const { url } = await post<{ url: string }>(path);
      location.assign(url);
    });
  }

  // the App Store runs this plan: no payment page of ours can change it
  const apple = firm.plan_source === "apple" && (firm.plan_status === "active" || firm.plan_status === "past_due");
  const live = firm.plan_status !== "canceled" && (firm.subscribed || firm.plan_status === "past_due");
  const label = firm.plan_status === "past_due" ? t("settings.update_payment") : t("settings.manage_billing");
  return (
    <>
      <p>{line(firm)}</p>
      {waiting && (
        <p class="muted" role="status">
          {t("settings.confirming")}
        </p>
      )}
      {slow && <p class="muted">{t("settings.confirming_slow")}</p>}
      {!owner && <p class="muted">{t("settings.plan_owner")}</p>}
      <ErrorNote error={error} />
      {apple && (
        <p>
          {t("settings.plan_apple")}{" "}
          <a href={APPLE_MANAGE_URL} target="_blank" rel="noopener">
            {t("settings.apple_manage")}
          </a>
        </p>
      )}
      {owner && !waiting && !apple && (
        <p>
          {live ? (
            <button type="button" class={firm.plan_status === "past_due" ? "primary" : ""} disabled={busy} onClick={() => go("/billing/portal")}>
              {label}
            </button>
          ) : (
            <button type="button" class="primary" disabled={busy} onClick={() => go("/billing/checkout")}>
              {t(firm.plan_status === "canceled" ? "settings.subscribe_again" : "settings.subscribe")}
            </button>
          )}
        </p>
      )}
    </>
  );
}

export function CloseAccount({ name, onClosed }: { name: string; onClosed: () => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const { busy, error, run, reset } = useAction();

  function cancel() {
    setOpen(false);
    setTyped("");
    reset();
  }

  return (
    <section>
      <h2>{t("settings.close")}</h2>
      <p class="muted">{t("settings.close_hint")}</p>
      <button type="button" class="danger" onClick={() => setOpen(true)}>
        {t("settings.close")}
      </button>
      {open && (
        <Confirm
          title={t("settings.close_title")}
          body={t("settings.close_body", { name })}
          confirm={t("settings.close_confirm")}
          danger
          busy={busy}
          disabled={typed.trim() !== name}
          error={error}
          onConfirm={async () => {
            if (await run(() => post("/account/close", { confirm: typed.trim() }))) onClosed();
          }}
          onCancel={cancel}
        >
          <Field label={t("settings.close_label")}>
            <input value={typed} autoComplete="off" onInput={(e) => setTyped(e.currentTarget.value)} />
          </Field>
          {error instanceof ApiError && error.code === "store_subscription" && (
            <p>
              <a href={APPLE_MANAGE_URL} target="_blank" rel="noopener">
                {t("settings.apple_manage")}
              </a>
            </p>
          )}
        </Confirm>
      )}
    </section>
  );
}

export function Closed({ me, onReopened, onSignOut }: { me: Me; onReopened: () => void; onSignOut: () => void }) {
  const { busy, error, run } = useAction();
  const owner = me.user.role === "owner";
  const within = me.firm.closed_at! + 30 * 86_400_000 > Date.now();
  return (
    <main class="narrow">
      <h1 class="brand">{t("app.name")}</h1>
      <h2>{t("closed.title")}</h2>
      <p>{t(within ? "closed.body" : me.firm.held ? "closed.body_held" : "closed.body_purging", { date: fmtDate(me.firm.closed_at! + 30 * 86_400_000) })}</p>
      {!owner && <p class="muted">{t("closed.member")}</p>}
      <ErrorNote error={error} />
      <p class="actions">
        {owner && (within || me.firm.held) && (
          <button type="button" class="primary" disabled={busy} onClick={async () => (await run(() => post("/account/reopen"))) && onReopened()}>
            {t("closed.reopen")}
          </button>
        )}
        <button type="button" onClick={onSignOut}>
          {t("nav.signout")}
        </button>
      </p>
    </main>
  );
}
