/**
 * Look-and-feel choices: theme, map background, and accessibility options. They are saved in
 * this browser and applied as attributes on <html>, where the stylesheet picks them up.
 */
import { useEffect, useState } from 'react'

export type Settings = {
  theme: 'system' | 'light' | 'dark'
  background: 'plain' | 'dots' | 'grid'
  largeText: boolean
  highContrast: boolean
  reduceMotion: boolean
}

const KEY = 'graphu.settings'
const DEFAULTS: Settings = { theme: 'system', background: 'plain', largeText: false, highContrast: false, reduceMotion: false }
const listeners = new Set<(settings: Settings) => void>()

function load(): Settings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } } catch { return DEFAULTS }
}

let current = load()

export function applySettings(settings: Settings = current) {
  const root = document.documentElement
  const dark = settings.theme === 'dark'
    || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  root.dataset.theme = dark ? 'dark' : 'light'
  root.dataset.background = settings.background
  root.dataset.text = settings.largeText ? 'large' : 'normal'
  root.dataset.contrast = settings.highContrast ? 'high' : 'normal'
  root.dataset.motion = settings.reduceMotion ? 'reduce' : 'normal'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1c1b19' : '#f8f7f4')
}

export function useSettings(): [Settings, (change: Partial<Settings>) => void] {
  const [settings, setSettings] = useState(current)
  useEffect(() => {
    listeners.add(setSettings)
    return () => { listeners.delete(setSettings) }
  }, [])
  return [settings, change => {
    current = { ...current, ...change }
    try { localStorage.setItem(KEY, JSON.stringify(current)) } catch { /* storage may be unavailable */ }
    applySettings()
    listeners.forEach(listener => listener(current))
  }]
}

// Follow the system when it switches between light and dark.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applySettings())
