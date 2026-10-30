import { useEffect, useState } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';

const KEY = 'factory.theme.v1';
const DARK_QUERY = '(prefers-color-scheme: dark)';
const META_COLORS = { light: '#faf9f5', dark: '#191919' };

export function readTheme(): ThemePreference {
  try {
    const value = window.localStorage.getItem(KEY);
    if (value === 'light' || value === 'dark' || value === 'system')
      return value;
  } catch {
    // Storage can be blocked; fall back to following the system.
  }
  return 'system';
}

function resolve(pref: ThemePreference): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

export function applyTheme(pref: ThemePreference): void {
  const theme = resolve(pref);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', META_COLORS[theme]);
  document
    .querySelector('#app-icon')
    ?.setAttribute(
      'href',
      theme === 'dark'
        ? '/durable-factory-icon-dark-32.png?v=3'
        : '/durable-factory-icon-32.png?v=3',
    );
}

export function useTheme(): [ThemePreference, (pref: ThemePreference) => void] {
  const [pref, setPrefState] = useState<ThemePreference>(readTheme);

  useEffect(() => {
    applyTheme(pref);
    if (pref !== 'system') return;
    const query = window.matchMedia(DARK_QUERY);
    const onChange = () => applyTheme('system');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [pref]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === KEY) setPrefState(readTheme());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setPref = (next: ThemePreference) => {
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // Preference still applies for this session.
    }
    setPrefState(next);
  };
  return [pref, setPref];
}
