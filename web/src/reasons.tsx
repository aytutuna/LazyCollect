import { useState } from "preact/hooks";
import { t } from "./i18n";
import type { Item, Kind } from "./types";

export const REASONS = ["blurry", "cut_off", "glare", "dark", "wrong_document", "wrong_period", "expired", "wrong_person", "pages_missing", "locked_pdf", "other"];
const FOR_QUESTION = ["wrong_period", "wrong_person", "other"];

// the same lists as the server's; it refuses anything else
export const reasonsFor = (kind: Kind) => (kind === "file" ? REASONS : FOR_QUESTION);

// what the client reads for a reason; a question has its own wording where the document's would not fit
function fix(code: string, kind: Kind): string {
  const own = kind === "file" ? null : t(`reason.${code}.fix_question`);
  return own && own !== `reason.${code}.fix_question` ? own : t(`reason.${code}.fix`);
}

// "other" has no wording of its own; the note says it
const named = (item: { reject_reasons: string[] }) => (item.reject_reasons ?? []).filter((c) => c !== "other");

// on the client page: what is wrong and how to fix it
export function FixList({ item }: { item: Pick<Item, "kind" | "reject_reasons"> }) {
  const codes = named(item);
  return codes.length ? (
    <ul class="reasons">
      {codes.map((c) => (
        <li key={c}>{fix(c, item.kind)}</li>
      ))}
    </ul>
  ) : null;
}

// on the account's side: the reasons it picked, then its note
export function Why({ item }: { item: Pick<Item, "reject_reasons" | "reject_note"> }) {
  const codes = named(item);
  return (
    <>
      {codes.length > 0 && <p class="reject">{codes.map((c) => t(`reason.${c}`)).join(", ")}</p>}
      {item.reject_note && <p class="reject">{item.reject_note}</p>}
    </>
  );
}

const CUSTOM = /^[0-9a-f]{32}$/;

// the illustrations in public/examples, by the names the server accepts
export const BUILTIN = ["passport", "t4", "bank-statement", "void-cheque", "noa"];

// a built-in example is a picture that ships with the app; an uploaded one is fetched through the link or the account
export const exampleSrc = (example: string, custom: string) => (CUSTOM.test(example) ? custom : `/examples/${example}.svg`);

export function Example({ item, src }: { item: Pick<Item, "id" | "label" | "example">; src: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!item.example) return null;
  return (
    <div class="example">
      <button class="quiet-link" aria-expanded={open} aria-describedby={`label-${item.id}`} onClick={() => setOpen(!open)}>
        {open ? t("example.hide") : t("example.see")}
      </button>
      {open &&
        (failed ? (
          <p class="muted">{t("example.failed")}</p>
        ) : (
          <img src={src} alt={t("example.alt", { label: item.label })} onError={() => setFailed(true)} />
        ))}
    </div>
  );
}
