<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { Character, ChatMessage, User } from './api'
import { getCharacters, createCharacter, deleteCharacter, getMessages } from './api'
import LoginPage from './components/LoginPage.vue'
import CharacterSetup from './components/CharacterSetup.vue'
import ChatWindow from './components/ChatWindow.vue'

const user = ref<User | null>(null)
const characters = ref<Character[]>([])
const activeCharacter = ref<Character | null>(null)
const chatMessages = ref<ChatMessage[]>([])
const showNewCharacter = ref(false)
const loading = ref(false)

// 初始化：检查本地存储的登录信息
onMounted(() => {
  const saved = localStorage.getItem('user')
  if (saved) {
    try {
      user.value = JSON.parse(saved)
      loadCharacters()
    } catch { /* ignore */ }
  }
})

function onLogin(u: User) {
  user.value = u
  localStorage.setItem('user', JSON.stringify(u))
  loadCharacters()
}

function onLogout() {
  user.value = null
  activeCharacter.value = null
  chatMessages.value = []
  characters.value = []
  showNewCharacter.value = false
  localStorage.removeItem('user')
}

async function loadCharacters() {
  if (!user.value) return
  loading.value = true
  try {
    characters.value = await getCharacters(user.value.userId)
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
  }
}

async function onCharacterConfirm(char: Character) {
  if (!user.value) return
  try {
    const charId = await createCharacter(user.value.userId, char)
    char.id = charId
    characters.value.unshift(char)
    showNewCharacter.value = false
    await selectCharacter(char)
  } catch (e: any) {
    console.error(e)
  }
}

async function selectCharacter(char: Character) {
  activeCharacter.value = char
  chatMessages.value = []
  if (char.id) {
    try {
      chatMessages.value = await getMessages(char.id)
    } catch { /* ignore */ }
  }
}

async function onDeleteCharacter(char: Character) {
  if (!char.id || !user.value) return
  try {
    await deleteCharacter(char.id, user.value.userId)
    // 删除成功后，重新请求角色列表而非只做本地过滤
    if (activeCharacter.value?.id === char.id) {
      activeCharacter.value = null
      chatMessages.value = []
    }
    await loadCharacters()
  } catch (e: any) {
    console.error(e)
    alert(e.message || '删除角色失败，请重试')
  }
}

function goBack() {
  activeCharacter.value = null
  chatMessages.value = []
}
</script>

<template>
  <div class="app-container">
    <!-- 未登录 -->
    <template v-if="!user">
      <header class="app-header">
        <h1>💬 虚拟聊天角色</h1>
      </header>
      <main class="app-main">
        <LoginPage @login="onLogin" />
      </main>
    </template>

    <!-- 已登录 -->
    <template v-else>
      <header class="app-header">
        <h1>💬 虚拟聊天角色</h1>
        <div class="header-right">
          <span class="user-info">{{ user.username }}</span>
          <button v-if="activeCharacter" class="btn-header" @click="goBack">返回列表</button>
          <button class="btn-header btn-logout" @click="onLogout">退出</button>
        </div>
      </header>

      <main class="app-main">
        <!-- 创建角色 -->
        <CharacterSetup v-if="showNewCharacter" @confirm="onCharacterConfirm" />

        <!-- 聊天界面 -->
        <ChatWindow
          v-else-if="activeCharacter"
          :character="activeCharacter"
          v-model:messages="chatMessages"
        />

        <!-- 角色列表 -->
        <div v-else class="char-list-container">
          <div class="char-list-header">
            <h2>我的角色</h2>
            <button class="btn-primary-sm" @click="showNewCharacter = true">+ 新建角色</button>
          </div>

          <div v-if="loading" class="char-loading">加载中...</div>

          <div v-else-if="characters.length === 0" class="char-empty">
            <p>还没有角色，点击上方按钮创建一个吧 ✨</p>
          </div>

          <div v-else class="char-grid">
            <div
              v-for="char in characters"
              :key="char.id"
              class="char-card"
              @click="selectCharacter(char)"
            >
              <div class="char-avatar">{{ char.gender === 'female' ? '👧' : char.gender === 'male' ? '👦' : '🧑' }}</div>
              <div class="char-info">
                <div class="char-name">{{ char.name }}</div>
                <div class="char-desc">{{ char.personality }}</div>
              </div>
              <button
                class="btn-delete"
                @click.stop="onDeleteCharacter(char)"
                title="删除角色"
              >✕</button>
            </div>
          </div>
        </div>
      </main>
    </template>
  </div>
</template>

<style scoped>
.app-container {
  max-width: 800px;
  margin: 0 auto;
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  background: #1a1a2e;
  color: #fff;
  flex-shrink: 0;
}

.app-header h1 {
  margin: 0;
  font-size: 1.3rem;
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

/* 角色列表 */
.char-list-container {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
  background: #f0f2f5;
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
  background: #6c63ff;
  color: #fff;
  border: none;
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}

.btn-primary-sm:hover {
  background: #5a52d9;
}

.char-loading, .char-empty {
  text-align: center;
  color: #999;
  margin-top: 40px;
}

.char-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.char-card {
  display: flex;
  align-items: center;
  gap: 14px;
  background: #fff;
  border-radius: 10px;
  padding: 14px 16px;
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0,0,0,0.05);
  transition: box-shadow 0.2s;
}

.char-card:hover {
  box-shadow: 0 2px 10px rgba(0,0,0,0.1);
}

.char-avatar {
  font-size: 2rem;
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
</style>
