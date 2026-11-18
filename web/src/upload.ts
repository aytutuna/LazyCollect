import { ApiError } from "./api";

export const MAX_SIZE = 25 * 1024 * 1024;
const LONG_EDGE = 2400;

export type Prepared = { blob: Blob; name: string; jpeg: boolean };

const withExt = (name: string, ext: string) => `${name.replace(/\.[^./\\]*$/, "") || "photo"}.${ext}`;

// Photos shrink on the device so a phone camera shot is a few hundred kB, not 8 MB.
// A format the browser can't decode (some HEIC) goes up unchanged.
export async function prepareImage(file: File): Promise<Prepared> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, LONG_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/jpeg", 0.82));
    canvas.width = canvas.height = 0;
    if (blob) return { blob, name: withExt(file.name, "jpg"), jpeg: true };
  } catch {
    // fall through to the original
  }
  return { blob: file, name: file.name, jpeg: false };
}

// pdf-lib is large, so it loads only when someone combines photos
export async function combineToPdf(images: Blob[], name: string): Promise<Prepared> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  for (const image of images) {
    const jpg = await doc.embedJpg(new Uint8Array(await image.arrayBuffer()));
    const fit = 842 / Math.max(jpg.width, jpg.height);
    const page = doc.addPage([jpg.width * fit, jpg.height * fit]);
    page.drawImage(jpg, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }
  return { blob: new Blob([(await doc.save()) as BlobPart], { type: "application/pdf" }), name: withExt(name, "pdf"), jpeg: false };
}

export function sendFile(url: string, file: Prepared, uploadId: string, onProgress: (done: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("X-Collect", "1");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.setRequestHeader("Upload-Id", uploadId);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let code = "server_error";
      try {
        code = JSON.parse(xhr.responseText).error ?? code;
      } catch {
        // keep the generic code
      }
      reject(new ApiError(xhr.status, code));
    };
    xhr.onerror = xhr.ontimeout = () => reject(new ApiError(0, "network"));
    xhr.send(file.blob);
  });
}
