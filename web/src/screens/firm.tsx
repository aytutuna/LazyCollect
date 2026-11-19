import { useState } from "preact/hooks";
import { get, patch, useAction, useLoad } from "../api";
import { fmtDate } from "../format";
import { t } from "../i18n";
import type { Firm, Me } from "../types";
import { ErrorNote, Field, Loading } from "../ui";

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

function planLine(firm: Me["firm"]): string {
  if (firm.plan_status === "active") return t("settings.plan_active");
  if (firm.plan_status === "trialing" && firm.trial_ends_at && firm.trial_ends_at > Date.now()) {
    return t("settings.plan_trial", { date: fmtDate(firm.trial_ends_at) });
  }
  return t("settings.plan_ended");
}

export function Settings({ me, onSaved, onSignOut }: { me: Me; onSaved: () => void; onSignOut: () => void }) {
  const { data, error } = useLoad(() => get<Firm>("/firm"));
  return (
    <>
      <h1>{t("settings.title")}</h1>
      <section>
        <h2>{t("settings.account")}</h2>
        <p>{t("settings.signed_in", { email: me.user.email })}</p>
        <p>{planLine(me.firm)}</p>
        <button type="button" onClick={onSignOut}>
          {t("nav.signout")}
        </button>
      </section>
      <section class="narrow-form">
        <h2>{t("settings.firm")}</h2>
        {data ? <FirmForm firm={data} canEdit={me.user.role === "owner"} onSaved={onSaved} /> : error ? <ErrorNote error={error} /> : <Loading />}
      </section>
    </>
  );
}
