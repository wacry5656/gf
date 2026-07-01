export type Theme = 'wechat' | 'imessage' | 'dark' | 'sakura' | 'ocean'

const THEME_KEY = 'app-theme'

export interface ThemeMeta {
  id: Theme
  label: string
  emoji: string
}

/** 可选主题列表（用于主题菜单展示）。 */
export const THEMES: ThemeMeta[] = [
  { id: 'wechat', label: '微信绿', emoji: '💬' },
  { id: 'imessage', label: '蓝色气泡', emoji: '💙' },
  { id: 'sakura', label: '樱花粉', emoji: '🌸' },
  { id: 'ocean', label: '深海蓝', emoji: '🌊' },
  { id: 'dark', label: '暗夜', emoji: '🌙' },
]

type ThemeVars = Record<string, string>

const THEME_VARS: Record<Theme, ThemeVars> = {
  wechat: {
    '--app-bg': '#f0f2f5',
    '--panel-bg': '#fff',
    '--chat-bg': '#f0f2f5',
    '--text-primary': '#111827',
    '--text-secondary': '#6b7280',
    '--border-color': '#e5e7eb',
    '--user-bubble': '#95ec69',
    '--bot-bubble': '#fff',
    '--header-bg': '#1e1b4b',
    '--header-text': '#fff',
    '--accent': '#07c160',
    '--accent-hover': '#06ad56',
    '--accent-glow': 'rgba(7, 193, 96, 0.35)',
    '--input-bg': '#fff',
    '--empty-bg': '#fff',
    '--card-bg': '#fff',
    '--card-border': '#e5e7eb',
    '--ambient-a': 'rgba(124, 92, 255, 0.10)',
    '--ambient-b': 'rgba(233, 95, 128, 0.10)',
    '--particle-color': 'rgba(124, 92, 255, 0.45)',
  },
  imessage: {
    '--app-bg': '#f2f2f7',
    '--panel-bg': '#fff',
    '--chat-bg': '#f2f2f7',
    '--text-primary': '#000',
    '--text-secondary': '#8e8e93',
    '--border-color': '#e5e5ea',
    '--user-bubble': '#007aff',
    '--bot-bubble': '#e5e5ea',
    '--header-bg': '#f2f2f7',
    '--header-text': '#000',
    '--accent': '#007aff',
    '--accent-hover': '#0051d5',
    '--accent-glow': 'rgba(0, 122, 255, 0.35)',
    '--input-bg': '#fff',
    '--empty-bg': '#fff',
    '--card-bg': '#fff',
    '--card-border': '#e5e5ea',
    '--ambient-a': 'rgba(0, 122, 255, 0.10)',
    '--ambient-b': 'rgba(90, 200, 250, 0.12)',
    '--particle-color': 'rgba(0, 122, 255, 0.4)',
  },
  sakura: {
    '--app-bg': 'linear-gradient(160deg, #fff1f5 0%, #ffe4ef 45%, #fbe7ff 100%)',
    '--panel-bg': '#fffafc',
    '--chat-bg': 'linear-gradient(160deg, #fff1f5 0%, #ffe8f1 100%)',
    '--text-primary': '#4a2536',
    '--text-secondary': '#a76b85',
    '--border-color': '#f6d6e4',
    '--user-bubble': '#ffb3d1',
    '--bot-bubble': '#fffdfe',
    '--header-bg': 'linear-gradient(135deg, #ff7eb3, #ff65a3)',
    '--header-text': '#fff',
    '--accent': '#ff5fa2',
    '--accent-hover': '#f0408c',
    '--accent-glow': 'rgba(255, 95, 162, 0.4)',
    '--input-bg': '#fffafc',
    '--empty-bg': '#fffafc',
    '--card-bg': '#fffafc',
    '--card-border': '#f6d6e4',
    '--ambient-a': 'rgba(255, 126, 179, 0.16)',
    '--ambient-b': 'rgba(214, 130, 255, 0.14)',
    '--particle-color': 'rgba(255, 126, 179, 0.6)',
  },
  ocean: {
    '--app-bg': 'linear-gradient(160deg, #eefcff 0%, #dff3ff 50%, #e6ecff 100%)',
    '--panel-bg': '#f7fdff',
    '--chat-bg': 'linear-gradient(160deg, #eafaff 0%, #e0f1ff 100%)',
    '--text-primary': '#0f2b41',
    '--text-secondary': '#5c7c93',
    '--border-color': '#cfe8f5',
    '--user-bubble': '#5ec8ff',
    '--bot-bubble': '#ffffff',
    '--header-bg': 'linear-gradient(135deg, #0ea5e9, #2563eb)',
    '--header-text': '#fff',
    '--accent': '#0ea5e9',
    '--accent-hover': '#0284c7',
    '--accent-glow': 'rgba(14, 165, 233, 0.4)',
    '--input-bg': '#f7fdff',
    '--empty-bg': '#f7fdff',
    '--card-bg': '#f7fdff',
    '--card-border': '#cfe8f5',
    '--ambient-a': 'rgba(14, 165, 233, 0.14)',
    '--ambient-b': 'rgba(37, 99, 235, 0.12)',
    '--particle-color': 'rgba(14, 165, 233, 0.5)',
  },
  dark: {
    '--app-bg': '#0f0f23',
    '--panel-bg': '#1a1a2e',
    '--chat-bg': '#0f0f23',
    '--text-primary': '#e2e8f0',
    '--text-secondary': '#94a3b8',
    '--border-color': '#2d2d44',
    '--user-bubble': '#166534',
    '--bot-bubble': '#1e1e3f',
    '--header-bg': '#0f0f23',
    '--header-text': '#e2e8f0',
    '--accent': '#22c55e',
    '--accent-hover': '#16a34a',
    '--accent-glow': 'rgba(34, 197, 94, 0.4)',
    '--input-bg': '#1a1a2e',
    '--empty-bg': '#1a1a2e',
    '--card-bg': '#1a1a2e',
    '--card-border': '#2d2d44',
    '--ambient-a': 'rgba(124, 92, 255, 0.18)',
    '--ambient-b': 'rgba(34, 197, 94, 0.12)',
    '--particle-color': 'rgba(148, 163, 184, 0.5)',
  },
}

function isValidTheme(value: string | null): value is Theme {
  return value !== null && value in THEME_VARS
}

export function getTheme(): Theme {
  if (typeof window === 'undefined') return 'wechat'
  const saved = localStorage.getItem(THEME_KEY)
  return isValidTheme(saved) ? saved : 'wechat'
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
  const vars = THEME_VARS[theme] || THEME_VARS.wechat
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value)
  }
}
