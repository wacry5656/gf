<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Character, ChatMessage, EmotionInfo, RelationshipInfo } from '../api'
import { checkInitiativeEligibility, clearMessages, generateInitiativeMessage, getEmotion, getRelationship, saveMessage, sendMessage, sendMessageStream, StreamChatError } from '../api'
import { clearChatDraft, getChatDraft, saveChatDraft } from '../userSession'
import MemoryPanel from './MemoryPanel.vue'

const props = defineProps<{
  character: Character
  messages: ChatMessage[]
  userId: number
}>()

const emit = defineEmits<{
  'update:messages': [messages: ChatMessage[]]
  'back': []
}>()

const inputText = ref('')
const loading = ref(false)
const streaming = ref(false)
const error = ref('')
const chatBody = ref<HTMLElement | null>(null)
const emotionInfo = ref<EmotionInfo | null>(null)
const relationshipInfo = ref<RelationshipInfo | null>(null)
const showMobilePanel = ref(false)
const showMemoryPanel = ref(false)
const initiativeLoading = ref(false)
const sessionInitiativeCount = ref(0)
let statusRequestId = 0
let initiativeTimer: ReturnType<typeof setTimeout> | null = null
let initiativePollInterval: ReturnType<typeof setInterval> | null = null

function displayPersonality(raw: string): string {
  const publicText = (raw || '')
    .replace(/\s+/g, ' ')
    .split(/[\n\r]|主动[:：]|回复节奏[:：]|边界[:：]|禁止旁白|禁止动作|禁止心理|系统规则|聊天规则/)[0]
    ?.trim() || '自然聊天'
  return publicText
    .replace(/^(自然|温和|直率|轻松|克制|慢热|毒舌)[:：]\s*/, '$1：')
    .replace(/[。.]?$/, '')
}

const moodEmoji = computed(() => {
  const map: Record<string, string> = {
    warm: '😊', happy: '😄', playful: '😏', shy: '🫣',
    caring: '🤗', upset: '😤', jealous: '😒', distant: '😶',
    sulking: '😠', disappointed: '😞', anticipating: '✨',
  }
  return map[emotionInfo.value?.mood || 'warm'] || '😊'
})

const moodLabel = computed(() => emotionInfo.value?.moodLabel || '温柔')
const phaseLabel = computed(() => {
  if (props.character.relationshipMode === 'friend' && !relationshipInfo.value) return '熟悉'
  return relationshipInfo.value?.phaseLabel || (props.character.relationshipMode === 'friend' ? '熟悉' : '亲近')
})

const relationshipHint = computed(() => {
  if (props.character.relationshipMode === 'friend') {
    return '你的日常聊天搭子'
  }
  const phase = relationshipInfo.value?.phase
  if (phase === 'deep_attached') return '你们很亲密'
  if (phase === 'strained') return '最近有点别扭'
  return '日常相处中'
})

const emptyCopy = computed(() => {
  const pronoun = props.character.gender === 'male' ? '他' : props.character.gender === 'female' ? '她' : '对方'
  if (props.character.relationshipMode === 'friend') {
    return `给${pronoun}发条消息开始聊天吧`
  }
  return `给${pronoun}发条消息吧`
})

function clamp01(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

const statusItems = computed(() => {
  const emotion = emotionInfo.value
  const relationship = relationshipInfo.value
  const isFriend = props.character.relationshipMode === 'friend'
  return [
    { label: '好感', value: clamp01(emotion?.affection, isFriend ? 0.38 : 0.65), tone: 'rose', icon: '♥' },
    { label: '信任', value: clamp01(emotion?.trust_score ?? relationship?.trust, isFriend ? 0.52 : 0.55), tone: 'blue', icon: '🤝' },
    { label: '亲近', value: clamp01(relationship?.closeness, isFriend ? 0.42 : 0.65), tone: 'violet', icon: '✦' },
    { label: isFriend ? '熟悉' : '依赖', value: clamp01(relationship?.dependence, isFriend ? 0.18 : 0.45), tone: 'green', icon: '◈' },
    { label: '安心', value: clamp01(relationship?.comfort_level, isFriend ? 0.56 : 0.65), tone: 'amber', icon: '☀' },
  ]
})

async function fetchStatus() {
  const requestId = ++statusRequestId

  if (!props.character?.id || !props.userId) {
    emotionInfo.value = null
    relationshipInfo.value = null
    return
  }

  const [emotionResult, relationshipResult] = await Promise.allSettled([
    getEmotion(props.character.id, props.userId),
    getRelationship(props.character.id, props.userId),
  ])

  if (requestId !== statusRequestId) return

  emotionInfo.value = emotionResult.status === 'fulfilled' ? emotionResult.value : null
  relationshipInfo.value = relationshipResult.status === 'fulfilled' ? relationshipResult.value : null
}

onMounted(fetchStatus)

watch(() => props.character?.id, fetchStatus)
watch(() => props.userId, fetchStatus)

watch(
  () => [props.userId, props.character?.id] as const,
  ([userId, characterId]) => {
    if (!userId || !characterId) {
      inputText.value = ''
      return
    }
    inputText.value = getChatDraft(userId, characterId)
  },
  { immediate: true },
)

watch(inputText, (draft) => {
  if (!props.userId || !props.character?.id) return
  if (draft) {
    saveChatDraft(props.userId, props.character.id, draft)
    return
  }
  clearChatDraft(props.userId, props.character.id)
})

function scrollToBottom() {
  nextTick(() => {
    if (chatBody.value) {
      chatBody.value.scrollTop = chatBody.value.scrollHeight
    }
  })
}

watch(() => props.messages.length, scrollToBottom)

function applyAssistantReplies(baseMessages: ChatMessage[], replies: string[], streamContent = '') {
  if (replies.length > 0) {
    const finalMessages = [...baseMessages]
    for (const reply of replies) {
      finalMessages.push({ role: 'assistant', content: reply })
    }
    emit('update:messages', finalMessages)
    return true
  }

  if (streamContent) {
    emit('update:messages', [...baseMessages, { role: 'assistant', content: streamContent }])
    return true
  }

  return false
}

async function send() {
  const rawText = inputText.value
  const text = rawText.trim()
  if (!text || loading.value) return

  error.value = ''
  const userMsg: ChatMessage = { role: 'user', content: text }
  const updated = [...props.messages, userMsg]
  emit('update:messages', updated)
  inputText.value = ''
  loading.value = true
  streaming.value = false

  let connected = false

  try {
    if (props.character.id) {
      await saveMessage(props.character.id, 'user', text, props.userId)
    }

    let streamContent = ''
    const replies = await sendMessageStream(
      props.character,
      updated,
      (delta) => {
        if (!streaming.value) streaming.value = true
        streamContent += delta
        emit('update:messages', [...updated, { role: 'assistant', content: streamContent }])
        scrollToBottom()
      },
      props.userId,
      () => {
        connected = true
      },
    )

    applyAssistantReplies(updated, replies, streamContent)
    fetchStatus()
  } catch (e: any) {
    const shouldFallbackToNonStream = !streaming.value && !(e instanceof StreamChatError && e.stage === 'after-partial')

    if (shouldFallbackToNonStream) {
      try {
        const fallbackReplies = await sendMessage(props.character, updated, props.userId)
        if (applyAssistantReplies(updated, fallbackReplies)) {
          error.value = ''
          fetchStatus()
          return
        }
      } catch (fallbackErr: any) {
        e = fallbackErr
      }
    }

    if (e instanceof StreamChatError) {
      error.value = e.message
    } else if (connected && !streaming.value) {
      error.value = e.message || '连接已建立，但回复生成超时，请重试'
    } else {
      error.value = e.message || '发送失败'
    }
    if (!(e instanceof StreamChatError && e.stage === 'after-partial') && !streaming.value) {
      emit('update:messages', updated)
      if (!inputText.value) {
        inputText.value = rawText
      }
    }
  } finally {
    loading.value = false
    streaming.value = false
  }
}

async function onClearHistory() {
  if (!props.character.id) return
  if (loading.value) {
    error.value = '回复生成中，等这次回复结束后再清空记录。'
    return
  }
  if (!window.confirm('确定清空当前角色的全部聊天记录吗？')) return
  try {
    await clearMessages(props.character.id, props.userId)
    emit('update:messages', [])
    fetchStatus()
  } catch (e) {
    console.error('[ChatWindow] 清空聊天记录失败:', e)
    error.value = '清空失败'
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

// ====== 主动消息 ======

function clearInitiativeTimers() {
  if (initiativeTimer) {
    clearTimeout(initiativeTimer)
    initiativeTimer = null
  }
  if (initiativePollInterval) {
    clearInterval(initiativePollInterval)
    initiativePollInterval = null
  }
}

function startInitiativePolling() {
  clearInitiativeTimers()

  // 立即检查一次
  checkAndSendInitiative()

  // 每 30 秒检查一次
  initiativePollInterval = setInterval(() => {
    checkAndSendInitiative()
  }, 30000)
}

async function checkAndSendInitiative() {
  if (!props.character.id || !props.userId) return
  if (loading.value || initiativeLoading.value) return
  if (props.messages.length === 0) return

  // 最后一条必须是用户发的
  const lastMsg = props.messages[props.messages.length - 1]
  if (lastMsg.role !== 'user') return

  try {
    const eligibility = await checkInitiativeEligibility(
      props.character.id,
      props.userId,
      sessionInitiativeCount.value
    )

    if (!eligibility.eligible) return

    initiativeLoading.value = true

    // 显示 typing
    const typingMsg: ChatMessage = { role: 'assistant', content: '\u200B' }
    const withTyping = [...props.messages, typingMsg]
    emit('update:messages', withTyping)
    scrollToBottom()

    // 生成主动消息
    const replies = await generateInitiativeMessage(
      props.character,
      props.messages,
      props.userId
    )

    if (replies.length > 0) {
      sessionInitiativeCount.value++
      const finalMessages = [...props.messages]
      for (const reply of replies) {
        finalMessages.push({ role: 'assistant', content: reply })
      }
      emit('update:messages', finalMessages)
      fetchStatus()
    } else {
      // 生成失败，移除 typing
      emit('update:messages', props.messages)
    }
  } catch (e: any) {
    console.error('[Initiative] 主动消息失败:', e)
    // 移除 typing
    emit('update:messages', props.messages)
  } finally {
    initiativeLoading.value = false
  }
}

onMounted(() => {
  fetchStatus()
  startInitiativePolling()
})

onUnmounted(() => {
  clearInitiativeTimers()
})
</script>

<template>
  <div class="chat-shell">
    <!-- Mobile panel overlay -->
    <Transition name="slide">
      <div v-if="showMobilePanel" class="mobile-panel-overlay" @click="showMobilePanel = false">
        <div class="mobile-panel" @click.stop>
          <div class="mobile-panel-header">
            <div class="mobile-portrait">
              <div class="mobile-portrait-initial">{{ character.name.slice(0, 1) }}</div>
            </div>
            <h3>{{ character.name }}</h3>
            <p class="mobile-personality">{{ displayPersonality(character.personality) }}</p>
          </div>
          <div class="mobile-status">
            <div class="mobile-status-row" v-for="item in statusItems" :key="item.label">
              <span class="mobile-status-label">{{ item.icon }} {{ item.label }}</span>
              <div class="mobile-status-bar">
                <div class="mobile-status-fill" :class="`tone-${item.tone}`" :style="{ width: `${Math.round(item.value * 100)}%` }"></div>
              </div>
              <span class="mobile-status-val">{{ Math.round(item.value * 100) }}</span>
            </div>
          </div>
          <div class="mobile-tags">
            <span class="mobile-tag">{{ moodEmoji }} {{ moodLabel }}</span>
            <span class="mobile-tag">{{ phaseLabel }}</span>
          </div>
          <p class="mobile-hint">{{ relationshipHint }}</p>
          <button class="mobile-panel-close" @click="showMobilePanel = false">关闭</button>
        </div>
      </div>
    </Transition>

    <!-- Desktop sidebar -->
    <aside class="companion-panel">
      <div class="panel-section">
        <div class="portrait">
          <div class="portrait-ring"></div>
          <div class="portrait-initial">{{ character.name.slice(0, 1) }}</div>
        </div>
        <div class="identity-block">
          <div class="identity-name">{{ character.name }}</div>
          <div class="identity-personality">{{ displayPersonality(character.personality) }}</div>
        </div>
      </div>

      <div class="panel-divider"></div>

      <div class="panel-section">
        <div class="section-title">
          <span>状态</span>
          <div class="mood-badge">{{ moodEmoji }} {{ moodLabel }}</div>
        </div>
        <div class="state-list">
          <div class="state-row" v-for="item in statusItems" :key="item.label">
            <div class="state-bar-wrap">
              <span class="state-label">{{ item.icon }} {{ item.label }}</span>
              <div class="state-track">
                <div class="state-fill" :class="`tone-${item.tone}`" :style="{ width: `${Math.round(item.value * 100)}%` }"></div>
              </div>
              <span class="state-val">{{ Math.round(item.value * 100) }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="panel-divider"></div>

      <div class="panel-section panel-footer">
        <div class="relationship-badge">
          <span class="badge-phase">{{ phaseLabel }}</span>
        </div>
        <p class="relationship-hint">{{ relationshipHint }}</p>
        <button class="btn-memory" @click="showMemoryPanel = true">
          <span>📝</span> 关于你
        </button>
      </div>
    </aside>

    <!-- Chat area -->
    <section class="conversation">
      <header class="conversation-header">
        <button class="btn-back-mobile" @click="$emit('back')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <div class="header-center" @click="showMobilePanel = true">
          <span class="header-name">{{ character.name }}</span>
          <span class="header-status">{{ moodEmoji }} {{ moodLabel }} · {{ phaseLabel }}</span>
        </div>
        <div class="header-actions">
          <button class="tool-button" @click="showMemoryPanel = true">记忆</button>
          <button
            v-if="messages.length > 0"
            class="tool-button"
            :disabled="loading"
            @click="onClearHistory"
          >清空</button>
        </div>
      </header>

      <div class="chat-body" ref="chatBody">
        <div v-if="messages.length === 0" class="empty-state">
          <div class="empty-avatar">{{ character.name.slice(0, 1) }}</div>
          <div class="empty-title">{{ character.name }}</div>
          <div class="empty-copy">{{ emptyCopy }}</div>
        </div>

        <div
          v-for="(msg, i) in messages"
          :key="i"
          :class="[
            'msg',
            msg.role === 'user' ? 'msg-user' : 'msg-bot',
            i > 0 && messages[i - 1].role === msg.role ? 'msg-consecutive' : ''
          ]"
        >
          <div v-if="!(i > 0 && messages[i - 1].role === msg.role)" class="msg-avatar">
            {{ msg.role === 'user' ? '你' : character.name.slice(0, 1) }}
          </div>
          <div class="msg-bubble-wrap" :class="{ 'no-avatar': i > 0 && messages[i - 1].role === msg.role }">
            <div v-if="!(i > 0 && messages[i - 1].role === msg.role) && msg.role === 'assistant'" class="msg-name">{{ character.name }}</div>
            <div v-if="msg.content === '\u200B'" class="msg-bubble typing">
              <span class="typing-dots"><span></span><span></span><span></span></span>
            </div>
            <div v-else class="msg-bubble">{{ msg.content }}</div>
          </div>
        </div>

        <div v-if="loading && !streaming" class="msg msg-bot">
          <div class="msg-avatar">{{ character.name.slice(0, 1) }}</div>
          <div class="msg-bubble-wrap">
            <div class="msg-name">{{ character.name }}</div>
            <div class="msg-bubble typing">
              <span class="typing-dots"><span></span><span></span><span></span></span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="error" class="chat-error">{{ error }}</div>

      <footer class="composer">
        <textarea
          v-model="inputText"
          @keydown="handleKeydown"
          placeholder="输入消息..."
          rows="1"
          :disabled="loading"
        ></textarea>
        <button @click="send" :disabled="loading || !inputText.trim()" class="btn-send">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2L15 22 11 13 2 9 22 2Z"/></svg>
        </button>
      </footer>
    </section>

    <!-- Memory Panel Overlay -->
    <Transition name="fade">
      <div v-if="showMemoryPanel" class="memory-overlay" @click="showMemoryPanel = false">
        <div class="memory-panel-modal" @click.stop>
          <div class="memory-panel-header-bar">
            <h3>{{ character.name }} 的记忆</h3>
            <button class="btn-close-memory" @click="showMemoryPanel = false">✕</button>
          </div>
          <MemoryPanel
            :character-id="character.id || 0"
            :user-id="userId"
            :character-name="character.name"
          />
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* ====== Layout Shell ====== */
.chat-shell {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  background: #f0f2f5;
  overflow: hidden;
}

/* ====== Sidebar Panel ====== */
.companion-panel {
  display: flex;
  flex-direction: column;
  background: #fff;
  border-right: 1px solid #e5e7eb;
  overflow-y: auto;
}

.panel-section {
  padding: 20px 20px 16px;
}

.panel-section.panel-footer {
  margin-top: auto;
  padding-bottom: 20px;
}

.panel-divider {
  height: 1px;
  background: #f0f2f5;
  margin: 0 20px;
}

/* Portrait */
.portrait {
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  width: 72px;
  height: 72px;
  margin: 0 auto 14px;
}

.portrait-ring {
  position: absolute;
  inset: 0;
  border-radius: 20px;
  background: linear-gradient(135deg, rgba(124, 92, 255, 0.15), rgba(233, 95, 128, 0.15));
}

.portrait-initial {
  position: relative;
  width: 72px;
  height: 72px;
  border-radius: 20px;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #1e1b4b, #312e81);
  color: #fff;
  font-size: 1.65rem;
  font-weight: 800;
}

.identity-block {
  text-align: center;
}

.identity-name {
  font-size: 1.15rem;
  font-weight: 700;
  color: #111827;
}

.identity-personality {
  margin-top: 4px;
  font-size: 0.82rem;
  color: #6b7280;
  line-height: 1.4;
}

/* Section Title */
.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
  font-size: 0.8rem;
  font-weight: 600;
  color: #9ca3af;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.mood-badge {
  font-size: 0.75rem;
  font-weight: 500;
  padding: 3px 9px;
  border-radius: 999px;
  background: linear-gradient(135deg, #ede9fe, #fce7f3);
  color: #6b21a8;
  text-transform: none;
  letter-spacing: 0;
}

/* State Bars */
.state-list {
  display: grid;
  gap: 10px;
}

.state-row {
  min-width: 0;
}

.state-bar-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.state-label {
  width: 52px;
  font-size: 0.78rem;
  color: #6b7280;
  flex-shrink: 0;
}

.state-track {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: #f3f4f6;
  overflow: hidden;
}

.state-fill {
  height: 100%;
  border-radius: inherit;
  transition: width 0.4s ease;
}

.state-val {
  width: 26px;
  font-size: 0.75rem;
  font-weight: 600;
  color: #374151;
  text-align: right;
}

.tone-rose { background: linear-gradient(90deg, #fb7185, #e11d48); }
.tone-blue { background: linear-gradient(90deg, #60a5fa, #2563eb); }
.tone-violet { background: linear-gradient(90deg, #a78bfa, #7c3aed); }
.tone-green { background: linear-gradient(90deg, #4ade80, #16a34a); }
.tone-amber { background: linear-gradient(90deg, #fbbf24, #d97706); }

/* Relationship Badge */
.relationship-badge {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.badge-phase {
  font-size: 0.78rem;
  padding: 3px 12px;
  border-radius: 999px;
  background: #f3f4f6;
  color: #374151;
  font-weight: 600;
}

.relationship-hint {
  margin: 0;
  font-size: 0.82rem;
  color: #9ca3af;
  line-height: 1.4;
}

/* ====== Conversation Area ====== */
.conversation {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #f0f2f5;
}

.conversation-header {
  min-height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background: #fff;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
}

.header-center {
  flex: 1;
  text-align: center;
  cursor: pointer;
}

.header-name {
  font-weight: 700;
  font-size: 0.95rem;
  color: #111827;
}

.header-status {
  display: block;
  font-size: 0.72rem;
  color: #9ca3af;
  margin-top: 1px;
}

.btn-back-mobile {
  display: none;
  background: none;
  border: none;
  padding: 4px;
  cursor: pointer;
  color: #6b7280;
}

.header-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.tool-button {
  height: 32px;
  padding: 0 12px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  color: #6b7280;
  cursor: pointer;
  font-size: 0.8rem;
  transition: all 0.15s;
}

.tool-button:hover {
  color: #ef4444;
  border-color: #fca5a5;
  background: #fef2f2;
}

.tool-button:disabled {
  color: #d1d5db;
  border-color: #e5e7eb;
  cursor: not-allowed;
  background: #f9fafb;
}

/* ====== Chat Messages ====== */
.chat-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 16px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.empty-state {
  align-self: center;
  margin-top: 18vh;
  max-width: 300px;
  text-align: center;
}

.empty-avatar {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: linear-gradient(135deg, #1e1b4b, #312e81);
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 1.4rem;
  font-weight: 800;
  margin: 0 auto 12px;
}

.empty-title {
  color: #111827;
  font-weight: 700;
  font-size: 1.05rem;
  margin-bottom: 6px;
}

.empty-copy {
  line-height: 1.6;
  font-size: 0.88rem;
  color: #9ca3af;
}

/* Message bubbles - WeChat style */
.msg {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 85%;
}

.msg-user {
  flex-direction: row-reverse;
  align-self: flex-end;
}

.msg-bot {
  align-self: flex-start;
}

.msg-consecutive {
  margin-top: 2px;
}

.msg-avatar {
  width: 32px;
  height: 32px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  font-size: 0.72rem;
  font-weight: 700;
  flex-shrink: 0;
}

.msg-user .msg-avatar {
  background: #e5e7eb;
  color: #374151;
}

.msg-bot .msg-avatar {
  background: linear-gradient(135deg, #1e1b4b, #312e81);
  color: #fff;
}

.msg-bubble-wrap {
  flex: 1;
  min-width: 0;
}

.msg-bubble-wrap.no-avatar {
  margin-left: 40px;
}

.msg-user .msg-bubble-wrap.no-avatar {
  margin-left: 0;
  margin-right: 40px;
}

.msg-name {
  font-size: 0.72rem;
  color: #9ca3af;
  margin-bottom: 2px;
  margin-left: 2px;
}

.msg-bubble {
  padding: 10px 13px;
  border-radius: 16px;
  font-size: 0.92rem;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  position: relative;
}

.msg-user .msg-bubble {
  background: #95ec69;
  color: #000;
  border-bottom-right-radius: 4px;
}

.msg-bot .msg-bubble {
  background: #fff;
  color: #111827;
  border-bottom-left-radius: 4px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.msg-consecutive .msg-bubble {
  border-radius: 16px;
}

.msg-user.msg-consecutive .msg-bubble {
  border-bottom-right-radius: 4px;
}

.msg-bot.msg-consecutive .msg-bubble {
  border-bottom-left-radius: 4px;
}

/* Typing indicator */
.typing {
  padding: 10px 16px;
}

.typing-dots {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}

.typing-dots span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #9ca3af;
  animation: typing-bounce 1.2s ease-in-out infinite;
}

.typing-dots span:nth-child(2) { animation-delay: 0.15s; }
.typing-dots span:nth-child(3) { animation-delay: 0.3s; }

@keyframes typing-bounce {
  0%, 60%, 100% { transform: translateY(0); }
  30% { transform: translateY(-4px); }
}

/* Error */
.chat-error {
  margin: 0 16px 8px;
  padding: 8px 12px;
  border-radius: 10px;
  background: #fef2f2;
  color: #b91c1c;
  border: 1px solid #fecaca;
  font-size: 0.84rem;
  flex-shrink: 0;
}

/* ====== Composer ====== */
.composer {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 12px 16px 14px;
  background: #f7f8fa;
  border-top: 1px solid #e5e7eb;
  flex-shrink: 0;
}

.composer textarea {
  flex: 1;
  min-height: 40px;
  max-height: 100px;
  padding: 10px 14px;
  border: 1px solid #e5e7eb;
  border-radius: 20px;
  resize: none;
  color: #111827;
  font-size: 0.92rem;
  line-height: 1.45;
  font-family: inherit;
  box-sizing: border-box;
  background: #fff;
  transition: border-color 0.15s;
}

.composer textarea:focus {
  outline: none;
  border-color: #95ec69;
  box-shadow: 0 0 0 2px rgba(149, 236, 105, 0.2);
}

.btn-send {
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 20px;
  background: #07c160;
  color: #fff;
  display: grid;
  place-items: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s, opacity 0.15s;
}

.btn-send:hover:not(:disabled) {
  background: #06ad56;
}

.btn-send:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  background: #07c160;
}

/* ====== Mobile Panel Overlay ====== */
.mobile-panel-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 100;
  align-items: flex-end;
  justify-content: center;
}

.mobile-panel {
  background: #fff;
  border-radius: 20px 20px 0 0;
  padding: 24px 20px 32px;
  width: 100%;
  max-width: 480px;
  max-height: 70vh;
  overflow-y: auto;
}

.mobile-panel-header {
  text-align: center;
  margin-bottom: 20px;
}

.mobile-portrait {
  margin: 0 auto 10px;
  width: 56px;
  height: 56px;
}

.mobile-portrait-initial {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: linear-gradient(135deg, #1e1b4b, #312e81);
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 1.3rem;
  font-weight: 800;
  margin: 0 auto;
}

.mobile-panel-header h3 {
  margin: 0 0 4px;
  font-size: 1.1rem;
  color: #111827;
}

.mobile-personality {
  font-size: 0.82rem;
  color: #6b7280;
  margin: 0;
}

.mobile-status {
  display: grid;
  gap: 10px;
  margin-bottom: 16px;
}

.mobile-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mobile-status-label {
  width: 52px;
  font-size: 0.78rem;
  color: #6b7280;
  flex-shrink: 0;
}

.mobile-status-bar {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: #f3f4f6;
  overflow: hidden;
}

.mobile-status-fill {
  height: 100%;
  border-radius: inherit;
  transition: width 0.4s ease;
}

.mobile-status-val {
  width: 26px;
  font-size: 0.75rem;
  font-weight: 600;
  color: #374151;
  text-align: right;
}

.mobile-tags {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.mobile-tag {
  font-size: 0.78rem;
  padding: 4px 12px;
  border-radius: 999px;
  background: linear-gradient(135deg, #ede9fe, #fce7f3);
  color: #6b21a8;
  font-weight: 500;
}

.mobile-hint {
  font-size: 0.82rem;
  color: #9ca3af;
  margin: 0 0 16px;
}

.mobile-panel-close {
  width: 100%;
  padding: 10px;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  background: #f9fafb;
  color: #374151;
  font-size: 0.9rem;
  cursor: pointer;
}

.mobile-panel-close:hover {
  background: #f3f4f6;
}

/* Slide transition */
.slide-enter-active,
.slide-leave-active {
  transition: opacity 0.2s ease;
}

.slide-enter-active .mobile-panel,
.slide-leave-active .mobile-panel {
  transition: transform 0.25s ease;
}

/* ====== Responsive ====== */
@media (max-width: 860px) {
  .chat-shell {
    grid-template-columns: 1fr;
  }

  .companion-panel {
    display: none;
  }

  .mobile-panel-overlay {
    display: flex;
  }

  .btn-back-mobile {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .conversation-header {
    padding: 0 8px;
    min-height: 50px;
  }

  .msg {
    max-width: 90%;
  }

  .msg-avatar {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    font-size: 0.65rem;
  }

  .msg-bubble-wrap.no-avatar {
    margin-left: 36px;
  }

  .msg-user .msg-bubble-wrap.no-avatar {
    margin-right: 36px;
  }
}

/* ====== Memory Panel Overlay ====== */
.memory-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.memory-panel-modal {
  background: #fff;
  border-radius: 20px;
  width: 100%;
  max-width: 520px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
}

.memory-panel-header-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid #f0f2f5;
  flex-shrink: 0;
}

.memory-panel-header-bar h3 {
  margin: 0;
  font-size: 1rem;
  color: #111827;
}

.btn-close-memory {
  background: none;
  border: none;
  color: #9ca3af;
  font-size: 1rem;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
}

.btn-close-memory:hover {
  background: #f3f4f6;
  color: #374151;
}

/* Sidebar memory button */
.btn-memory {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  margin-top: 12px;
  padding: 8px;
  border: 1px dashed #d1d5db;
  border-radius: 10px;
  background: none;
  color: #6b7280;
  font-size: 0.82rem;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.btn-memory:hover {
  border-color: #a78bfa;
  color: #6b21a8;
  background: #f5f3ff;
}

/* Fade transition */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>