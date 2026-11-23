import { useEffect, useState } from "preact/hooks";
import { ApiError, del, get, post, useAction } from "../api";
import { t } from "../i18n";
import { askPasskey, createPasskey, passkeyFail, passkeysSupported } from "../passkey";
import { Turnstile } from "../turnstile";
import { ErrorNote, Field, LegalLink } from "../ui";

type Step = "email" | "code" | "passkey" | "enrol";

export function SignIn({ onDone }: { onDone: () => Promise<unknown> }) {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [widget, setWidget] = useState(0);
  const [widgetFailed, setWidgetFailed] = useState(false);
  const [role, setRole] = useState("member");
  const { busy, error, run } = useAction();

  // a magic link or a reload lands here with a sign-in already waiting for its passkey
  useEffect(() => {
    get<{ step: "passkey" | "enrol" | null; role?: string; email?: string }>("/auth/pending")
      .then((p) => {
        if (!p.step) return;
        setEmail(p.email ?? "");
        setRole(p.role ?? "member");
        setStep(p.step);
      })
      .catch(() => {});
  }, []);

  async function start(e: Event) {
    e.preventDefault();
    setWidgetFailed(false);
    const ok = await run(() => post("/auth/start", { email, turnstile: token }));
    if (ok) setStep("code");
    else {
      setToken("");
      setWidget(widget + 1);
    }
  }

  async function verify(e: Event) {
    e.preventDefault();
    await run(async () => {
      const res = await post<{ ok: true; step?: "passkey" | "enrol" }>("/auth/verify", { email, code: code.trim() });
      if (res.step) {
        const p = await get<{ role?: string }>("/auth/pending");
        setRole(p.role ?? "member");
        setStep(res.step);
      } else await onDone();
    });
  }

  function back() {
    del("/auth/pending").catch(() => {});
    setStep("email");
    setCode("");
    setToken("");
    setWidgetFailed(false);
    setWidget(widget + 1);
  }

  return (
    <main class="narrow">
      <h1 class="brand">{t("app.name")}</h1>
      {step === "email" ? (
        <form onSubmit={start}>
          <h2>{t("signin.title")}</h2>
          <p class="muted">{t("signin.intro")}</p>
          <Field label={t("signin.email")}>
            <input type="email" required autoComplete="email" value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
          </Field>
          <Turnstile key={widget} onToken={setToken} onError={() => setWidgetFailed(true)} />
          <ErrorNote error={error ?? (widgetFailed ? new ApiError(400, "turnstile") : null)} />
          <button class="primary" disabled={busy || !token}>
            {t("signin.send")}
          </button>
          <p class="muted">
            {t("signin.agree_before")} <LegalLink page="terms">{t("legal.terms")}</LegalLink> {t("signin.agree_between")}{" "}
            <LegalLink page="privacy">{t("legal.privacy")}</LegalLink>
            .
          </p>
        </form>
      ) : step === "code" ? (
        <form onSubmit={verify}>
          <h2>{t("signin.code_title")}</h2>
          <p>{t("signin.code_intro", { email })}</p>
          <p class="muted">{t("signin.newest")}</p>
          <Field label={t("signin.code")}>
            <input
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onInput={(e) => setCode(e.currentTarget.value)}
            />
          </Field>
          <ErrorNote error={error} />
          <div class="actions">
            <button class="primary" disabled={busy}>
              {t("signin.verify")}
            </button>
            <button type="button" onClick={back}>
              {t("signin.other")}
            </button>
          </div>
        </form>
      ) : (
        <PasskeyStep key={step} enrol={step === "enrol"} role={role} onDone={onDone} onRestart={back} />
      )}
    </main>
  );
}

function PasskeyStep({ enrol, role, onDone, onRestart }: { enrol: boolean; role: string; onDone: () => Promise<unknown>; onRestart: () => void }) {
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const supported = passkeysSupported();

  async function go() {
    setFailed(null);
    setBusy(true);
    try {
      const { kind, options } = await post<{ kind: "authenticate" | "register"; options: any }>("/auth/pending/options");
      const response = kind === "register" ? await createPasskey(options) : await askPasskey(options);
      await post("/auth/pending/verify", { response, name: name.trim() });
      await onDone();
    } catch (e) {
      setFailed(passkeyFail(e));
      setBusy(false);
      // the sign-in is over once it has timed out or the passkey was refused
      if (e instanceof ApiError && (e.code === "pending_expired" || e.code === "passkey_counter")) onRestart();
    }
  }

  // a passkey that is asked for starts by itself; adding one waits until the person has named it and pressed the button
  useEffect(() => {
    if (supported && !enrol) go();
  }, []);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
    >
      <h2>{enrol ? t("signin.enrol_title") : t("signin.passkey_title")}</h2>
      <p>{enrol ? t("signin.enrol_intro") : t("signin.passkey_intro")}</p>
      {!supported && (
        <p class="error" role="alert">
          {t("passkey.unsupported")}
        </p>
      )}
      {enrol && supported && (
        <Field label={t("passkey.name")} hint={t("passkey.name_hint")}>
          <input maxLength={60} value={name} onInput={(e) => setName(e.currentTarget.value)} />
        </Field>
      )}
      {failed && (
        <p class="error" role="alert">
          {failed}
        </p>
      )}
      <div class="actions">
        <button class="primary" disabled={busy || !supported}>
          {enrol ? t("signin.enrol_go") : failed ? t("signin.passkey_retry") : t("signin.passkey_go")}
        </button>
        <button type="button" onClick={onRestart}>
          {t("signin.other")}
        </button>
      </div>
      {!enrol && (
        <p class="muted">
          {role === "owner" ? t("signin.lost_owner") : t("signin.lost_member")} <a href="mailto:support@alazy.app">support@alazy.app</a>
        </p>
      )}
    </form>
  );
}
