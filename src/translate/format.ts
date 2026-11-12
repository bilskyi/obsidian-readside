// Sizes and progress as the translation UI says them (spec §A5): MB = 10^6 bytes, one decimal, and a
// whole number without its ".0" ("41 MB", "12.4 MB").
import type { DownloadProgress } from './types';

export function formatMB(bytes: number): string {
  const tenths = Math.round(Math.max(0, bytes) / 100_000);
  return tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1);
}

/** `Downloading… 12.4 of 41 MB` */
export function downloadingText(p: DownloadProgress): string {
  return `Downloading… ${formatMB(p.received)} of ${formatMB(p.total)} MB`;
}
