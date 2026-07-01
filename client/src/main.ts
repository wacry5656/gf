import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { initTheme } from './theme'
import { getSettings, applyFontScale } from './settings'

initTheme()
applyFontScale(getSettings().fontScale)

createApp(App).mount('#app')

// PWA：仅生产环境注册 Service Worker，避免干扰 Vite 开发热更新
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

