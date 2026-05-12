<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import type { Character, ChatMessage, User } from './api'
import { getCharacters, createCharacter, deleteCharacter, getMessages } from './api'
import { getCurrentUser, saveUser, clearUser, getActiveCharacterId, saveActiveCharacterId, clearActiveCharacterId } from './userSession'
import { getTheme, setTheme, type Theme } from './theme'
import LoginPage from './components/LoginPage.vue'
import CharacterSetup from './components/CharacterSetup.vue'
import ChatWindow from './components/ChatWindow.vue'

const user = ref<User | null>(null)
const characters = ref<Character[]>([])
const activeCharacter = ref<Character | null>(null)
const chatMessages = ref<ChatMessage[]>([])
const showNewCharacter = ref(false)
const loading = ref(false)
const appError = ref('')
const creatingCharacter = ref(false)
const deletingCharacterId = ref<number | null>(null)
const currentTheme = ref<Theme>(getTheme())
let activeCharacterRequestId = 0

function cycleTheme() {
  const themes: Theme[] = ['wechat', 'imessage', 'dark']
  const next = themes[(themes.indexOf(currentTheme.value) + 1) % themes.length]
  currentTheme.value = next
  setTheme(next)
}

const themeLabel = computed(() => {
  const map: Record<Theme, string> = { wechat: '💬', imessage: '💙', dark: '🌙' }
  return map[currentTheme.value]
})

onMounted(() => {
  const saved = getCurrentUser()
  if (saved) {
    user.value = saved
    loadCharacters()
  }
})

function onLogin(u: User) {
  appError.value = ''
  user.value = u
  saveUser(u)
  loadCharacters()
}

function resetSession(message = '') {
  activeCharacterRequestId += 1
  user.value = null
  activeCharacter.value = null
  chatMessages.value = []
  characters.value = []
  showNewCharacter.value = false
  clearUser()
  clearActiveCharacterId()
  appError.value = message
}

function onLogout() {
  resetSession()
}

function isExpiredLoginError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e || '')
  return message.includes('登录已失效') || message.includes('重新登录')
}

async function loadCharacters() {
  if (!user.value) return
  loading.value = true
  try {
    const nextCharacters = await getCharacters(user.value.userId)
    characters.value = nextCharacters
    await restoreActiveCharacter(nextCharacters)
    appError.value = ''
  } catch (e: any) {
    console.error(e)
    if (isExpiredLoginError(e)) {
      resetSession('本地登录已失效，请重新登录。')
    } else {
      appError.value = e?.message || '加载角色失败'
    }
  } finally {
    loading.value = false
  }
}

async function restoreActiveCharacter(nextCharacters: Character[]) {
  if (!user.value) return

  const preferredCharacterId = activeCharacter.value?.id || getActiveCharacterId()
  if (!preferredCharacterId) return

  const matchedCharacter = nextCharacters.find((char) => char.id === preferredCharacterId)
  if (!matchedCharacter) {
    if (activeCharacter.value?.id === preferredCharacterId) {
      activeCharacter.value = null
      chatMessages.value = []
    }
    clearActiveCharacterId()
    return
  }

  if (activeCharacter.value?.id === matchedCharacter.id) {
    activeCharacter.value = matchedCharacter
    return
  }

  await selectCharacter(matchedCharacter, { persistSelection: false })
}

async function onCharacterConfirm(char: Character) {
  if (!user.value || creatingCharacter.value) return
  creatingCharacter.value = true
  try {
    appError.value = ''
    const charId = await createCharacter(user.value.userId, char)
    char.id = charId
    characters.value.unshift(char)
    showNewCharacter.value = false
    await selectCharacter(char)
  } catch (e: any) {
    console.error(e)
    if (isExpiredLoginError(e)) {
      resetSession('本地登录已失效，请重新登录。')
    } else {
      appError.value = e?.message || '创建角色失败'
    }
  } finally {
    creatingCharacter.value = false
  }
}

async function selectCharacter(char: Character, options: { persistSelection?: boolean } = {}) {
  const { persistSelection = true } = options
  const requestId = ++activeCharacterRequestId
  activeCharacter.value = char
  if (persistSelection && char.id) {
    saveActiveCharacterId(char.id)
  }
  chatMessages.value = []
  if (char.id && user.value) {
    const selectedUserId = user.value.userId
    try {
      const messages = await getMessages(char.id, selectedUserId)
      if (requestId !== activeCharacterRequestId) return
      if (activeCharacter.value?.id !== char.id || user.value?.userId !== selectedUserId) return
      chatMessages.value = messages
    } catch (e: any) {
      if (requestId !== activeCharacterRequestId) return
      console.error('[App] 加载历史消息失败:', e)
      if (isExpiredLoginError(e)) {
        resetSession('本地登录已失效，请重新登录。')
      } else {
        appError.value = e?.message || '加载历史消息失败'
      }
    }
  }
}

async function onDeleteCharacter(char: Character) {
  if (!char.id || !user.value) return
  if (deletingCharacterId.value) return
  if (!window.confirm(`确定删除「${char.name}」的聊天记录和所有数据吗？`)) return
  deletingCharacterId.value = char.id
  try {
    appError.value = ''
    await deleteCharacter(char.id, user.value.userId)
    if (activeCharacter.value?.id === char.id) {
      activeCharacter.value = null
      chatMessages.value = []
      clearActiveCharacterId()
    }
    await loadCharacters()
  } catch (e: any) {
    console.error(e)
    if (isExpiredLoginError(e)) {
      resetSession('本地登录已失效，请重新登录。')
    } else {
      appError.value = e?.message || '删除角色失败，请重试'
    }
  } finally {
    deletingCharacterId.value = null
  }
}

function goBack() {
  activeCharacterRequestId += 1
  activeCharacter.value = null
  chatMessages.value = []
  clearActiveCharacterId()
}

function displayPersonality(raw: string): string {
  const publicText = (raw || '')
    .replace(/\s+/g, ' ')
    .split(/[\n\r]|主动[:：]|回复节奏[:：]|边界[:：]|禁止旁白|禁止动作|禁止心理|系统规则|聊天规则/)[0]
    ?.trim() || '自然聊天'
  return publicText
    .replace(/^(自然|温和|直率|轻松|克制|慢热|毒舌)[:：]\s*/, '$1：')
    .replace(/[。.]?$/, '')
}

function getRelationLabel(mode: string | undefined): string {
  return mode === 'friend' ? '朋友' : '恋人'
}
</script>

<template>
  <div class="app-container">
    <!-- 未登录 -->
    <template v-if="!user">
      <header class="app-header">
        <div class="app-logo">💬</div>
        <h1>虚拟聊天</h1>
      </header>
      <main class="app-main">
        <div v-if="appError" class="app-error">{{ appError }}</div>
        <LoginPage @login="onLogin" />
      </main>
    </template>

    <!-- 已登录 -->
    <template v-else>
      <header class="app-header app-header-logged">
        <div class="header-left">
          <button v-if="activeCharacter" class="btn-back" @click="goBack">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
            列表
          </button>
          <div v-else class="app-brand">
            <span class="app-logo-sm">💬</span>
            <span class="app-title">我的角色</span>
          </div>
        </div>
        <div class="header-right">
          <button class="btn-theme" @click="cycleTheme" title="切换主题">{{ themeLabel }}</button>
          <span class="user-badge">{{ user.username }}</span>
          <button class="btn-logout" @click="onLogout">退出</button>
        </div>
      </header>

      <main class="app-main">
        <div v-if="appError" class="app-error">{{ appError }}</div>

        <!-- 创建角色 -->
        <CharacterSetup
          v-if="showNewCharacter"
          :submitting="creatingCharacter"
          @confirm="onCharacterConfirm"
        />

        <!-- 聊天界面 -->
        <ChatWindow
          v-else-if="activeCharacter"
          :character="activeCharacter"
          :user-id="user.userId"
          v-model:messages="chatMessages"
          @back="goBack"
        />

        <!-- 角色列表 -->
        <div v-else class="char-list-container">
          <div class="char-list-header">
            <h2>我的角色</h2>
            <button class="btn-create" @click="showNewCharacter = true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
              新建
            </button>
          </div>

          <div v-if="loading" class="char-loading">加载中...</div>

          <div v-else-if="characters.length === 0" class="char-empty">
            <div class="empty-icon">✨</div>
            <p>还没有角色</p>
            <p class="empty-hint">创建一个角色，开始你们的聊天</p>
            <button class="btn-create-center" @click="showNewCharacter = true">创建第一个角色</button>
          </div>

          <div v-else class="char-grid">
            <div
              v-for="char in characters"
              :key="char.id"
              class="char-card"
              @click="selectCharacter(char)"
            >
              <div class="card-avatar">{{ char.name.slice(0, 1) }}</div>
              <div class="card-info">
                <div class="card-name">{{ char.name }}</div>
                <div class="card-tags">
                  <span class="card-tag">{{ getRelationLabel(char.relationshipMode) }}</span>
                  <span class="card-tag card-tag-personality">{{ displayPersonality(char.personality) }}</span>
                </div>
              </div>
              <button
                class="btn-delete-card"
                :disabled="deletingCharacterId === char.id"
                @click.stop="onDeleteCharacter(char)"
                title="删除角色"
              >{{ deletingCharacterId === char.id ? '...' : '✕' }}</button>
            </div>
          </div>
        </div>
      </main>
    </template>
  </div>
</template>

<style scoped>
.app-container {
  width: 100vw;
  margin: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--app-bg, #f0f2f5);
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 14px 20px;
  background: var(--header-bg, #1e1b4b);
  color: var(--header-text, #fff);
  flex-shrink: 0;
  gap: 10px;
}

.app-header-logged {
  justify-content: space-between;
}

.app-logo {
  font-size: 1.4rem;
}

.app-logo-sm {
  font-size: 1.1rem;
  margin-right: 6px;
}

.app-title {
  font-size: 0.95rem;
  font-weight: 600;
}

.app-header h1 {
  margin: 0;
  font-size: 1.1rem;
  letter-spacing: 0;
  font-weight: 700;
}

.header-left {
  display: flex;
  align-items: center;
}

.app-brand {
  display: flex;
  align-items: center;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-back {
  display: flex;
  align-items: center;
  gap: 4px;
  background: rgba(255, 255, 255, 0.12);
  border: none;
  color: #fff;
  padding: 6px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.82rem;
  font-family: inherit;
  transition: background 0.15s;
}

.btn-back:hover {
  background: rgba(255, 255, 255, 0.2);
}

.user-badge {
  font-size: 0.82rem;
  padding: 4px 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.8);
}

.btn-theme {
  background: rgba(255, 255, 255, 0.12);
  border: none;
  color: var(--header-text, #fff);
  padding: 5px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.85rem;
  font-family: inherit;
}
.btn-theme:hover {
  background: rgba(255, 255, 255, 0.2);
}

.btn-logout {
  background: rgba(255, 100, 100, 0.15);
  border: 1px solid rgba(255, 100, 100, 0.3);
  color: #fbb;
  padding: 5px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.8rem;
  font-family: inherit;
  transition: background 0.15s;
}

.btn-logout:hover {
  background: rgba(255, 100, 100, 0.25);
}

.app-main {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.app-error {
  flex-shrink: 0;
  padding: 10px 18px;
  color: #b91c1c;
  background: #fef2f2;
  border-bottom: 1px solid #fecaca;
  font-size: 0.86rem;
}

/* Character List */
.char-list-container {
  flex: 1;
  padding: 24px;
  overflow-y: auto;
  background: var(--app-bg, #f0f2f5);
}

.char-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.char-list-header h2 {
  margin: 0;
  font-size: 1.2rem;
  color: #111827;
  font-weight: 700;
}

.btn-create {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--accent, #07c160);
  color: #fff;
  border: none;
  padding: 8px 14px;
  border-radius: 10px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}

.btn-create:hover {
  background: var(--accent-hover, #06ad56);
}

.char-loading, .char-empty {
  text-align: center;
  color: #9ca3af;
  margin-top: 60px;
}

.empty-icon {
  font-size: 3rem;
  margin-bottom: 12px;
}

.char-empty p {
  margin: 4px 0;
  font-size: 0.95rem;
  color: #6b7280;
}

.empty-hint {
  font-size: 0.85rem !important;
  color: #9ca3af !important;
}

.btn-create-center {
  margin-top: 20px;
  padding: 10px 24px;
  background: var(--accent, #07c160);
  color: #fff;
  border: none;
  border-radius: 10px;
  font-size: 0.92rem;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}

.btn-create-center:hover {
  background: #06ad56;
}

.char-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.char-card {
  display: flex;
  align-items: center;
  gap: 14px;
  background: var(--card-bg, #fff);
  border: 1px solid var(--card-border, #e5e7eb);
  border-radius: 14px;
  padding: 16px;
  cursor: pointer;
  transition: all 0.15s;
}

.char-card:hover {
  border-color: var(--accent, #95ec69);
  box-shadow: 0 4px 16px rgba(7, 193, 96, 0.1);
  transform: translateY(-1px);
}

.card-avatar {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #1e1b4b, #312e81);
  color: #fff;
  font-weight: 700;
  font-size: 1.05rem;
  flex-shrink: 0;
}

.card-info {
  flex: 1;
  min-width: 0;
}

.card-name {
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--text-primary, #111827);
}

.card-tags {
  display: flex;
  gap: 6px;
  margin-top: 4px;
  flex-wrap: wrap;
}

.card-tag {
  font-size: 0.72rem;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--app-bg, #f3f4f6);
  color: var(--text-secondary, #6b7280);
}

.card-tag-personality {
  background: #ede9fe;
  color: #6b21a8;
}

.btn-delete-card {
  background: none;
  border: none;
  color: #d1d5db;
  font-size: 0.9rem;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 6px;
  transition: all 0.15s;
}

.btn-delete-card:hover {
  color: #ef4444;
  background: #fef2f2;
}

.btn-delete-card:disabled {
  color: #9ca3af;
  cursor: wait;
  background: transparent;
}

@media (max-width: 640px) {
  .char-grid {
    grid-template-columns: 1fr;
  }

  .char-list-container {
    padding: 16px;
  }
}
</style>