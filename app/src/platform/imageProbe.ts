/**
 * Browser image probe (ADR 0007): decode generated image bytes and read their
 * dimensions via createImageBitmap. Browser-only (DOM), so it lives in platform/
 * and is verified manually / by typecheck, not unit-tested — same posture as
 * chromeStorage.ts and indexedDbStore.ts. A decode failure is a legitimate eval
 * signal (the generator returned non-image bytes), so it degrades to decoded:false
 * rather than throwing.
 */
import type { ImageProbe } from '../services/gen/imageGenerator';

export function browserImageProbe(): ImageProbe {
  return async (bytes, mime) => {
    try {
      const blob = new Blob([bytes as BlobPart], { type: mime });
      const bitmap = await createImageBitmap(blob);
      const result = { decoded: true, width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return result;
    } catch {
      return { decoded: false, width: 0, height: 0 };
    }
  };
}
