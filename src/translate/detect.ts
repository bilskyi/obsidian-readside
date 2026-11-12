// Language detection with franc-min (trigrams, 82 languages), limited to catalog languages.
import { franc } from 'franc-min';
import { LANGUAGES, fromFranc, toFranc } from './languages';

const MIN_LENGTH = 20;
const ALL = LANGUAGES.map((l) => l.code);

/**
 * The ISO 639-1 (catalog) code of `text`, or null when it is too short, undetermined, or not one
 * of `candidates` (default: every catalog language). Never returns a code outside `candidates`.
 */
export function detectLanguage(text: string, candidates: readonly string[] = ALL): string | null {
  // franc's `only: []` means "no restriction", so an empty mapped list must short-circuit.
  const byIso3 = new Map<string, string>();
  for (const c of candidates) {
    const f = toFranc(c);
    if (f && !byIso3.has(f)) byIso3.set(f, c);
  }
  if (!byIso3.size) return null;
  const trimmed = text.trim();
  if (trimmed.length < MIN_LENGTH) return null;
  const iso3 = franc(trimmed, { minLength: MIN_LENGTH, only: [...byIso3.keys()] });
  const canonical = fromFranc(iso3);
  if (canonical && candidates.includes(canonical)) return canonical;
  return byIso3.get(iso3) ?? null; // e.g. 'cmn' with only zh-Hant among the candidates
}
