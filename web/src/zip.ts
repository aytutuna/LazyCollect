// A stored (uncompressed) zip built in the browser. Each file's bytes go into a Blob as soon as they are checksummed,
// so a large request does not keep every file in memory as an array.
const encoder = new TextEncoder();

const TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dos(ms: number): [number, number] {
  const d = new Date(ms);
  return [(d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()];
}

export class ZipWriter {
  private parts: BlobPart[] = [];
  private central: BlobPart[] = [];
  private offset = 0;

  async add(name: string, blob: Blob, mtime = Date.now()) {
    const n = encoder.encode(name);
    const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
    const [time, date] = dos(mtime);
    // bit 11: the name is UTF-8
    const local = new DataView(new ArrayBuffer(30));
    const rec = new DataView(new ArrayBuffer(46));
    local.setUint32(0, 0x04034b50, true);
    rec.setUint32(0, 0x02014b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x800, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, blob.size, true);
    local.setUint32(22, blob.size, true);
    local.setUint16(26, n.length, true);
    rec.setUint16(4, 20, true);
    rec.setUint16(6, 20, true);
    rec.setUint16(8, 0x800, true);
    rec.setUint16(12, time, true);
    rec.setUint16(14, date, true);
    rec.setUint32(16, crc, true);
    rec.setUint32(20, blob.size, true);
    rec.setUint32(24, blob.size, true);
    rec.setUint16(28, n.length, true);
    rec.setUint32(42, this.offset, true);
    this.central.push(new Uint8Array([...new Uint8Array(rec.buffer), ...n]));
    this.parts.push(new Uint8Array(local.buffer), n as BlobPart, blob);
    this.offset += 30 + n.length + blob.size;
  }

  finish(): Blob {
    const size = this.central.reduce((sum, c) => sum + (c as Uint8Array).length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.central.length, true);
    end.setUint16(10, this.central.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, end.buffer as ArrayBuffer], { type: "application/zip" });
  }
}
