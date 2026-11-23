import { useRef, useState } from "preact/hooks";
import { ApiError, send, useAction } from "../api";
import { t } from "../i18n";
import { BUILTIN, exampleSrc } from "../reasons";
import { ErrorNote } from "../ui";

const TYPES = "image/jpeg,image/png,image/webp";

// the server's size and type answers share codes with the client uploads, which have other limits
function problem(e: unknown) {
  if (!(e instanceof ApiError)) return e;
  return e.status === 413 ? new ApiError(413, "example_too_big") : e.status === 415 ? new ApiError(415, "example_unsupported") : e;
}

// An item or template points at one image: a standard illustration by name, or an upload by id.
export function ExampleField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [error, setError] = useState<unknown>(null);
  const picker = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction((e) => setError(problem(e)));
  const standard = BUILTIN.includes(value);

  async function pick(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setError(null);
    await run(async () => onChange((await send<{ id: string }>("/examples", file)).id));
  }

  return (
    <div class="example-field">
      <span class="label">{t("example.title")}</span>
      {value && <img src={exampleSrc(value, `/api/examples/${value}`)} alt={t("example.preview")} />}
      <div class="row-actions">
        <button type="button" class="small" disabled={busy} onClick={() => picker.current?.click()}>
          {busy ? t("example.uploading") : value && !standard ? t("example.replace") : t("example.add")}
        </button>
        {value && (
          <button type="button" class="small quiet" onClick={() => onChange("")}>
            {t("example.remove")}
          </button>
        )}
      </div>
      <input ref={picker} type="file" accept={TYPES} hidden tabIndex={-1} onChange={(e) => pick(e.currentTarget)} />
      <label class="field">
        <span class="label">{t("example.standard")}</span>
        <select value={standard ? value : ""} onChange={(e) => onChange(e.currentTarget.value)}>
          <option value="">{t("example.none")}</option>
          {BUILTIN.map((name) => (
            <option value={name}>{t(`example.${name}`)}</option>
          ))}
        </select>
      </label>
      <span class="hint">{t("example.hint")}</span>
      <ErrorNote error={error} />
    </div>
  );
}
