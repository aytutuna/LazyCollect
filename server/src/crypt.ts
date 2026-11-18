// File format: "LC1" + version byte, then 64 KiB plaintext chunks, each sealed with AES-GCM.
// The key is unique per file, so a nonce of 4 zero bytes + the chunk index never repeats.
// The AAD (last-chunk flag + index) makes truncation, reordering and dropped tails fail.
const encoder = new TextEncoder();

export const CHUNK = 64 * 1024;
const TAG = 16;
const HEADER = new Uint8Array([0x4c, 0x43, 0x31, 1]);

export const cipherLength = (plain: number) => HEADER.length + plain + TAG * Math.max(1, Math.ceil(plain / CHUNK));

export async function fileKey(dek: Uint8Array, fileId: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", dek, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(fileId), info: encoder.encode("lazycollect file v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function params(index: number, last: boolean) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(index));
  const additionalData = new Uint8Array(9);
  additionalData[0] = last ? 1 : 0;
  new DataView(additionalData.buffer).setBigUint64(1, BigInt(index));
  return { name: "AES-GCM", iv, additionalData } as const;
}

// pulls exact-size pieces out of a stream; a short piece means the stream ended
export class ByteSource {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private parts: Uint8Array[] = [];
  private held = 0;
  private ended = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async read(n: number): Promise<Uint8Array> {
    while (this.held < n && !this.ended) {
      const { value, done } = await this.reader.read();
      if (done) this.ended = true;
      else if (value.length) {
        this.parts.push(value);
        this.held += value.length;
      }
    }
    const out = new Uint8Array(Math.min(n, this.held));
    let at = 0;
    while (at < out.length) {
      const part = this.parts[0];
      const take = Math.min(part.length, out.length - at);
      out.set(part.subarray(0, take), at);
      at += take;
      if (take === part.length) this.parts.shift();
      else this.parts[0] = part.subarray(take);
    }
    this.held -= out.length;
    return out;
  }
}

// `first` is the first plaintext chunk, already read by the caller to look at its type
export function encryptStream(key: CryptoKey, source: ByteSource, first: Uint8Array, total: number): ReadableStream<Uint8Array> {
  let index = 0;
  let offset = 0;
  let header = true;
  return new ReadableStream({
    async pull(controller) {
      if (header) {
        header = false;
        controller.enqueue(HEADER);
        return;
      }
      const want = Math.min(CHUNK, total - offset);
      const plain = index === 0 ? first : await source.read(want);
      if (plain.length !== want) throw new Error("body shorter than its length");
      offset += plain.length;
      const sealed = await crypto.subtle.encrypt(params(index, offset === total), key, plain);
      controller.enqueue(new Uint8Array(sealed));
      index++;
      if (offset === total) controller.close();
    },
  });
}

// the first chunk is opened before returning, so a bad object fails before any bytes go out
export async function decryptStream(key: CryptoKey, body: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const source = new ByteSource(body);
  const head = await source.read(HEADER.length);
  if (head.length !== HEADER.length || head.some((b, i) => b !== HEADER[i])) throw new Error("not a file object");
  let current = await source.read(CHUNK + TAG);
  let index = 0;
  const open = async () => {
    const next = await source.read(CHUNK + TAG);
    const last = next.length === 0;
    if (current.length < TAG) throw new Error("truncated object");
    const plain = new Uint8Array(await crypto.subtle.decrypt(params(index, last), key, current));
    current = next;
    index++;
    return { plain, last };
  };
  let ready = await open();
  return new ReadableStream({
    async pull(controller) {
      controller.enqueue(ready.plain);
      if (ready.last) controller.close();
      else ready = await open();
    },
  });
}
