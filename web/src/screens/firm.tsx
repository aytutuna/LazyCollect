import { useState } from "preact/hooks";
import { Link } from "wouter-preact";
import { get, patch, put, useAction, useLoad } from "../api";
import { t } from "../i18n";
import type { Firm, Me } from "../types";
import { Confirm, ErrorNote, Field, Loading } from "../ui";
import { CloseAccount, Plan } from "./billing";
import { Staff } from "./staff";

const ZONES = ["America/St_Johns", "America/Halifax", "America/Toronto", "America/Winnipeg", "America/Regina", "America/Edmonton", "America/Vancouver"];
const PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];

function FirmForm({ firm, canEdit, onSaved }: { firm: Firm; canEdit: boolean; onSaved: () => void }) {
  const [name, setName] = useState(firm.name ?? "");
  const [legal, setLegal] = useState(firm.legal_name ?? "");
  const [address, setAddress] = useState(firm.address ?? "");
  const [phone, setPhone] = useState(firm.phone ?? "");
  const [province, setProvince] = useState(firm.province ?? "");
  const [tz, setTz] = useState(firm.tz);
  const hasBusiness = Boolean(firm.legal_name || firm.address || firm.phone || firm.province);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();

  async function submit(e: Event) {
    e.preventDefault();
    setSaved(false);
    const ok = await run(() => patch("/firm", { name, legal_name: legal, address, phone, province, tz }));
    if (ok) {
      setSaved(true);
      onSaved();
    }
  }

  return (
    <form onSubmit={submit}>
      {!canEdit && <p class="muted">{t("firm.owner_only")}</p>}
      <fieldset disabled={!canEdit}>
        <Field label={t("firm.name")} hint={t("firm.name_hint")}>
          <input required maxLength={120} value={name} onInput={(e) => setName(e.currentTarget.value)} />
        </Field>
        <details class="business" open={hasBusiness}>
          <summary>{t("firm.business")}</summary>
          <Field label={t("firm.legal")} hint={t("firm.legal_hint")}>
            <input maxLength={160} value={legal} onInput={(e) => setLegal(e.currentTarget.value)} />
          </Field>
          <Field label={t("firm.address")}>
            <textarea rows={3} maxLength={300} value={address} onInput={(e) => setAddress(e.currentTarget.value)} />
          </Field>
          <Field label={t("firm.phone")}>
            <input type="tel" maxLength={40} value={phone} onInput={(e) => setPhone(e.currentTarget.value)} />
          </Field>
          <Field label={t("firm.province")}>
            <select value={province} onChange={(e) => setProvince(e.currentTarget.value)}>
              <option value="">{t("firm.province_none")}</option>
              {PROVINCES.map((p) => (
                <option value={p}>{t(`province.${p}`)}</option>
              ))}
            </select>
          </Field>
        </details>
        <Field label={t("firm.tz")} hint={t("firm.tz_hint")}>
          <select value={tz} onChange={(e) => setTz(e.currentTarget.value)}>
            {(ZONES.includes(firm.tz) ? ZONES : [firm.tz, ...ZONES]).map((z) => (
              <option value={z}>{ZONES.includes(z) ? t(`tz.${z}`) : z}</option>
            ))}
          </select>
        </Field>
      </fieldset>
      <ErrorNote error={error} />
      {saved && <p class="ok">{t("saved")}</p>}
      {canEdit && (
        <button class="primary" disabled={busy}>
          {t("firm.save")}
        </button>
      )}
    </form>
  );
}

export function FirmSetup({ me, onSaved, onSignOut }: { me: Me; onSaved: () => void; onSignOut: () => void }) {
  const { data, error } = useLoad(() => get<Firm>("/firm"));
  return (
    <main class="narrow">
      <h1 class="brand">{t("app.name")}</h1>
      <h2>{t("setup.title")}</h2>
      <p class="muted">{t("setup.intro")}</p>
      {data ? <FirmForm firm={data} canEdit={me.user.role === "owner"} onSaved={onSaved} /> : error ? <ErrorNote error={error} /> : <Loading />}
      <p class="spaced">
        <button type="button" class="link" onClick={onSignOut}>
          {t("nav.signout")}
        </button>
      </p>
    </main>
  );
}

function Retention({ canEdit }: { canEdit: boolean }) {
  const { data, error, reload } = useLoad(() => get<{ years: number }>("/retention"));
  const [saved, setSaved] = useState(false);
  const [years, setYears] = useState<number | null>(null);
  const [moving, setMoving] = useState<number | null>(null);
  const { busy, error: failed, run, reset } = useAction();
  const chosen = years ?? data?.years ?? 7;

  async function save() {
    setSaved(false);
    if (await run(() => put("/retention", { years: chosen }))) {
      setMoving(null);
      setSaved(true);
      reload();
    }
  }

  // a shorter period can retire requests at once, so say how many first
  async function submit(e: Event) {
    e.preventDefault();
    if (chosen < data!.years) {
      let count = 0;
      if (!(await run(async () => (count = (await get<{ count: number }>(`/retention/impact?years=${chosen}`)).count)))) return;
      if (count > 0) {
        setMoving(count);
        return;
      }
    }
    await save();
  }

  return (
    <section class="narrow-form">
      <h2>{t("settings.retention")}</h2>
      <p class="muted">{t("settings.retention_hint")}</p>
      {!data ? (
        error ? <ErrorNote error={error} /> : <Loading />
      ) : (
        <>
          {!canEdit && <p class="muted">{t("settings.retention_owner")}</p>}
          <form onSubmit={submit}>
            <Field label={t("settings.retention_years")}>
              <select disabled={!canEdit} value={chosen} onChange={(e) => setYears(Number(e.currentTarget.value))}>
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <option value={n}>{t("settings.years", { n })}</option>
                ))}
              </select>
            </Field>
            {moving === null && <ErrorNote error={failed} />}
            {saved && <p class="ok">{t("saved")}</p>}
            {canEdit && (
              <button class="primary" disabled={busy || chosen === data.years}>
                {t("settings.retention_save")}
              </button>
            )}
          </form>
          {moving !== null && (
            <Confirm
              title={t("settings.retention_confirm_title")}
              body={t("settings.retention_confirm_body", { n: moving, years: chosen })}
              confirm={t("settings.retention_confirm")}
              danger
              busy={busy}
              error={failed}
              onConfirm={save}
              onCancel={() => {
                setMoving(null);
                reset();
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

export function Settings({ me, onSaved, onRefresh, onSignOut, onClosed }: { me: Me; onSaved: () => void; onRefresh: () => Promise<Me | undefined>; onSignOut: () => void; onClosed: () => void }) {
  const { data, error } = useLoad(() => get<Firm>("/firm"));
  return (
    <>
      <h1>{t("settings.title")}</h1>
      <section>
        <h2>{t("settings.account")}</h2>
        <p>{t("settings.signed_in", { email: me.user.email })}</p>
        <Plan me={me} onRefresh={onRefresh} />
        <button type="button" onClick={onSignOut}>
          {t("nav.signout")}
        </button>
      </section>
      <section class="narrow-form">
        <h2>{t("settings.firm")}</h2>
        {data ? <FirmForm firm={data} canEdit={me.user.role === "owner"} onSaved={onSaved} /> : error ? <ErrorNote error={error} /> : <Loading />}
      </section>
      <Retention canEdit={me.user.role === "owner"} />
      {me.user.role === "owner" && <Staff me={me} />}
      <section>
        <h2>{t("settings.more")}</h2>
        <p>
          <Link href="/trash">{t("settings.trash")}</Link>
        </p>
        {me.user.role === "owner" && (
          <p>
            <Link href="/activity">{t("settings.activity")}</Link>
          </p>
        )}
      </section>
      {me.user.role === "owner" && <CloseAccount name={me.firm.name!} onClosed={onClosed} />}
    </>
  );
}
