import { useState } from "preact/hooks";
import { ApiError, post, useAction } from "../api";
import { t } from "../i18n";
import { Turnstile } from "../turnstile";
import { ErrorNote, Field } from "../ui";

export function SignIn({ onDone }: { onDone: () => Promise<unknown> }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [widget, setWidget] = useState(0);
  const [widgetFailed, setWidgetFailed] = useState(false);
  const { busy, error, run } = useAction();

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
      await post("/auth/verify", { email, code: code.trim() });
      await onDone();
    });
  }

  function back() {
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
        </form>
      ) : (
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
      )}
    </main>
  );
}
