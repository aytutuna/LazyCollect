import { useRef } from "preact/hooks";
import { t } from "../i18n";
import { usable, type Point, type Quad } from "./geometry";

const NAMES = ["top_left", "top_right", "bottom_right", "bottom_left"];

// Four handles on the photo. Each is a button: drag it, or focus it and use the arrow keys (shift for bigger steps).
export function CornerEditor({ url, width, height, quad, onChange, say }: { url: string; width: number; height: number; quad: Quad; onChange: (q: Quad) => void; say: (text: string) => void }) {
  const box = useRef<HTMLDivElement>(null);

  function move(i: number, to: Point) {
    const next = quad.map((p, k) => (k === i ? ([Math.min(Math.max(to[0], 0), width), Math.min(Math.max(to[1], 0), height)] as Point) : p)) as Quad;
    if (!usable(next)) return quad;
    onChange(next);
    return next;
  }

  function drag(i: number, e: PointerEvent) {
    const rect = box.current!.getBoundingClientRect();
    move(i, [((e.clientX - rect.left) / rect.width) * width, ((e.clientY - rect.top) / rect.height) * height]);
  }

  function key(i: number, e: KeyboardEvent) {
    const step = Math.max(1, Math.round(Math.min(width, height) * (e.shiftKey ? 0.02 : 0.004)));
    const by: Record<string, Point> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = by[e.key];
    if (!d) return;
    e.preventDefault();
    const p = move(i, [quad[i][0] + d[0], quad[i][1] + d[1]])[i];
    say(t("scan.corner_at", { name: t(`scan.${NAMES[i]}`), x: Math.round((p[0] / width) * 100), y: Math.round((p[1] / height) * 100) }));
  }

  return (
    <div class="corner-editor" ref={box}>
      <img src={url} alt={t("scan.photo_alt")} width={width} height={height} draggable={false} />
      <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        <polygon points={quad.map((p) => p.join(",")).join(" ")} />
      </svg>
      {quad.map((p, i) => (
        <button
          key={i}
          type="button"
          class="handle"
          style={{ left: `${(p[0] / width) * 100}%`, top: `${(p[1] / height) * 100}%` }}
          aria-label={t("scan.corner", { name: t(`scan.${NAMES[i]}`) })}
          aria-describedby="corner-help"
          onKeyDown={(e) => key(i, e)}
          onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
          onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && drag(i, e)}
        >
          <span aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
