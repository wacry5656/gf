<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { Character, ChatMessage, User } from './api'
import { getCharacters, createCharacter, deleteCharacter, getMessages } from './api'
import { getCurrentUser, saveUser, clearUser, getActiveCharacterId, saveActiveCharacterId, clearActiveCharacterId } from './userSession'
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
let activeCharacterRequestId = 0

// 初始化：检查本地存储的登录信息
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
  if (!window.confirm(`确定删除「${char.name}」和她的聊天记录吗？`)) return
  deletingCharacterId.value = char.id
  try {
    appError.value = ''
    await deleteCharacter(char.id, user.value.userId)
    // 删除成功后，重新请求角色列表而非只做本地过滤
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
    .replace(/^(自然|温和|直率|轻松|克制|慢热)[:：]\s*/, '$1：')
    .replace(/[。.]?$/, '')
}
</script>

<template>
  <div class="app-container">
    <!-- 未登录 -->
    <template v-if="!user">
      <header class="app-header">
        <h1>虚拟聊天角色</h1>
      </header>
      <main class="app-main">
        <div v-if="appError" class="app-error">{{ appError }}</div>
        <LoginPage @login="onLogin" />
      </main>
    </template>

    <!-- 已登录 -->
    <template v-else>
      <header class="app-header">
        <h1>虚拟聊天角色</h1>
        <div class="header-right">
          <span class="user-info">{{ user.username }}</span>
          <button v-if="activeCharacter" class="btn-header" @click="goBack">返回列表</button>
          <button class="btn-header btn-logout" @click="onLogout">退出</button>
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
        />

        <!-- 角色列表 -->
        <div v-else class="char-list-container">
          <div class="char-list-header">
            <h2>我的角色</h2>
            <button class="btn-primary-sm" @click="showNewCharacter = true">新建角色</button>
          </div>

          <div v-if="loading" class="char-loading">加载中...</div>

          <div v-else-if="characters.length === 0" class="char-empty">
            <p>还没有角色，先创建一个默认认同为你对象的虚拟人物。</p>
          </div>

          <div v-else class="char-grid">
            <div
              v-for="char in characters"
              :key="char.id"
              class="char-card"
              @click="selectCharacter(char)"
            >
              <div class="char-avatar">{{ char.name.slice(0, 1) }}</div>
              <div class="char-info">
                <div class="char-name">{{ char.name }}</div>
                <div class="char-desc">{{ displayPersonality(char.personality) }}</div>
              </div>
              <button
                class="btn-delete"
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
  background: #eef1f4;
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  background: #172033;
  color: #fff;
  flex-shrink: 0;
}

.app-header h1 {
  margin: 0;
  font-size: 1.05rem;
  letter-spacing: 0;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.user-info {
  font-size: 0.85rem;
  opacity: 0.8;
}

.btn-header {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.4);
  color: #fff;
  padding: 5px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.8rem;
}

.btn-header:hover {
  background: rgba(255, 255, 255, 0.1);
}

.btn-logout {
  border-color: rgba(255, 100, 100, 0.5);
  color: #fbb;
}

.btn-logout:hover {
  background: rgba(255, 100, 100, 0.15);
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
  color: #b42318;
  background: #fff1f0;
  border-bottom: 1px solid #ffd3cc;
  font-size: 0.88rem;
}

/* 角色列表 */
.char-list-container {
  flex: 1;
  padding: 24px;
  overflow-y: auto;
  background: #eef1f4;
}

.char-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.char-list-header h2 {
  margin: 0;
  font-size: 1.1rem;
  color: #333;
}

.btn-primary-sm {
  background: #25324a;
  color: #fff;
  border: none;
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}

.btn-primary-sm:hover {
  background: #344563;
}

.char-loading, .char-empty {
  text-align: center;
  color: #999;
  margin-top: 40px;
}

.char-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}

.char-card {
  display: flex;
  align-items: center;
  gap: 14px;
  background: #fff;
  border: 1px solid #e4e7ec;
  border-radius: 8px;
  padding: 14px 16px;
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s;
}

.char-card:hover {
  border-color: #b9c3d1;
  box-shadow: 0 8px 20px rgba(16, 24, 40, 0.08);
  transform: translateY(-1px);
}

.char-avatar {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  background: #25324a;
  color: #fff;
  font-weight: 700;
  font-size: 1rem;
  flex-shrink: 0;
}

.char-info {
  flex: 1;
  min-width: 0;
}

.char-name {
  font-weight: 600;
  font-size: 1rem;
  color: #333;
}

.char-desc {
  font-size: 0.8rem;
  color: #888;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.btn-delete {
  background: none;
  border: none;
  color: #ccc;
  font-size: 1rem;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}

.btn-delete:hover {
  color: #e53935;
  background: rgba(229, 57, 53, 0.08);
}

.btn-delete:disabled {
  color: #999;
  cursor: wait;
  background: transparent;
}
</style>
