// Catalog languages: display names (endonyms), the franc ISO 639-3 ↔ catalog ISO 639-1 map, and
// the default target. English is the pivot.
import { PAIRS } from './catalog';

export interface Language {
  code: string;
  name: string; // endonym
  english: string;
}

/** [endonym, English name, franc ISO 639-3 code or null] for every catalog code. */
const TABLE: Record<string, [string, string, string | null]> = {
  af: ['Afrikaans', 'Afrikaans', 'afr'],
  ar: ['العربية', 'Arabic', 'arb'],
  az: ['Azərbaycanca', 'Azerbaijani', 'azj'],
  be: ['Беларуская', 'Belarusian', 'bel'],
  bg: ['Български', 'Bulgarian', 'bul'],
  bn: ['বাংলা', 'Bengali', 'ben'],
  bs: ['Bosanski', 'Bosnian', 'bos'],
  ca: ['Català', 'Catalan', 'cat'],
  cs: ['Čeština', 'Czech', 'ces'],
  da: ['Dansk', 'Danish', 'dan'],
  de: ['Deutsch', 'German', 'deu'],
  el: ['Ελληνικά', 'Greek', 'ell'],
  en: ['English', 'English', 'eng'],
  es: ['Español', 'Spanish', 'spa'],
  et: ['Eesti', 'Estonian', 'ekk'],
  eu: ['Euskara', 'Basque', 'eus'],
  fa: ['فارسی', 'Persian', 'pes'],
  fi: ['Suomi', 'Finnish', 'fin'],
  fr: ['Français', 'French', 'fra'],
  gl: ['Galego', 'Galician', 'glg'],
  gu: ['ગુજરાતી', 'Gujarati', 'guj'],
  he: ['עברית', 'Hebrew', 'heb'],
  hi: ['हिन्दी', 'Hindi', 'hin'],
  hr: ['Hrvatski', 'Croatian', 'hrv'],
  hu: ['Magyar', 'Hungarian', 'hun'],
  id: ['Bahasa Indonesia', 'Indonesian', 'ind'],
  is: ['Íslenska', 'Icelandic', 'isl'],
  it: ['Italiano', 'Italian', 'ita'],
  ja: ['日本語', 'Japanese', 'jpn'],
  kn: ['ಕನ್ನಡ', 'Kannada', 'kan'],
  ko: ['한국어', 'Korean', 'kor'],
  lt: ['Lietuvių', 'Lithuanian', 'lit'],
  lv: ['Latviešu', 'Latvian', 'lvs'],
  ml: ['മലയാളം', 'Malayalam', 'mal'],
  mr: ['मराठी', 'Marathi', 'mar'],
  ms: ['Bahasa Melayu', 'Malay', 'zlm'],
  nb: ['Norsk bokmål', 'Norwegian Bokmål', 'nob'],
  nl: ['Nederlands', 'Dutch', 'nld'],
  pl: ['Polski', 'Polish', 'pol'],
  pt: ['Português', 'Portuguese', 'por'],
  ro: ['Română', 'Romanian', 'ron'],
  ru: ['Русский', 'Russian', 'rus'],
  sk: ['Slovenčina', 'Slovak', 'slk'],
  sl: ['Slovenščina', 'Slovenian', 'slv'],
  sq: ['Shqip', 'Albanian', 'als'],
  sr: ['Српски', 'Serbian', 'srp'],
  sv: ['Svenska', 'Swedish', 'swe'],
  ta: ['தமிழ்', 'Tamil', 'tam'],
  te: ['తెలుగు', 'Telugu', 'tel'],
  th: ['ไทย', 'Thai', 'tha'],
  tl: ['Tagalog', 'Tagalog', 'tgl'],
  tr: ['Türkçe', 'Turkish', 'tur'],
  ug: ['ئۇيغۇرچە', 'Uyghur', 'uig'],
  uk: ['Українська', 'Ukrainian', 'ukr'],
  ur: ['اردو', 'Urdu', 'urd'],
  vi: ['Tiếng Việt', 'Vietnamese', 'vie'],
  'zh-Hans': ['简体中文', 'Chinese (Simplified)', 'cmn'],
  // franc has one Chinese ('cmn'); it maps back to zh-Hans unless only zh-Hant is a candidate.
  'zh-Hant': ['繁體中文', 'Chinese (Traditional)', 'cmn'],
};

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function intlName(code: string, locale: string): string | null {
  try {
    const n = new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' }).of(code);
    return n && n !== code ? n : null;
  } catch {
    return null;
  }
}

/** Endonym from the table, else Intl's own-locale name, else the code. */
export function languageName(code: string): string {
  if (own(TABLE, code)) return TABLE[code][0];
  const n = intlName(code, code);
  return n ? n.charAt(0).toLocaleUpperCase(code) + n.slice(1) : code;
}

function englishName(code: string): string {
  if (own(TABLE, code)) return TABLE[code][1];
  return intlName(code, 'en') ?? code;
}

export const LANGUAGES: readonly Language[] = [...new Set(PAIRS.flatMap((p) => [p.from, p.to]))]
  .map((code) => ({ code, name: languageName(code), english: englishName(code) }))
  .sort((a, b) => a.english.localeCompare(b.english, 'en'));

const CODES = new Set(LANGUAGES.map((l) => l.code));

const FROM_FRANC: Record<string, string> = {};
for (const [code, [, , iso3]] of Object.entries(TABLE)) {
  if (iso3 && !own(FROM_FRANC, iso3)) FROM_FRANC[iso3] = code;
}

/** franc's ISO 639-3 → catalog code; null for 'und' and languages Margin can't translate. */
export function fromFranc(iso3: string): string | null {
  if (!own(FROM_FRANC, iso3)) return null;
  const code = FROM_FRANC[iso3];
  return CODES.has(code) ? code : null;
}

/** Catalog code → franc's ISO 639-3, or null if franc has no such language. */
export function toFranc(code: string): string | null {
  return own(TABLE, code) ? TABLE[code][2] : null;
}

/** BCP 47 language tag (navigator.language) → the closest catalog language, else 'en'. */
export function pickDefaultTarget(navigatorLanguage: string | undefined): string {
  const parts = (navigatorLanguage ?? '').trim().split(/[-_]/).filter(Boolean);
  if (!parts.length) return 'en';
  const lang = parts[0].toLowerCase();
  const rest = parts.slice(1).map((p) => p.toLowerCase());
  let code: string;
  if (lang === 'zh') {
    const traditional = rest.includes('hant') || (!rest.includes('hans') && rest.some((r) => ['tw', 'hk', 'mo'].includes(r)));
    code = traditional ? 'zh-Hant' : 'zh-Hans';
  } else {
    const aliases: Record<string, string> = { no: 'nb', nn: 'nb', iw: 'he', in: 'id', fil: 'tl' };
    code = own(aliases, lang) ? aliases[lang] : lang;
  }
  return CODES.has(code) ? code : 'en';
}
