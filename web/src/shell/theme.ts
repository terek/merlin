// The theme: system (follows the OS), light or dark. `?theme=` on any URL sets it before first
// paint (public/theme-init.js); the choice is remembered in localStorage and written to
// `data-theme` on <html>, which the tokens in styles.css key on.

import { useSyncExternalStore } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'

const KEY = 'explorer-theme'
const listeners = new Set<() => void>()

export function getTheme(): ThemeChoice {
  const t = document.documentElement.dataset.theme
  return t === 'light' || t === 'dark' ? t : 'system'
}

export function setTheme(t: ThemeChoice) {
  if (t === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
  try {
    if (t === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, t)
  } catch {
    // storage unavailable: the choice lasts for this page only
  }
  for (const l of listeners) l()
}

const ORDER: ThemeChoice[] = ['system', 'light', 'dark']

export const nextTheme = (t: ThemeChoice): ThemeChoice => ORDER[(ORDER.indexOf(t) + 1) % ORDER.length]

export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const t = useSyncExternalStore((l) => {
    listeners.add(l)
    return () => void listeners.delete(l)
  }, getTheme)
  return [t, setTheme]
}
