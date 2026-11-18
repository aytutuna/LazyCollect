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
import { Loading } from "./ui";

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

  const loadMe = () => get<Me>("/me").then(setMe, (e) => e instanceof ApiError && e.status !== 401 || setMe(null));

  useEffect(() => {
    onApiEvents({ unauthorized: () => setMe(null), plan: () => setBlocked(true) });
    loadMe();
  }, []);

  async function signOut() {
    await post("/auth/logout").catch(() => {});
    setMe(null);
    setBlocked(false);
  }

  if (me === undefined) return <Loading />;
  if (me === null) return <SignIn onDone={loadMe} />;
  if (!me.firm.name) return <FirmSetup me={me} onSaved={loadMe} onSignOut={signOut} />;

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
            <Settings me={me} onSaved={loadMe} onSignOut={signOut} />
          </Route>
          <Route>
            <p>{t("notfound")}</p>
          </Route>
        </Switch>
      </main>
    </>
  );
}
