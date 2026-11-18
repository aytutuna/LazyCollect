import { useEffect, useRef } from "preact/hooks";

type Widget = {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  remove(id: string): void;
};

declare global {
  interface Window {
    turnstile?: Widget;
  }
}

let script: Promise<void> | undefined;

function loadScript() {
  script ??= new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      script = undefined;
      reject(new Error("turnstile"));
    };
    document.head.append(el);
  });
  return script;
}

const SITEKEY = import.meta.env.VITE_TURNSTILE_SITEKEY || (import.meta.env.DEV ? "1x00000000000000000000AA" : "");

export function Turnstile({ onToken, onError }: { onToken: (token: string) => void; onError: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let id: string | undefined;
    let gone = false;
    loadScript().then(
      () => {
        if (gone || !box.current) return;
        id = window.turnstile!.render(box.current, {
          sitekey: SITEKEY,
          callback: onToken,
          "expired-callback": () => onToken(""),
          "error-callback": () => {
            onToken("");
            onError();
          },
        });
      },
      onError,
    );
    return () => {
      gone = true;
      if (id) window.turnstile?.remove(id);
    };
  }, []);
  return <div ref={box} />;
}
