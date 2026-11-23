// Stored (uncompressed) zip written as a stream: sizes and CRC follow each entry in a data descriptor.
const encoder = new TextEncoder();

const TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

// pass the previous result to continue over the next piece
export function crc32(data: Uint8Array, previous = 0): number {
  let c = ~previous;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// a name that is safe as one path part on every system a file might be unzipped on
export function cleanName(s: string, max: number, fallback: string): string {
  const name = Array.from(
    s
      .replace(/[\u0000-\u001f\u007f-\u009f\\/:*?"<>|]/g, "_")
      .trim()
      .replace(/^\.+/, "")
      .trim(),
  )
    .slice(0, max)
    .join("")
    .replace(/[. ]+$/, "");
  const safe = name || fallback;
  // Windows refuses these as file names, with or without an extension
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(safe) ? `_${safe}` : safe;
}

// the first free name among those seen, compared without regard to case
export function uniqueName(name: string, seen: Set<string>): string {
  let out = name;
  for (let n = 2; seen.has(out.toLowerCase()); n++) out = `${name} (${n})`;
  seen.add(out.toLowerCase());
  return out;
}

const EXTRA = 9; // extended timestamp: id, size, flags, mtime

// bytes an entry adds around its data: local header, descriptor, central record
export const entryOverhead = (nameBytes: number) => 30 + EXTRA + 16 + 46 + EXTRA + 2 * nameBytes;
export const END_RECORD = 22;

export type ZipEntry = { name: string; mtime: number; open: () => Promise<ReadableStream<Uint8Array>> };

function dosTime(ms: number): [number, number] {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  if (year < 1980) return [0, 0x21];
  return [(d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1), ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()];
}

function extra(v: DataView, at: number, ms: number) {
  v.setUint16(at, 0x5455, true);
  v.setUint16(at + 2, 5, true);
  v.setUint8(at + 4, 1);
  v.setUint32(at + 5, Math.floor(ms / 1000), true);
}

// fixed part, then the name, then the timestamp field when there is one
function record(size: number, fill: (v: DataView) => void, name?: Uint8Array, mtime?: number): Uint8Array {
  const out = new Uint8Array(size + (name?.length ?? 0) + (mtime === undefined ? 0 : EXTRA));
  const v = new DataView(out.buffer);
  fill(v);
  if (name) out.set(name, size);
  if (mtime !== undefined) extra(v, size + (name?.length ?? 0), mtime);
  return out;
}

const FLAGS = 0x0808; // data descriptor follows, names are UTF-8

export function zipStream(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  const central: Uint8Array[] = [];
  let offset = 0;
  let next = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let crc = 0;
  let size = 0;
  let start = 0;
  let name: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let time: [number, number] = [0, 0];
  let mtime = 0;

  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array) => {
    controller.enqueue(chunk);
    offset += chunk.length;
  };

  return new ReadableStream({
    async pull(controller) {
      if (!reader) {
        if (next === entries.length) {
          const directory = offset;
          let length = 0;
          for (const r of central) {
            emit(controller, r);
            length += r.length;
          }
          emit(
            controller,
            record(22, (v) => {
              v.setUint32(0, 0x06054b50, true);
              v.setUint16(8, central.length, true);
              v.setUint16(10, central.length, true);
              v.setUint32(12, length, true);
              v.setUint32(16, directory, true);
            }),
          );
          controller.close();
          return;
        }
        const entry = entries[next];
        name = encoder.encode(entry.name);
        time = dosTime(entry.mtime);
        mtime = entry.mtime;
        start = offset;
        crc = 0;
        size = 0;
        reader = (await entry.open()).getReader();
        emit(
          controller,
          record(
            30,
            (v) => {
              v.setUint32(0, 0x04034b50, true);
              v.setUint16(4, 20, true);
              v.setUint16(6, FLAGS, true);
              v.setUint16(10, time[0], true);
              v.setUint16(12, time[1], true);
              v.setUint16(26, name.length, true);
              v.setUint16(28, EXTRA, true);
            },
            name,
            mtime,
          ),
        );
        return;
      }
      const { value, done } = await reader.read();
      if (!done) {
        crc = crc32(value, crc);
        size += value.length;
        emit(controller, value);
        return;
      }
      reader = null;
      next++;
      emit(
        controller,
        record(16, (v) => {
          v.setUint32(0, 0x08074b50, true);
          v.setUint32(4, crc, true);
          v.setUint32(8, size, true);
          v.setUint32(12, size, true);
        }),
      );
      central.push(
        record(
          46,
          (v) => {
            v.setUint32(0, 0x02014b50, true);
            v.setUint16(4, 20, true);
            v.setUint16(6, 20, true);
            v.setUint16(8, FLAGS, true);
            v.setUint16(12, time[0], true);
            v.setUint16(14, time[1], true);
            v.setUint32(16, crc, true);
            v.setUint32(20, size, true);
            v.setUint32(24, size, true);
            v.setUint16(28, name.length, true);
            v.setUint16(30, EXTRA, true);
            v.setUint32(42, start, true);
          },
          name,
          mtime,
        ),
      );
    },
    cancel() {
      return reader?.cancel();
    },
  });
}
