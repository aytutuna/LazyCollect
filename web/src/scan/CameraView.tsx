import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n";
import { acceptable } from "./corners";
import type { Engine } from "./engine";
import { aspect, scaled, type Quad } from "./geometry";
import { readPixels, release, shotOf, type Shot } from "./pipeline";
import type { Issue } from "./quality";

export type Capture = { shot: Shot; quad: Quad | null; confidence: number | null };

// frames for the page finder and the live checks are at most this wide
const LIVE = 800;
const TICK_MS = 120;
// the outline must hold this still (as a share of the frame's diagonal) for this long
const STILL = 0.02;
const HOLD_MS = 1000;

type Seen = { quad: Quad; confidence: number; issues: Issue[]; at: number };

export function CameraView({ detector, onCapture, onUnavailable, say }: { detector: Engine; onCapture: (c: Capture) => void | Promise<void>; onUnavailable: (why: "denied" | "none") => void; say: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [dims, setDims] = useState<[number, number]>([4, 3]);
  const [seen, setSeen] = useState<Seen | null>(null);
  const [state, setState] = useState<"starting" | "loading" | "searching" | "found" | "hold" | "manual">("starting");
  const [auto, setAuto] = useState(true);
  const shutter = useRef<HTMLButtonElement>(null);
  const live = useRef({ auto: true, seen: null as Seen | null, busy: false });
  live.current.auto = auto;

  // false when nothing was taken
  async function grab(seenNow: Seen | null): Promise<boolean> {
    const v = video.current!;
    if (live.current.busy || !v.videoWidth) return false;
    live.current.busy = true;
    try {
      const shot = await shotOf(v, v.videoWidth, v.videoHeight);
      // the outline is in video pixels; the shot may be a smaller copy of the frame
      const quad = seenNow ? scaled(seenNow.quad, shot.width / v.videoWidth, shot.height / v.videoHeight) : null;
      await onCapture({ shot, quad, confidence: seenNow?.confidence ?? null });
      return true;
    } catch {
      say(t("scan.photo_failed"));
      return false;
    } finally {
      live.current.busy = false;
    }
  }

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let alive = true;
    // each start gets a number, and stop() invalidates the one in flight, so a start overtaken by a hide or a newer start ends quietly
    let gen = 0;
    const scratch = document.createElement("canvas");
    let still = { quad: null as Quad | null, since: 0 };
    let advice = { key: "", times: 0 };
    let shownAdvice = "";

    const stop = () => {
      gen++;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      if (video.current) video.current.srcObject = null;
    };

    async function tick() {
      let again = true;
      try {
        again = await look();
      } catch {
        // a bad frame is skipped
      }
      if (again && alive && stream) timer = window.setTimeout(tick, TICK_MS);
    }

    // one look at the picture; false once the photo is taken or the camera is gone
    async function look(): Promise<boolean> {
      const v = video.current;
      if (!alive || !stream || !v) return false;
      if (v.readyState < 2 || !v.videoWidth) return true;
      setDims((d) => (d[0] === v.videoWidth && d[1] === v.videoHeight ? d : [v.videoWidth, v.videoHeight]));
      const frame = readPixels(v, v.videoWidth, v.videoHeight, LIVE, scratch);
      const found = await detector.detect({ ...frame, data: frame.data.slice() });
      if (!alive || !stream) return false;
      const now = Date.now();
      if (found && acceptable(found, frame.width, frame.height)) {
        const quad = scaled(found.quad, frame.width, frame.height);
        const issues = await detector.frameIssues(quad, found.confidence, frame.width, frame.height);
        const ratio = aspect(quad, frame.width, frame.height);
        const long = 640;
        const flat = await detector.warp(frame, quad, ratio >= 1 ? long : Math.round(long * ratio), ratio >= 1 ? Math.round(long / ratio) : long);
        if (flat) issues.push(...(await detector.pageIssues(flat)));
        if (!alive || !stream) return false;
        // a message must hold for two checks in a row before it replaces the last, so it does not flicker
        const key = issues.join();
        advice = key === advice.key ? { key, times: advice.times + 1 } : { key, times: 1 };
        if (advice.times >= 2) shownAdvice = key;
        const shownIssues = (shownAdvice ? shownAdvice.split(",") : []) as Issue[];
        const moved = still.quad && quad.reduce((worst, p, i) => Math.max(worst, Math.hypot(p[0] - still.quad![i][0], p[1] - still.quad![i][1])), 0);
        if (!still.quad || moved! > STILL * Math.hypot(frame.width, frame.height)) still = { quad, since: now };
        const stable = now - still.since;
        const next: Seen = { quad: scaled(quad, v.videoWidth / frame.width, v.videoHeight / frame.height), confidence: found.confidence, issues: shownIssues, at: now };
        live.current.seen = next;
        setSeen(next);
        const ready = stable >= HOLD_MS && !issues.length;
        setState(!shownIssues.length && stable > 300 && live.current.auto ? "hold" : "found");
        if (ready && live.current.auto) {
          return !(await grab(next));
        }
      } else {
        still = { quad: null, since: 0 };
        // the outline lingers a moment so a dropped frame does not make it blink
        if (live.current.seen && now - live.current.seen.at > 600) {
          live.current.seen = null;
          setSeen(null);
          setState("searching");
        }
      }
      return true;
    }

    async function start() {
      if (stream) return;
      if (!navigator.mediaDevices?.getUserMedia) return onUnavailable("none");
      const run = ++gen;
      const current = () => alive && run === gen;
      try {
        const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
        if (!current() || document.hidden) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = media;
        // continuous focus where the camera offers it
        await media.getVideoTracks()[0].applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => {});
        if (!current()) return;
        video.current!.srcObject = media;
        await video.current!.play();
        if (!current()) return;
        // the picture and the shutter work while the page finder loads
        setState("loading");
        const model = await detector.ready;
        if (!current()) return;
        setState(model ? "searching" : "manual");
        if (model) void tick();
      } catch (e) {
        const name = (e as DOMException).name;
        if (current() && name !== "AbortError") onUnavailable(name === "NotAllowedError" ? "denied" : "none");
      }
    }

    // the camera is let go while the tab is hidden and taken again when it comes back
    const visibility = () => (document.hidden ? stop() : void start());
    document.addEventListener("visibilitychange", visibility);
    void start();
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", visibility);
      stop();
      release(scratch);
    };
  }, []);

  // the shutter takes focus once the camera is running
  useEffect(() => {
    if (state !== "starting") shutter.current?.focus({ preventScroll: true });
  }, [state === "starting"]);

  useEffect(() => {
    say(t(`scan.state_${state}`));
  }, [state]);
  useEffect(() => {
    if (seen?.issues.length) say(seen.issues.map((i) => t(`scan.issue_${i}`)).join(" "));
  }, [seen?.issues.join()]);

  const [w, h] = dims;
  return (
    <>
      <div class="viewfinder" style={{ aspectRatio: `${w} / ${h}` }}>
        <video ref={video} playsinline muted aria-label={t("scan.camera_label")} />
        {seen && (
          <svg viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
            <polygon class={seen.issues.length ? "warn" : state === "hold" ? "ok" : ""} points={seen.quad.map((p) => p.join(",")).join(" ")} />
          </svg>
        )}
      </div>
      <p class="scan-status">{seen?.issues.length ? seen.issues.map((i) => t(`scan.issue_${i}`)).join(" ") : t(`scan.state_${state}`)}</p>
      <label class="check">
        <input type="checkbox" checked={auto} disabled={state === "manual" || state === "loading" || state === "starting"} onChange={(e) => setAuto(e.currentTarget.checked)} />
        <span>{t("scan.auto")}</span>
      </label>
      <div class="shutter">
        <button ref={shutter} type="button" class="primary" disabled={state === "starting"} onClick={() => grab(live.current.seen && Date.now() - live.current.seen.at < 1000 ? live.current.seen : null)}>
          {t("scan.shutter")}
        </button>
      </div>
    </>
  );
}
