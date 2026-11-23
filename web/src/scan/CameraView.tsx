import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n";
import { acceptable } from "./corners";
import type { Detector } from "./detector";
import { aspect, scaled, warp, type Quad } from "./geometry";
import { readPixels, shotOf, type Shot } from "./pipeline";
import { frameIssues, pageIssues, type Issue } from "./quality";

export type Capture = { shot: Shot; quad: Quad | null; confidence: number | null };

// frames for the page finder and the live checks are at most this wide
const LIVE = 800;
const TICK_MS = 120;
// the outline must hold this still (as a share of the frame's diagonal) for this long
const STILL = 0.02;
const HOLD_MS = 1000;

type Seen = { quad: Quad; confidence: number; issues: Issue[]; at: number };

export function CameraView({ detector, onCapture, onUnavailable, say }: { detector: Detector; onCapture: (c: Capture) => void; onUnavailable: (why: "denied" | "none") => void; say: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [dims, setDims] = useState<[number, number]>([4, 3]);
  const [seen, setSeen] = useState<Seen | null>(null);
  const [state, setState] = useState<"starting" | "searching" | "found" | "hold" | "manual">("starting");
  const [auto, setAuto] = useState(true);
  const live = useRef({ auto: true, seen: null as Seen | null, busy: false });
  live.current.auto = auto;

  async function grab(seenNow: Seen | null) {
    const v = video.current!;
    if (live.current.busy || !v.videoWidth) return;
    live.current.busy = true;
    const shot = await shotOf(v, v.videoWidth, v.videoHeight);
    // the outline is in video pixels; the shot may be a smaller copy of the frame
    const quad = seenNow ? scaled(seenNow.quad, shot.width / v.videoWidth, shot.height / v.videoHeight) : null;
    onCapture({ shot, quad, confidence: seenNow?.confidence ?? null });
  }

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let alive = true;
    let still = { quad: null as Quad | null, since: 0 };
    let advice = { key: "", times: 0 };
    let shownAdvice = "";

    const stop = () => {
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      if (video.current) video.current.srcObject = null;
    };

    async function tick() {
      const v = video.current;
      if (!alive || !stream || !v) return;
      if (v.readyState < 2 || !v.videoWidth) {
        timer = window.setTimeout(tick, TICK_MS);
        return;
      }
      setDims((d) => (d[0] === v.videoWidth && d[1] === v.videoHeight ? d : [v.videoWidth, v.videoHeight]));
      const frame = readPixels(v, v.videoWidth, v.videoHeight, LIVE);
      const found = await detector.detect({ ...frame, data: frame.data.slice() });
      if (!alive || !stream) return;
      const now = Date.now();
      if (found && acceptable(found, frame.width, frame.height)) {
        const quad = scaled(found.quad, frame.width, frame.height);
        const issues = frameIssues(quad, found.confidence, frame.width, frame.height);
        const ratio = aspect(quad, frame.width, frame.height);
        const long = 640;
        const flat = warp(frame, quad, ratio >= 1 ? long : Math.round(long * ratio), ratio >= 1 ? Math.round(long / ratio) : long);
        if (flat) issues.push(...pageIssues(flat));
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
          await grab(next);
          return;
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
      timer = window.setTimeout(tick, TICK_MS);
    }

    async function start() {
      if (stream || !navigator.mediaDevices?.getUserMedia) {
        if (!navigator.mediaDevices?.getUserMedia) onUnavailable("none");
        return;
      }
      try {
        const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
        if (!alive || document.hidden) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = media;
        // continuous focus where the camera offers it
        await media.getVideoTracks()[0].applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => {});
        video.current!.srcObject = media;
        await video.current!.play();
        const model = await detector.ready;
        setState(model ? "searching" : "manual");
        if (model) tick();
      } catch (e) {
        if (alive) onUnavailable((e as DOMException).name === "NotAllowedError" ? "denied" : "none");
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
    };
  }, []);

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
        <input type="checkbox" checked={auto} disabled={state === "manual"} onChange={(e) => setAuto(e.currentTarget.checked)} />
        <span>{t("scan.auto")}</span>
      </label>
      <div class="shutter">
        <button type="button" class="primary" disabled={state === "starting"} onClick={() => grab(live.current.seen && Date.now() - live.current.seen.at < 1000 ? live.current.seen : null)}>
          {t("scan.shutter")}
        </button>
      </div>
    </>
  );
}
