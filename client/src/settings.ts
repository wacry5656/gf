/**
 * 全局 UI 偏好设置，持久化到 localStorage。
 */

export interface UiSettings {
  ambient: boolean      // 氛围粒子背景
  sound: boolean        // UI 音效
  entrance: boolean     // 消息入场动画
  fontScale: number     // 气泡字号缩放 0.85 ~ 1.3
}

const SETTINGS_KEY = 'ui-settings'

const DEFAULTS: UiSettings = {
  ambient: true,
  sound: false,
  entrance: true,
  fontScale: 1,
}

export function getSettings(): UiSettings {
  if (typeof window === 'undefined') return { ...DEFAULTS }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<UiSettings>
    return {
      ambient: typeof parsed.ambient === 'boolean' ? parsed.ambient : DEFAULTS.ambient,
      sound: typeof parsed.sound === 'boolean' ? parsed.sound : DEFAULTS.sound,
      entrance: typeof parsed.entrance === 'boolean' ? parsed.entrance : DEFAULTS.entrance,
      fontScale: clampScale(parsed.fontScale),
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(settings: UiSettings): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // ignore quota / privacy-mode failures
  }
}

function clampScale(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULTS.fontScale
  return Math.min(1.3, Math.max(0.85, n))
}

/** 把字号缩放写到根 CSS 变量，供气泡引用。 */
export function applyFontScale(scale: number): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty('--chat-font-scale', String(clampScale(scale)))
}
