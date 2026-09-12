export type Locale = 'en' | 'de' | 'fr' | 'zh-CN' | 'zh-TW' | 'uk' | 'es' | 'pt-BR' | 'ko' | 'pl' | 'ja' | 'tr';

// pigeon fork: this build ships as a Simplified-Chinese-only UI.
// `LOCALES` is the list offered by the appearance settings picker; the other
// locale dictionaries stay in the repository so upstream i18n work still merges.
export const LOCALES = ['zh-CN'] as const satisfies readonly Locale[];

export const DEFAULT_LOCALE: Locale = 'zh-CN';

export const LOCALE_LABEL_KEYS: Record<Locale, 'common.language.english' | 'common.language.french' | 'common.language.simplifiedChinese' | 'common.language.traditionalChinese' | 'common.language.ukrainian' | 'common.language.spanish' | 'common.language.brazilianPortuguese' | 'common.language.korean' | 'common.language.polish' | 'common.language.german' | 'common.language.japanese' | 'common.language.turkish'> = {
  en: 'common.language.english',
  fr: 'common.language.french',
  'zh-CN': 'common.language.simplifiedChinese',
  'zh-TW': 'common.language.traditionalChinese',
  uk: 'common.language.ukrainian',
  es: 'common.language.spanish',
  'pt-BR': 'common.language.brazilianPortuguese',
  ko: 'common.language.korean',
  pl: 'common.language.polish',
  de: 'common.language.german',
  ja: 'common.language.japanese',
  tr: 'common.language.turkish',
};

export const LOCALE_STORAGE_KEY = 'openchamber.i18n.v1';

type StoredLocale = {
  locale?: unknown;
};

/**
 * pigeon fork: the UI is locked to Simplified Chinese, so every entry point
 * (stored preference, VS Code host language, host-provided hints) resolves to
 * Chinese rather than silently falling back to another language.
 */
export function normalizeLocale(value: string | undefined | null): Locale {
  void value;
  return DEFAULT_LOCALE;
}

function readStoredLocale(): Locale | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as StoredLocale;
    return typeof parsed.locale === 'string' ? normalizeLocale(parsed.locale) : undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredLocale(locale: Locale): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, JSON.stringify({ locale }));
  } catch {
    return;
  }
}

declare global {
  interface Window {
    /** The host application's display language (VS Code sets it), used before the user picks a locale. */
    __OPENCHAMBER_HOST_LANGUAGE__?: string;
  }
}

export function detectInitialLocale(): Locale {
  const stored = readStoredLocale();
  if (stored) {
    return stored;
  }

  const hostLanguage = globalThis.window?.__OPENCHAMBER_HOST_LANGUAGE__;
  if (hostLanguage) {
    return normalizeLocale(hostLanguage);
  }

  return DEFAULT_LOCALE;
}
