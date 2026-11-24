/**
 * Appearance preference for the UI theme.
 *
 * The design tokens in `styles/tokens.css` define every palette: the default
 * light one (`:root`), dark (`:root[data-theme='dark']`), and the named themes
 * below. This module only decides *which* palette is active and remembers the
 * choice — it never introduces colors of its own.
 *
 * "System" follows the device between light and dark. A named theme is either
 * light or dark at heart (`mode`); dark ones also set `data-mode="dark"` so
 * the token sheet swaps in its dark-surface derivations.
 */

export interface ThemeInfo {
  id: Exclude<ThemePreference, 'system'>;
  label: string;
  mode: 'light' | 'dark';
  /** Background, surface, primary and accent, for a swatch. */
  swatch: [string, string, string, string];
}

/** Every theme, in the order the settings show them. */
export const THEMES = [
  {
    id: 'light',
    label: 'Light',
    mode: 'light',
    swatch: ['#f7ede2', '#fff7ef', '#c96f52', '#e89a63'],
  },
  { id: 'dark', label: 'Dark', mode: 'dark', swatch: ['#29221f', '#352b27', '#e28a68', '#f0aa70'] },
  {
    id: 'sage',
    label: 'Sage',
    mode: 'light',
    swatch: ['#eef1e8', '#f8faf3', '#5f8a5a', '#8fb07a'],
  },
  {
    id: 'slate',
    label: 'Slate',
    mode: 'light',
    swatch: ['#eef1f5', '#f8fafc', '#4a72b0', '#6f97cf'],
  },
  {
    id: 'lavender',
    label: 'Lavender',
    mode: 'light',
    swatch: ['#f3eff7', '#fbf8fd', '#8a63b8', '#b48fd8'],
  },
  {
    id: 'midnight',
    label: 'Midnight',
    mode: 'dark',
    swatch: ['#161c2b', '#1f2738', '#7aa2f7', '#9ab8f5'],
  },
  {
    id: 'forest',
    label: 'Forest',
    mode: 'dark',
    swatch: ['#18221c', '#202d25', '#8cc08a', '#b0d28a'],
  },
  {
    id: 'graphite',
    label: 'Graphite',
    mode: 'dark',
    swatch: ['#1c1c1e', '#262628', '#d9a066', '#e8b97f'],
  },
] as const satisfies readonly ThemeInfo[];

export type ThemePreference =
  'system' | 'light' | 'dark' | 'sage' | 'slate' | 'lavender' | 'midnight' | 'forest' | 'graphite';

export const THEME_STORAGE_KEY = 'cairn.theme';

const KNOWN = new Set<string>(['system', ...THEMES.map((t) => t.id)]);

/** The theme's details; undefined for "system". */
export function themeInfo(theme: ThemePreference): ThemeInfo | undefined {
  return THEMES.find((t) => t.id === theme);
}

/** Read the stored preference, defaulting to following the OS setting. */
export function readStoredTheme(): ThemePreference {
  if (typeof localStorage === 'undefined') return 'system';
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored && KNOWN.has(stored)) return stored as ThemePreference;
  } catch {
    // Storage can be unavailable (private mode, disabled cookies) — fall back.
  }
  return 'system';
}

/**
 * Apply a preference to the document. `system` removes the attributes so the
 * `prefers-color-scheme` media query in the token sheet takes over.
 */
export function applyTheme(theme: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const info = themeInfo(theme);
  if (!info) {
    delete root.dataset.theme;
    delete root.dataset.mode;
    return;
  }
  root.dataset.theme = info.id;
  // The plain dark theme carries its own derivations; the mode attribute is
  // for the named dark themes (and harmless on it).
  if (info.mode === 'dark') root.dataset.mode = 'dark';
  else delete root.dataset.mode;
}

/** Persist and immediately apply a preference. */
export function storeTheme(theme: ThemePreference): void {
  applyTheme(theme);
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // A failed write only means the choice is not remembered next visit.
  }
}
