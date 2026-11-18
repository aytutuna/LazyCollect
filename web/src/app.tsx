import { useEffect, useState } from "preact/hooks";
import { Link, Route, Switch, useRoute } from "wouter-preact";
import { ApiError, get, onApiEvents, post } from "./api";
import { t } from "./i18n";
import { Clients } from "./screens/clients";
import { FirmSetup, Settings } from "./screens/firm";
import { NewRequest } from "./screens/new-request";
import { RequestPage } from "./screens/request-detail";
import { Requests } from "./screens/requests";
import { SignIn } from "./screens/signin";
import { TemplatePage, Templates } from "./screens/templates";
import type { Me } from "./types";
import { ErrorNote, Loading } from "./ui";

function NavLink({ href, children }: { href: string; children: string }) {
  const [active] = useRoute(href === "/" ? "/" : `${href}/*?`);
  return (
    <Link href={href} class={active ? "active" : ""} aria-current={active ? "page" : undefined}>
      {children}
    </Link>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [blocked, setBlocked] = useState(false);

  const [fault, setFault] = useState<{ error: unknown; retry?: () => void } | null>(null);

  // a 401 is handled by the unauthorized hook; anything else is thrown to the caller
  async function loadMe() {
    try {
      setMe(await get<Me>("/me"));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) throw e;
    }
  }

  function reload() {
    setFault(null);
    loadMe().catch((error) => setFault({ error, retry: reload }));
  }

  useEffect(() => {
    onApiEvents({ unauthorized: () => setMe(null), plan: () => setBlocked(true) });
    reload();
  }, []);

  async function signOut() {
    try {
      await post("/auth/logout");
    } catch (error) {
      setFault({ error });
      return;
    }
    setMe(null);
    setBlocked(false);
  }

  const notice = fault && (
    <div class="panel">
      <ErrorNote error={fault.error} />
      <button onClick={fault.retry ?? (() => setFault(null))}>{fault.retry ? t("retry") : t("dismiss")}</button>
    </div>
  );

  if (me === undefined) return notice ?? <Loading />;
  if (me === null)
    return (
      <>
        {notice}
        <SignIn onDone={loadMe} />
      </>
    );
  if (!me.firm.name)
    return (
      <>
        {notice}
        <FirmSetup me={me} onSaved={reload} onSignOut={signOut} />
      </>
    );

  const ended = blocked || (me.firm.plan_status !== "active" && !(me.firm.plan_status === "trialing" && (me.firm.trial_ends_at ?? 0) > Date.now()));

  return (
    <>
      <header class="top">
        <div class="bar">
          <span class="brand">{me.firm.name}</span>
          <nav aria-label={t("nav.label")}>
            <NavLink href="/">{t("nav.requests")}</NavLink>
            <NavLink href="/clients">{t("nav.clients")}</NavLink>
            <NavLink href="/templates">{t("nav.templates")}</NavLink>
            <NavLink href="/settings">{t("nav.settings")}</NavLink>
          </nav>
        </div>
      </header>
      {ended && (
        <div class="banner" role="status">
          {t("plan.ended")}
        </div>
      )}
      {notice}
      <main>
        <Switch>
          <Route path="/">
            <Requests />
          </Route>
          <Route path="/new">
            <NewRequest />
          </Route>
          <Route path="/requests/:id">{(params) => <RequestPage key={params.id} id={params.id} />}</Route>
          <Route path="/clients">
            <Clients />
          </Route>
          <Route path="/templates">
            <Templates />
          </Route>
          <Route path="/templates/new">
            <TemplatePage />
          </Route>
          <Route path="/templates/:id">{(params) => <TemplatePage id={params.id} />}</Route>
          <Route path="/settings">
            <Settings me={me} onSaved={reload} onSignOut={signOut} />
          </Route>
          <Route>
            <p>{t("notfound")}</p>
          </Route>
        </Switch>
      </main>
    </>
  );
}
