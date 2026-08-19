import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { catalog, type SupportedLocale, type Translation } from './catalog';

const STORAGE_KEY = 'awo.workbench.locale.v1';

export interface LocaleContextValue {
  locale: SupportedLocale;
  messages: Translation;
  setLocale(locale: SupportedLocale): void;
}

const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

function initialLocale(): SupportedLocale {
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === 'zh-CN' || saved === 'en') return saved;
  return navigator.language.toLocaleLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<SupportedLocale>(initialLocale);
  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, locale);
    document.documentElement.lang = locale;
  }, [locale]);
  const value = useMemo<LocaleContextValue>(() => ({ locale, messages: catalog[locale], setLocale }), [locale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) throw new Error('useLocale 必须在 LocaleProvider 内使用');
  return context;
}
