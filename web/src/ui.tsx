import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { ApiError } from "./api";
import { t } from "./i18n";

export function errorText(e: unknown): string {
  const code = e instanceof ApiError ? e.code : "server_error";
  const key = `error.${code}`;
  const text = t(key);
  return text === key ? t("error.server_error") : text;
}

export function ErrorNote({ error }: { error: unknown }) {
  return error ? (
    <p class="error" role="alert">
      {errorText(error)}
    </p>
  ) : null;
}

export function Loading() {
  return <p class="muted">{t("loading")}</p>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <label class="field">
      <span class="label">{label}</span>
      {children}
      {hint && <span class="hint">{hint}</span>}
    </label>
  );
}

export function Check({ label, checked, onChange, required }: { label: string; checked: boolean; onChange: (v: boolean) => void; required?: boolean }) {
  return (
    <label class="check">
      <input type="checkbox" checked={checked} required={required} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Badge({ tone, children }: { tone: string; children: ComponentChildren }) {
  return <span class={`badge ${tone}`}>{children}</span>;
}

export function Confirm(props: {
  title: string;
  body: string;
  confirm: string;
  danger?: boolean;
  busy?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog ref={ref} aria-labelledby="dialog-title" onCancel={props.onCancel}>
      <h2 id="dialog-title">{props.title}</h2>
      <p>{props.body}</p>
      <ErrorNote error={props.error} />
      <div class="actions">
        <button type="button" class={props.danger ? "danger" : "primary"} disabled={props.busy} onClick={props.onConfirm}>
          {props.confirm}
        </button>
        <button type="button" autoFocus={props.danger} onClick={props.onCancel}>
          {t("cancel")}
        </button>
      </div>
    </dialog>
  );
}

export function statusLabel(status: string): string {
  return t(`status.${status}`);
}

const TONES: Record<string, string> = { draft: "grey", open: "teal", complete: "green", expired: "amber", closed: "grey" };

export const statusTone = (status: string) => TONES[status] ?? "grey";
