export type Theme = 'wechat' | 'imessage' | 'dark'

const THEME_KEY = 'app-theme'

export function getTheme(): Theme {
  if (typeof window === 'undefined') return 'wechat'
  return (localStorage.getItem(THEME_KEY) as Theme) || 'wechat'
}

export function setTheme(theme: Theme): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(THEME_KEY, theme)
  document.documentElement.setAttribute('data-theme', theme)
  applyTheme(theme)
}

export function initTheme(): void {
  if (typeof window === 'undefined') return
  const theme = getTheme()
  document.documentElement.setAttribute('data-theme', theme)
  applyTheme(theme)
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'dark') {
    root.style.setProperty('--app-bg', '#0f0f23')
    root.style.setProperty('--panel-bg', '#1a1a2e')
    root.style.setProperty('--chat-bg', '#0f0f23')
    root.style.setProperty('--text-primary', '#e2e8f0')
    root.style.setProperty('--text-secondary', '#94a3b8')
    root.style.setProperty('--border-color', '#2d2d44')
    root.style.setProperty('--user-bubble', '#166534')
    root.style.setProperty('--bot-bubble', '#1e1e3f')
    root.style.setProperty('--header-bg', '#0f0f23')
    root.style.setProperty('--header-text', '#e2e8f0')
    root.style.setProperty('--accent', '#22c55e')
    root.style.setProperty('--accent-hover', '#16a34a')
    root.style.setProperty('--input-bg', '#1a1a2e')
    root.style.setProperty('--empty-bg', '#1a1a2e')
    root.style.setProperty('--card-bg', '#1a1a2e')
    root.style.setProperty('--card-border', '#2d2d44')
  } else if (theme === 'imessage') {
    root.style.setProperty('--app-bg', '#f2f2f7')
    root.style.setProperty('--panel-bg', '#fff')
    root.style.setProperty('--chat-bg', '#f2f2f7')
    root.style.setProperty('--text-primary', '#000')
    root.style.setProperty('--text-secondary', '#8e8e93')
    root.style.setProperty('--border-color', '#e5e5ea')
    root.style.setProperty('--user-bubble', '#007aff')
    root.style.setProperty('--bot-bubble', '#e5e5ea')
    root.style.setProperty('--header-bg', '#f2f2f7')
    root.style.setProperty('--header-text', '#000')
    root.style.setProperty('--accent', '#007aff')
    root.style.setProperty('--accent-hover', '#0051d5')
    root.style.setProperty('--input-bg', '#fff')
    root.style.setProperty('--empty-bg', '#fff')
    root.style.setProperty('--card-bg', '#fff')
    root.style.setProperty('--card-border', '#e5e5ea')
  } else {
    // wechat default
    root.style.setProperty('--app-bg', '#f0f2f5')
    root.style.setProperty('--panel-bg', '#fff')
    root.style.setProperty('--chat-bg', '#f0f2f5')
    root.style.setProperty('--text-primary', '#111827')
    root.style.setProperty('--text-secondary', '#6b7280')
    root.style.setProperty('--border-color', '#e5e7eb')
    root.style.setProperty('--user-bubble', '#95ec69')
    root.style.setProperty('--bot-bubble', '#fff')
    root.style.setProperty('--header-bg', '#1e1b4b')
    root.style.setProperty('--header-text', '#fff')
    root.style.setProperty('--accent', '#07c160')
    root.style.setProperty('--accent-hover', '#06ad56')
    root.style.setProperty('--input-bg', '#fff')
    root.style.setProperty('--empty-bg', '#fff')
    root.style.setProperty('--card-bg', '#fff')
    root.style.setProperty('--card-border', '#e5e7eb')
  }
}
