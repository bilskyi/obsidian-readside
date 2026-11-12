// Routes a translation through the catalog: a direct pair, else two legs through English (every
// published pair has English on one side), and the download offer for what is missing.
import { ENGINE, PAIRS, type CatalogFile, type CatalogPair } from './catalog';
import { languageName } from './languages';
import type { DownloadOffer } from './types';

export interface Leg {
  from: string;
  to: string;
  pair: CatalogPair;
}

export type Route = { kind: 'same' } | { kind: 'unsupported' } | { kind: 'ok'; legs: Leg[] };

const PIVOT = 'en';

export const pairKey = (from: string, to: string): string => `${from}-${to}`;

const BY_KEY = new Map(PAIRS.map((p) => [pairKey(p.from, p.to), p]));

function leg(from: string, to: string): Leg | null {
  const pair = BY_KEY.get(pairKey(from, to));
  return pair ? { from, to, pair } : null;
}

export function route(from: string, to: string): Route {
  if (from === to) return { kind: 'same' };
  const direct = leg(from, to);
  if (direct) return { kind: 'ok', legs: [direct] };
  if (from === PIVOT || to === PIVOT) return { kind: 'unsupported' };
  const a = leg(from, PIVOT);
  const b = leg(PIVOT, to);
  return a && b ? { kind: 'ok', legs: [a, b] } : { kind: 'unsupported' };
}

/** Every file of the legs, in order; the engine wasm first when `engine` is true. */
export function filesFor(legs: readonly Leg[], engine = false): CatalogFile[] {
  return [...(engine ? [ENGINE.file] : []), ...legs.flatMap((l) => l.pair.files)];
}

export function totalBytes(files: readonly CatalogFile[]): number {
  return files.reduce((s, f) => s + f.size, 0);
}

/** What still has to be downloaded for these legs, or null when everything is installed. */
export function offerFor(
  legs: readonly Leg[],
  installed: (key: string) => boolean,
  engineInstalled: boolean,
): DownloadOffer | null {
  if (!legs.length) return null;
  const parts: DownloadOffer['parts'] = [];
  if (!engineInstalled) parts.push({ label: 'Translation engine', bytes: ENGINE.file.size });
  for (const l of legs) {
    if (installed(pairKey(l.from, l.to))) continue;
    parts.push({ label: `${languageName(l.from)} → ${languageName(l.to)}`, bytes: totalBytes(l.pair.files) });
  }
  if (!parts.length) return null;
  return {
    from: legs[0].from,
    to: legs[legs.length - 1].to,
    bytes: parts.reduce((s, p) => s + p.bytes, 0),
    parts,
  };
}
