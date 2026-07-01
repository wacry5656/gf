<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Character, ChatMessage, EmotionInfo, RelationshipInfo } from '../api'
import { checkInitiativeEligibility, checkLongAbsence, clearMessages, generateInitiativeMessage, getEmotion, getRelationship, recallLastMessage, saveMessage, searchMessages, sendMessage, sendMessageStream, StreamChatError, triggerRandomEvent } from '../api'
import type { SearchResult } from '../api'
import { clearChatDraft, getChatDraft, saveChatDraft } from '../userSession'
import MemoryPanel from './MemoryPanel.vue'
import AmbientBackground from './AmbientBackground.vue'
import EmojiPicker from './EmojiPicker.vue'
import {
  getReadAloud,
  setReadAloud,
  isSpeechSupported,
  speakSequence,
  cancelSpeak,
  isVoiceInputSupported,
  startVoiceInput,
  type VoiceInputSession,
} from '../voice'

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
const showSearch = ref(false)
const searchQuery = ref('')
const searchResults = ref<SearchResult[]>([])
const searching = ref(false)

// ====== 花哨 UX 状态 ======
const readAloud = ref(getReadAloud())
const speechSupported = isSpeechSupported()
const voiceInputSupported = isVoiceInputSupported()
const recording = ref(false)
const showEmoji = ref(false)
const showQuickActions = ref(false)
const reactedSet = ref<Set<string>>(new Set())
const showScrollBtn = ref(false)
const copiedSig = ref<string | null>(null)
const hearts = ref<Array<{ id: number; left: number; delay: number; size: number; symbol: string }>>([])
const composerEl = ref<HTMLTextAreaElement | null>(null)
let voiceSession: VoiceInputSession | null = null
let heartSeq = 0
let copiedTimer: ReturnType<typeof setTimeout> | null = null
let lastAffection: number | null = null

const quickActions = [
  { emoji: '🌹', label: '送花', text: '送你一束花🌹' },
  { emoji: '🤗', label: '抱抱', text: '抱抱你～' },
  { emoji: '☕', label: '奶茶', text: '请你喝奶茶🧋' },
  { emoji: '😘', label: '亲亲', text: '么么哒😘' },
  { emoji: '🍜', label: '吃了吗', text: '吃饭了吗？' },
  { emoji: '🌙', label: '晚安', text: '晚安，做个好梦🌙' },
]

const charCount = computed(() => inputText.value.length)

function msgSignature(msg: ChatMessage, index: number): string {
  return `${index}::${msg.role}::${msg.content.slice(0, 24)}`
}

let statusRequestId = 0
let initiativeTimer: ReturnType<typeof setTimeout> | null = null
let initiativePollInterval: ReturnType<typeof setInterval> | null = null
let longAbsenceCheckedForCharacterId: number | null = null
let initiativePrimedForCharacterId: number | null = null

function displayPersonality(raw: string): string {
  const publicText = (raw || '')
    .replace(/\s+/g, ' ')
    .split(/[\n\r]|主动[:：]|回复节奏[:：]|边界[:：]|禁止旁白|禁止动作|禁止心理|系统规则|聊天规则/)[0]
    ?.trim() || '自然聊天'
  return publicText
    .replace(/^(自然|温和|直率|轻松|克制|慢热|毒舌)[:：]\s*/, '$1：')
    .replace(/[。.]?$/, '')
}

const bubbleTone = computed(() => {
  const p = (props.character.personality || '').toLowerCase()
  const d = (props.character.description || '').toLowerCase()
  const t = p + ' ' + d
  if (/温柔|治愈|体贴|暖/.test(t)) return 'warm'
  if (/毒舌|暴躁|冷淡|高冷/.test(t)) return 'cool'
  if (/活泼|开朗|轻松|幽默|元气/.test(t)) return 'sunny'
  if (/傲娇|别扭|克制/.test(t)) return 'cool'
  if (/直球|主动|坦率/.test(t)) return 'sunny'
  return 'natural'
})

const moodEmoji = computed(() => {
  const map: Record<string, string> = {
    warm: '😊', happy: '😄', playful: '😏', shy: '🫣',
    caring: '🤗', upset: '😤', jealous: '😒', distant: '😶',
    sulking: '😠', disappointed: '😞', anticipating: '✨',
  }
  return map[emotionInfo.value?.mood || 'warm'] || '😊'
})

const moodAccent = computed(() => {
  const map: Record<string, [string, string]> = {
    warm: ['#fca5a5', '#f472b6'], happy: ['#fde047', '#fb923c'], playful: ['#c084fc', '#f472b6'],
    shy: ['#fbcfe8', '#f9a8d4'], caring: ['#86efac', '#34d399'], upset: ['#93c5fd', '#818cf8'],
    jealous: ['#a5b4fc', '#c084fc'], distant: ['#cbd5e1', '#94a3b8'], sulking: ['#94a3b8', '#64748b'],
    disappointed: ['#a8b8d8', '#8ea0c8'], anticipating: ['#fcd34d', '#f472b6'],
  }
  const [a, b] = map[emotionInfo.value?.mood || 'warm'] || map.warm
  return `linear-gradient(90deg, ${a}, ${b})`
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

async function checkAndShowLongAbsence() {
  if (!props.character?.id || !props.userId) return
  if (longAbsenceCheckedForCharacterId === props.character.id) return

  longAbsenceCheckedForCharacterId = props.character.id

  try {
    const result = await checkLongAbsence(props.character.id, props.userId)
    if (result.absent && result.greeting.length > 0) {
      const updated = [...props.messages]
      for (const msg of result.greeting) {
        updated.push({ role: 'assistant', content: msg })
      }
      emit('update:messages', updated)
      maybeSpeak(result.greeting)
    }
  } catch {
    longAbsenceCheckedForCharacterId = null
  }
}

onMounted(fetchStatus)

watch(() => props.character?.id, fetchStatus)
watch(() => props.userId, fetchStatus)

watch(
  () => props.character?.id,
  () => {
    longAbsenceCheckedForCharacterId = null
    initiativePrimedForCharacterId = null
    sessionInitiativeCount.value = 0
  },
  { immediate: true },
)

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

function stripTypingMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.content !== '\u200B')
}

function applyAssistantReplies(baseMessages: ChatMessage[], replies: string[], streamContent = '') {
  if (replies.length > 0) {
    const finalMessages = [...baseMessages]
    for (const reply of replies) {
      finalMessages.push({ role: 'assistant', content: reply })
    }
    emit('update:messages', finalMessages)
    maybeSpeak(replies)
    return true
  }

  if (streamContent) {
    emit('update:messages', [...baseMessages, { role: 'assistant', content: streamContent }])
    maybeSpeak([streamContent])
    return true
  }

  return false
}

// ====== 朗读（TTS） ======

function maybeSpeak(replies: string[]) {
  if (!readAloud.value || !speechSupported) return
  const texts = replies.map((r) => r.trim()).filter((r) => r && r !== '​')
  if (texts.length > 0) speakSequence(texts, props.character.gender)
}

function toggleReadAloud() {
  const next = !readAloud.value
  readAloud.value = next
  setReadAloud(next)
  if (!next) cancelSpeak()
}

// ====== 语音输入（STT） ======

function toggleVoiceInput() {
  if (recording.value) {
    voiceSession?.stop()
    return
  }
  if (!voiceInputSupported) {
    error.value = '当前浏览器不支持语音输入'
    return
  }
  error.value = ''
  recording.value = true
  voiceSession = startVoiceInput(
    (text) => { inputText.value = text },
    () => { recording.value = false; voiceSession = null; focusComposer() },
    (message) => { error.value = message; recording.value = false; voiceSession = null },
  )
  if (!voiceSession) recording.value = false
}

// ====== 表情选择 ======

function onEmojiSelect(emoji: string) {
  inputText.value += emoji
  focusComposer()
}

function focusComposer() {
  nextTick(() => composerEl.value?.focus())
}

// ====== 快捷互动 ======

async function quickSend(text: string) {
  if (loading.value) return
  showQuickActions.value = false
  inputText.value = text
  await send()
}

// ====== 消息点赞（双击爱心） ======

function toggleReaction(sig: string) {
  const set = new Set(reactedSet.value)
  if (set.has(sig)) {
    set.delete(sig)
  } else {
    set.add(sig)
    burstHearts(['💖', '💗', '💕'])
  }
  reactedSet.value = set
}

// ====== 复制消息 ======

async function copyMessage(sig: string, content: string) {
  try {
    await navigator.clipboard.writeText(content)
    copiedSig.value = sig
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copiedSig.value = null }, 1400)
  } catch {
    error.value = '复制失败'
  }
}

// ====== 爱心特效 ======

function burstHearts(symbols: string[] = ['❤️', '💖', '💗', '💕', '✨']) {
  const batch = 7
  for (let i = 0; i < batch; i++) {
    const id = heartSeq++
    hearts.value.push({
      id,
      left: 30 + Math.random() * 40,
      delay: Math.random() * 0.35,
      size: 18 + Math.random() * 18,
      symbol: symbols[Math.floor(Math.random() * symbols.length)],
    })
    setTimeout(() => {
      hearts.value = hearts.value.filter((h) => h.id !== id)
    }, 2200)
  }
}

// 好感度上升时来一波庆祝特效。
watch(
  () => emotionInfo.value?.affection,
  (next) => {
    if (typeof next !== 'number') return
    if (lastAffection !== null && next - lastAffection >= 0.02) {
      burstHearts(['💗', '💖', '💕', '💘', '✨'])
    }
    lastAffection = next
  },
)

// ====== 滚动到底部按钮 ======

function onChatScroll() {
  const el = chatBody.value
  if (!el) return
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  showScrollBtn.value = distanceFromBottom > 240
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
  let streamContent = ''

  try {
    if (props.character.id) {
      await saveMessage(props.character.id, 'user', text, props.userId)
    }

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
    const hadPartialReply = streamContent.trim().length > 0 || (e instanceof StreamChatError && e.stage === 'after-partial')
    const shouldFallbackToNonStream = !streaming.value || hadPartialReply

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
    if (!hadPartialReply && !streaming.value) {
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

async function onRecallLast() {
  if (!props.character.id) return
  if (loading.value) return
  const last = props.messages[props.messages.length - 1]
  if (!last || last.role !== 'user') return
  const content = last.content
  try {
    await recallLastMessage(props.character.id, props.userId, 'user')
    const updated = props.messages.slice(0, -1)
    emit('update:messages', updated)
    inputText.value = content
  } catch (e: any) {
    error.value = e?.message || '撤回失败'
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

  // 每 30 秒检查一次
  initiativePollInterval = setInterval(() => {
    checkAndSendInitiative()
  }, 30000)
}

async function checkAndSendInitiative() {
  if (!props.character.id || !props.userId) return
  if (loading.value || initiativeLoading.value) return
  if (props.messages.length === 0) return

  initiativeLoading.value = true
  const baseMessages = stripTypingMessages(props.messages)

  try {
    // 先尝试随机事件（15%概率触发）
    const randomResult = await triggerRandomEvent(props.character.id, props.userId)
    if (randomResult.triggered && randomResult.replies.length > 0) {
      const finalMessages = [...baseMessages]
      for (const reply of randomResult.replies) {
        finalMessages.push({ role: 'assistant', content: reply })
      }
      emit('update:messages', finalMessages)
      maybeSpeak(randomResult.replies)
      fetchStatus()
      return
    }

    const eligibility = await checkInitiativeEligibility(
      props.character.id,
      props.userId,
      sessionInitiativeCount.value
    )

    if (!eligibility.eligible) return

    // 显示 typing
    const typingMsg: ChatMessage = { role: 'assistant', content: '\u200B' }
    const withTyping = [...baseMessages, typingMsg]
    emit('update:messages', withTyping)
    scrollToBottom()

    // 生成主动消息
    const replies = await generateInitiativeMessage(
      props.character,
      baseMessages,
      props.userId
    )

    if (replies.length > 0) {
      sessionInitiativeCount.value++
      const finalMessages = [...baseMessages]
      for (const reply of replies) {
        finalMessages.push({ role: 'assistant', content: reply })
      }
      emit('update:messages', finalMessages)
      maybeSpeak(replies)
      fetchStatus()
    } else {
      // 生成失败，移除 typing
      emit('update:messages', baseMessages)
    }
  } catch (e: any) {
    console.error('[Initiative] 主动消息失败:', e)
    // 移除 typing
    emit('update:messages', baseMessages)
  } finally {
    initiativeLoading.value = false
  }
}

function closePopovers() {
  showEmoji.value = false
  showQuickActions.value = false
}

onMounted(() => {
  startInitiativePolling()
  document.addEventListener('click', closePopovers)
})

watch(
  () => [props.character?.id, props.messages.length] as const,
  ([characterId, messageCount], previous) => {
    if (!characterId || messageCount === 0) return

    checkAndShowLongAbsence()

    const [previousCharacterId, previousMessageCount] = previous ?? [null, 0]
    if (initiativePrimedForCharacterId !== characterId && (previousCharacterId !== characterId || previousMessageCount === 0)) {
      initiativePrimedForCharacterId = characterId
      checkAndSendInitiative()
    }
  },
  { immediate: true },
)

onUnmounted(() => {
  clearInitiativeTimers()
  cancelSpeak()
  voiceSession?.stop()
  if (copiedTimer) clearTimeout(copiedTimer)
  document.removeEventListener('click', closePopovers)
})

// 切换角色时停止朗读与录音，避免串音。
watch(() => props.character?.id, () => {
  cancelSpeak()
  if (recording.value) { voiceSession?.stop(); recording.value = false }
  showEmoji.value = false
  showQuickActions.value = false
  reactedSet.value = new Set()
  lastAffection = null
})

// ====== 搜索 ======

async function doSearch() {
  const q = searchQuery.value.trim()
  if (!q || !props.character.id) return
  searching.value = true
  try {
    searchResults.value = await searchMessages(props.character.id, props.userId, q)
  } catch (e: any) {
    console.error('[Search] 失败:', e)
  } finally {
    searching.value = false
  }
}

function highlightText(text: string, query: string): string {
  if (!query) return text
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const safeText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const regex = new RegExp(`(${escaped})`, 'gi')
  return safeText.replace(regex, '<mark>$1</mark>')
}
</script>

<template>
  <div class="chat-shell" :class="`tone-${bubbleTone}`">
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
      <AmbientBackground />
      <header class="conversation-header">
        <button class="btn-back-mobile" @click="$emit('back')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <div class="header-center" @click="showMobilePanel = true">
          <span class="header-name">{{ character.name }}</span>
          <span class="header-status">{{ moodEmoji }} {{ moodLabel }} · {{ phaseLabel }}</span>
        </div>
        <div class="header-actions">
          <button
            v-if="speechSupported"
            class="tool-button tool-icon"
            :class="{ 'tool-active': readAloud }"
            :title="readAloud ? '关闭语音朗读' : '开启语音朗读'"
            @click="toggleReadAloud"
          >{{ readAloud ? '🔊' : '🔇' }}</button>
          <button
            v-if="messages.length > 0 && messages[messages.length - 1].role === 'user'"
            class="tool-button"
            :disabled="loading"
            @click="onRecallLast"
          >撤回</button>
          <button class="tool-button" @click="showSearch = true">搜索</button>
          <button class="tool-button" @click="showMemoryPanel = true">记忆</button>
          <button
            v-if="messages.length > 0"
            class="tool-button"
            :disabled="loading"
            @click="onClearHistory"
          >清空</button>
        </div>
      </header>
      <div class="mood-bar" :style="{ background: moodAccent }"></div>

      <div class="chat-body" ref="chatBody" @scroll="onChatScroll">
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
            <div
              v-else
              class="msg-bubble has-actions"
              :class="{ reacted: reactedSet.has(msgSignature(msg, i)) }"
              @dblclick="toggleReaction(msgSignature(msg, i))"
            >
              <span class="bubble-text">{{ msg.content }}</span>
              <div class="bubble-tools">
                <button
                  class="bubble-tool"
                  :title="copiedSig === msgSignature(msg, i) ? '\u5DF2\u590D\u5236' : '\u590D\u5236'"
                  @click.stop="copyMessage(msgSignature(msg, i), msg.content)"
                >{{ copiedSig === msgSignature(msg, i) ? '\u2713' : '\u29C9' }}</button>
                <button
                  class="bubble-tool"
                  :title="'\u559C\u6B22'"
                  @click.stop="toggleReaction(msgSignature(msg, i))"
                >{{ reactedSet.has(msgSignature(msg, i)) ? '\uD83D\uDC96' : '\uD83E\uDD0D' }}</button>
              </div>
              <span v-if="reactedSet.has(msgSignature(msg, i))" class="reaction-badge">{{ '\u2764\uFE0F' }}</span>
            </div>
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

      <!-- 爱心特效层 -->
      <div class="hearts-layer" aria-hidden="true">
        <span
          v-for="h in hearts"
          :key="h.id"
          class="floating-heart"
          :style="{ left: `${h.left}%`, fontSize: `${h.size}px`, animationDelay: `${h.delay}s` }"
        >{{ h.symbol }}</span>
      </div>

      <!-- 回到底部 -->
      <Transition name="fade">
        <button v-if="showScrollBtn" class="scroll-bottom-btn" @click="scrollToBottom" title="回到最新">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
        </button>
      </Transition>

      <div v-if="error" class="chat-error">{{ error }}</div>

      <div class="composer-wrap">
        <!-- 快捷互动 -->
        <Transition name="fade">
          <div v-if="showQuickActions" class="quick-actions">
            <button
              v-for="qa in quickActions"
              :key="qa.label"
              class="quick-chip"
              :disabled="loading"
              @click="quickSend(qa.text)"
            ><span class="quick-emoji">{{ qa.emoji }}</span>{{ qa.label }}</button>
          </div>
        </Transition>

        <footer class="composer">
          <button
            class="composer-icon"
            :class="{ active: showQuickActions }"
            title="快捷互动"
            @click.stop="showQuickActions = !showQuickActions; showEmoji = false"
          >🎁</button>

          <div class="emoji-wrap">
            <button
              class="composer-icon"
              :class="{ active: showEmoji }"
              title="表情"
              @click.stop="showEmoji = !showEmoji; showQuickActions = false"
            >😊</button>
            <Transition name="emoji-pop">
              <div v-if="showEmoji" class="emoji-pop">
                <EmojiPicker @select="onEmojiSelect" />
              </div>
            </Transition>
          </div>

          <button
            v-if="voiceInputSupported"
            class="composer-icon"
            :class="{ recording }"
            :title="recording ? '停止语音输入' : '语音输入'"
            @click="toggleVoiceInput"
          >🎤</button>

          <textarea
            ref="composerEl"
            v-model="inputText"
            @keydown="handleKeydown"
            :placeholder="recording ? '正在聆听…' : '输入消息...'"
            rows="1"
            :disabled="loading"
          ></textarea>
          <span v-if="charCount > 0" class="char-count">{{ charCount }}</span>
          <button @click="send" :disabled="loading || !inputText.trim()" class="btn-send">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2L15 22 11 13 2 9 22 2Z"/></svg>
          </button>
        </footer>
      </div>
    </section>

    <!-- Search Overlay -->
    <Transition name="fade">
      <div v-if="showSearch" class="search-overlay" @click="showSearch = false">
        <div class="search-panel" @click.stop>
          <div class="search-header">
            <input
              v-model="searchQuery"
              type="text"
              placeholder="搜索聊天记录..."
              class="search-input"
              @keyup.enter="doSearch"
            />
            <button class="btn-search" @click="doSearch" :disabled="searching">{{ searching ? '...' : '搜索' }}</button>
            <button class="btn-close-search" @click="showSearch = false">✕</button>
          </div>
          <div class="search-results">
            <div v-if="searchResults.length === 0 && searchQuery && !searching" class="search-empty">没有结果</div>
            <div v-for="(result, i) in searchResults" :key="i" class="search-result-item">
              <span class="search-result-role">{{ result.role === 'user' ? '你' : character.name }}</span>
              <span class="search-result-text" v-html="highlightText(result.content, searchQuery)"></span>
              <span class="search-result-time">{{ new Date(result.created_at).toLocaleDateString() }}</span>
            </div>
          </div>
        </div>
      </div>
    </Transition>

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
  background: var(--chat-bg, #f0f2f5);
  overflow: hidden;
}

/* ====== Sidebar Panel ====== */
.companion-panel {
  display: flex;
  flex-direction: column;
  background: var(--panel-bg, #fff);
  border-right: 1px solid var(--border-color, #e5e7eb);
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
  position: relative;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--chat-bg, #f0f2f5);
  overflow: hidden;
}

.conversation-header {
  position: relative;
  z-index: 3;
  min-height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background: var(--panel-bg, #fff);
  border-bottom: 1px solid var(--border-color, #e5e7eb);
  flex-shrink: 0;
}

/* 情绪色带 */
.mood-bar {
  position: relative;
  z-index: 3;
  height: 3px;
  flex-shrink: 0;
  background: linear-gradient(90deg, #fca5a5, #f472b6);
  background-size: 200% 100%;
  transition: background 0.6s ease;
  animation: mood-shift 6s ease-in-out infinite;
}

@keyframes mood-shift {
  0%, 100% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
}

.tool-icon {
  padding: 0 9px;
  font-size: 0.95rem;
}

.tool-icon.tool-active {
  border-color: var(--accent, #07c160);
  background: color-mix(in srgb, var(--accent, #07c160) 14%, transparent);
}

.tool-button.tool-icon:hover {
  color: inherit;
  border-color: var(--accent, #07c160);
  background: color-mix(in srgb, var(--accent, #07c160) 12%, transparent);
}

.header-center {
  flex: 1;
  text-align: center;
  cursor: pointer;
}

.header-name {
  font-weight: 700;
  font-size: 0.95rem;
  color: var(--text-primary, #111827);
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
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 8px;
  background: var(--panel-bg, #fff);
  color: var(--text-secondary, #6b7280);
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
  position: relative;
  z-index: 1;
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
  color: var(--text-primary, #111827);
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
  white-space: normal;
  word-break: break-word;
  position: relative;
}

.bubble-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.msg-user .msg-bubble {
  background: var(--user-bubble, #95ec69);
  color: var(--text-primary, #000);
  border-bottom-right-radius: 4px;
}

.msg-bot .msg-bubble {
  background: var(--bot-bubble, #fff);
  color: var(--text-primary, #111827);
  border-bottom-left-radius: 4px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

/* 气泡交互工具 */
.msg-bubble.has-actions {
  transition: transform 0.15s ease, box-shadow 0.2s ease;
}

.msg-bubble.reacted {
  box-shadow: 0 0 0 1.5px color-mix(in srgb, #f472b6 55%, transparent);
}

.bubble-tools {
  position: absolute;
  top: -12px;
  display: flex;
  gap: 3px;
  padding: 2px;
  border-radius: 999px;
  background: var(--panel-bg, #fff);
  border: 1px solid var(--border-color, #e5e7eb);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.12);
  opacity: 0;
  transform: translateY(4px) scale(0.9);
  pointer-events: none;
  transition: opacity 0.14s ease, transform 0.14s ease;
  z-index: 4;
}

.msg-user .bubble-tools { right: 6px; }
.msg-bot .bubble-tools { left: 6px; }

.msg-bubble.has-actions:hover .bubble-tools {
  opacity: 1;
  transform: translateY(0) scale(1);
  pointer-events: auto;
}

.bubble-tool {
  border: none;
  background: none;
  cursor: pointer;
  font-size: 0.78rem;
  line-height: 1;
  padding: 4px 6px;
  border-radius: 999px;
  transition: background 0.12s, transform 0.12s;
}

.bubble-tool:hover {
  background: var(--app-bg, #f3f4f6);
  transform: scale(1.15);
}

.reaction-badge {
  position: absolute;
  bottom: -9px;
  right: -4px;
  font-size: 0.72rem;
  padding: 1px 4px;
  border-radius: 999px;
  background: var(--panel-bg, #fff);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
  animation: reaction-pop 0.32s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.msg-user .reaction-badge { right: auto; left: -4px; }

@keyframes reaction-pop {
  0% { transform: scale(0); }
  100% { transform: scale(1); }
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
  background: var(--panel-bg, #f7f8fa);
  border-top: 1px solid var(--border-color, #e5e7eb);
  flex-shrink: 0;
}

.composer textarea {
  flex: 1;
  min-height: 40px;
  max-height: 100px;
  padding: 10px 14px;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 20px;
  resize: none;
  color: var(--text-primary, #111827);
  font-size: 0.92rem;
  line-height: 1.45;
  font-family: inherit;
  box-sizing: border-box;
  background: var(--input-bg, #fff);
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
  background: var(--accent, #07c160);
  color: #fff;
  display: grid;
  place-items: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s, opacity 0.15s;
}

.btn-send:hover:not(:disabled) {
  background: var(--accent-hover, #06ad56);
}

.btn-send:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  background: var(--accent, #07c160);
}

/* ====== 爱心特效层 ====== */
.hearts-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: 6;
}

.floating-heart {
  position: absolute;
  bottom: 84px;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.15));
  animation: heart-float 2.1s ease-out forwards;
  will-change: transform, opacity;
}

@keyframes heart-float {
  0% { transform: translateY(0) scale(0.4) rotate(0deg); opacity: 0; }
  15% { opacity: 1; transform: translateY(-16px) scale(1.1) rotate(-6deg); }
  70% { opacity: 1; }
  100% { transform: translateY(-58vh) scale(0.9) rotate(10deg); opacity: 0; }
}

/* ====== 回到底部 ====== */
.scroll-bottom-btn {
  position: absolute;
  right: 18px;
  bottom: 96px;
  z-index: 5;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: 1px solid var(--border-color, #e5e7eb);
  background: var(--panel-bg, #fff);
  color: var(--accent, #07c160);
  display: grid;
  place-items: center;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14);
  transition: transform 0.15s, box-shadow 0.15s;
}

.scroll-bottom-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.2);
}

/* ====== Composer 增强 ====== */
.composer-wrap {
  position: relative;
  z-index: 3;
  flex-shrink: 0;
}

.quick-actions {
  display: flex;
  gap: 8px;
  padding: 10px 14px 2px;
  overflow-x: auto;
  background: var(--panel-bg, #f7f8fa);
  scrollbar-width: none;
}

.quick-actions::-webkit-scrollbar { display: none; }

.quick-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--border-color, #e5e7eb);
  background: var(--input-bg, #fff);
  color: var(--text-primary, #374151);
  font-size: 0.82rem;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.quick-chip:hover:not(:disabled) {
  border-color: var(--accent, #07c160);
  transform: translateY(-1px);
  box-shadow: 0 3px 10px var(--accent-glow, rgba(7, 193, 96, 0.25));
}

.quick-chip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.quick-emoji {
  font-size: 0.95rem;
}

.composer-icon {
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  border: none;
  border-radius: 50%;
  background: none;
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: background 0.15s, transform 0.15s;
}

.composer-icon:hover {
  background: color-mix(in srgb, var(--accent, #07c160) 12%, transparent);
  transform: translateY(-1px);
}

.composer-icon.active {
  background: color-mix(in srgb, var(--accent, #07c160) 18%, transparent);
}

.composer-icon.recording {
  background: rgba(239, 68, 68, 0.15);
  animation: mic-pulse 1.1s ease-in-out infinite;
}

@keyframes mic-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); }
  50% { box-shadow: 0 0 0 6px rgba(239, 68, 68, 0); }
}

.emoji-wrap {
  position: relative;
  flex-shrink: 0;
}

.emoji-pop {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 0;
  z-index: 20;
}

.char-count {
  align-self: flex-end;
  margin-bottom: 12px;
  font-size: 0.68rem;
  color: var(--text-secondary, #9ca3af);
  flex-shrink: 0;
}

.emoji-pop-enter-active,
.emoji-pop-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
  transform-origin: bottom left;
}

.emoji-pop-enter-from,
.emoji-pop-leave-to {
  opacity: 0;
  transform: scale(0.9) translateY(6px);
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
  background: var(--panel-bg, #fff);
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
  background: var(--panel-bg, #fff);
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

/* ====== Search Overlay ====== */
.search-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 200;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 15vh;
}

.search-panel {
  background: var(--panel-bg, #fff);
  border-radius: 16px;
  width: 100%;
  max-width: 480px;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
}

.search-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid #f0f2f5;
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 10px;
  font-size: 0.9rem;
  font-family: inherit;
  outline: none;
}

.search-input:focus {
  border-color: #95ec69;
}

.btn-search {
  padding: 8px 14px;
  background: #07c160;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 0.82rem;
  cursor: pointer;
  font-family: inherit;
}

.btn-search:disabled {
  opacity: 0.5;
}

.btn-close-search {
  background: none;
  border: none;
  color: #9ca3af;
  font-size: 1rem;
  cursor: pointer;
  padding: 4px;
}

.search-results {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.search-empty {
  text-align: center;
  padding: 30px;
  color: #9ca3af;
  font-size: 0.88rem;
}

.search-result-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  margin-bottom: 4px;
  transition: background 0.15s;
}

.search-result-item:hover {
  background: #f9fafb;
}

.search-result-role {
  font-size: 0.72rem;
  font-weight: 600;
  color: #9ca3af;
  flex-shrink: 0;
  width: 36px;
  padding-top: 2px;
}

.search-result-text {
  flex: 1;
  font-size: 0.85rem;
  color: #374151;
  line-height: 1.5;
  word-break: break-word;
}

.search-result-text :deep(mark) {
  background: #fef08a;
  color: #854d0e;
  border-radius: 2px;
  padding: 0 2px;
}

.search-result-time {
  font-size: 0.72rem;
  color: #d1d5db;
  flex-shrink: 0;
}

.chat-shell.tone-warm { --bot-bubble-tint: #fce7f3; --bot-text-tint: #9d174d; --user-bubble-tint: var(--user-bubble); }
.chat-shell.tone-cool  { --bot-bubble-tint: #e0e7ff; --bot-text-tint: #3730a3; --user-bubble-tint: var(--user-bubble); }
.chat-shell.tone-sunny { --bot-bubble-tint: #fef9c3; --bot-text-tint: #854d0e; --user-bubble-tint: var(--user-bubble); }
.chat-shell.tone-natural { --bot-bubble-tint: var(--bot-bubble); --bot-text-tint: var(--text-primary); --user-bubble-tint: var(--user-bubble); }

.chat-shell.tone-warm .msg-bot .msg-bubble,
.chat-shell.tone-cool .msg-bot .msg-bubble,
.chat-shell.tone-sunny .msg-bot .msg-bubble {
  background: var(--bot-bubble-tint);
  color: var(--bot-text-tint);
}
</style>