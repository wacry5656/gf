<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { Character, ChatMessage, EmotionInfo, RelationshipInfo } from '../api'
import { clearMessages, getEmotion, getRelationship, saveMessage, sendMessage, sendMessageStream, StreamChatError } from '../api'
import { clearChatDraft, getChatDraft, saveChatDraft } from '../userSession'

const props = defineProps<{
  character: Character
  messages: ChatMessage[]
  userId: number
}>()

const emit = defineEmits<{
  'update:messages': [messages: ChatMessage[]]
}>()

const inputText = ref('')
const loading = ref(false)
const streaming = ref(false)
const error = ref('')
const chatBody = ref<HTMLElement | null>(null)
const emotionInfo = ref<EmotionInfo | null>(null)
const relationshipInfo = ref<RelationshipInfo | null>(null)
let statusRequestId = 0

function displayPersonality(raw: string): string {
  const publicText = (raw || '')
    .replace(/\s+/g, ' ')
    .split(/[\n\r]|主动[:：]|回复节奏[:：]|边界[:：]|禁止旁白|禁止动作|禁止心理|系统规则|聊天规则/)[0]
    ?.trim() || '自然聊天'
  return publicText
    .replace(/^(自然|温和|直率|轻松|克制|慢热)[:：]\s*/, '$1：')
    .replace(/[。.]?$/, '')
}

const moodLabel = computed(() => emotionInfo.value?.moodLabel || '温柔')
const phaseLabel = computed(() => {
  if (props.character.relationshipMode === 'friend' && !relationshipInfo.value) return '熟悉'
  return relationshipInfo.value?.phaseLabel || (props.character.relationshipMode === 'friend' ? '熟悉' : '亲近')
})

const relationshipHint = computed(() => {
  if (props.character.relationshipMode === 'friend') {
    return '熟悉的日常聊天对象，回复会保持自然克制。'
  }
  const phase = relationshipInfo.value?.phase
  if (phase === 'deep_attached') return '关系很亲近，聊天仍然偏日常。'
  if (phase === 'strained') return '现在有点别扭，需要慢慢聊开。'
  return '稳定的日常关系，轻松自然地聊天。'
})

const emptyCopy = computed(() => {
  const pronoun = props.character.gender === 'male' ? '他' : props.character.gender === 'female' ? '她' : '对方'
  if (props.character.relationshipMode === 'friend') {
    return `${pronoun}会按你们的记忆、熟悉度和最近的话题继续回应。`
  }
  return `${pronoun}会按你们的记忆、关系和情绪继续回应。`
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
    { label: '好感', value: clamp01(emotion?.affection, isFriend ? 0.38 : 0.68), tone: 'rose' },
    { label: '信任', value: clamp01(emotion?.trust_score ?? relationship?.trust, isFriend ? 0.52 : 0.58), tone: 'blue' },
    { label: '亲近', value: clamp01(relationship?.closeness, isFriend ? 0.42 : 0.68), tone: 'violet' },
    { label: isFriend ? '熟悉' : '依赖', value: clamp01(relationship?.dependence, isFriend ? 0.18 : 0.48), tone: 'green' },
    { label: '安心', value: clamp01(relationship?.comfort_level, isFriend ? 0.56 : 0.68), tone: 'amber' },
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
</script>

<template>
  <div class="chat-shell">
    <aside class="companion-panel">
      <div class="portrait">
        <div class="portrait-glow"></div>
        <div class="portrait-initial">{{ character.name.slice(0, 1) }}</div>
      </div>

      <div class="identity-block">
        <div class="identity-kicker">当前对象</div>
        <h2>{{ character.name }}</h2>
        <p>{{ displayPersonality(character.personality) }}</p>
      </div>

      <div class="state-list">
        <div class="state-row" v-for="item in statusItems" :key="item.label">
          <div class="state-meta">
            <span>{{ item.label }}</span>
            <strong>{{ Math.round(item.value * 100) }}</strong>
          </div>
          <div class="state-track">
            <div class="state-fill" :class="`tone-${item.tone}`" :style="{ width: `${Math.round(item.value * 100)}%` }"></div>
          </div>
        </div>
      </div>

      <div class="relationship-note">
        <span>{{ moodLabel }}</span>
        <span>{{ phaseLabel }}</span>
        <p>{{ relationshipHint }}</p>
      </div>
    </aside>

    <section class="conversation">
      <header class="conversation-header">
        <div>
          <div class="header-kicker">正在聊天</div>
          <h1>{{ character.name }}</h1>
        </div>
        <div class="header-actions">
          <button
            v-if="messages.length > 0"
            class="tool-button"
            :disabled="loading"
            @click="onClearHistory"
          >清空记录</button>
        </div>
      </header>

      <div class="chat-body" ref="chatBody">
        <div v-if="messages.length === 0" class="empty-state">
          <div class="empty-title">对话还没有开始</div>
          <div class="empty-copy">{{ emptyCopy }}</div>
        </div>

        <div
          v-for="(msg, i) in messages"
          :key="i"
          :class="[
            'message',
            msg.role === 'user' ? 'message-user' : 'message-assistant',
            i > 0 && messages[i - 1].role === msg.role ? 'message-consecutive' : ''
          ]"
        >
          <div v-if="!(i > 0 && messages[i - 1].role === msg.role)" class="message-label">
            {{ msg.role === 'user' ? '你' : character.name }}
          </div>
          <div class="message-bubble">{{ msg.content }}</div>
        </div>

        <div v-if="loading && !streaming" class="message message-assistant">
          <div class="message-label">{{ character.name }}</div>
          <div class="message-bubble typing">正在想怎么回你...</div>
        </div>
      </div>

      <div v-if="error" class="chat-error">{{ error }}</div>

      <footer class="composer">
        <textarea
          v-model="inputText"
          @keydown="handleKeydown"
          placeholder="输入消息，Enter 发送，Shift + Enter 换行"
          rows="1"
          :disabled="loading"
        ></textarea>
        <button @click="send" :disabled="loading || !inputText.trim()" class="btn-send">
          {{ loading ? '发送中' : '发送' }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.chat-shell {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  background: #eef1f4;
  overflow: hidden;
}

.companion-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 24px;
  background: #fff;
  border-right: 1px solid #dde3ec;
  overflow-y: auto;
}

.portrait {
  position: relative;
  width: 148px;
  aspect-ratio: 1;
  margin: 4px auto 0;
  display: grid;
  place-items: center;
}

.portrait-glow {
  position: absolute;
  inset: 0;
  border-radius: 28px;
  background:
    radial-gradient(circle at 28% 24%, rgba(255, 116, 150, 0.32), transparent 34%),
    radial-gradient(circle at 78% 68%, rgba(92, 111, 255, 0.26), transparent 38%),
    linear-gradient(135deg, #fff7fb, #edf4ff);
  border: 1px solid rgba(170, 183, 205, 0.55);
}

.portrait-initial {
  position: relative;
  width: 84px;
  aspect-ratio: 1;
  border-radius: 24px;
  display: grid;
  place-items: center;
  background: #172033;
  color: #fff;
  font-size: 2rem;
  font-weight: 800;
  box-shadow: 0 18px 32px rgba(23, 32, 51, 0.22);
}

.identity-block {
  text-align: center;
}

.identity-kicker,
.header-kicker {
  font-size: 0.75rem;
  color: #7c8798;
}

.identity-block h2,
.conversation-header h1 {
  margin: 4px 0 0;
  color: #172033;
  font-size: 1.35rem;
  letter-spacing: 0;
}

.identity-block p {
  margin: 8px 0 0;
  color: #667085;
  font-size: 0.9rem;
  line-height: 1.5;
}

.state-list {
  display: grid;
  gap: 14px;
}

.state-row {
  min-width: 0;
}

.state-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
  color: #344054;
  font-size: 0.82rem;
}

.state-meta strong {
  font-size: 0.82rem;
  color: #172033;
}

.state-track {
  height: 8px;
  border-radius: 999px;
  background: #e8edf3;
  overflow: hidden;
}

.state-fill {
  height: 100%;
  border-radius: inherit;
  transition: width 0.25s ease;
}

.tone-rose { background: #e95f80; }
.tone-blue { background: #4b7bec; }
.tone-violet { background: #7c5cff; }
.tone-green { background: #35a66f; }
.tone-amber { background: #d99328; }
.tone-red { background: #d14343; }
.tone-slate { background: #64748b; }

.relationship-note {
  border: 1px solid #e3e8ef;
  border-radius: 8px;
  padding: 14px;
  background: #f8fafc;
}

.relationship-note span {
  display: inline-flex;
  margin: 0 6px 8px 0;
  padding: 3px 9px;
  border-radius: 999px;
  background: #fff;
  color: #344054;
  border: 1px solid #e3e8ef;
  font-size: 0.76rem;
}

.relationship-note p {
  margin: 0;
  color: #667085;
  line-height: 1.5;
  font-size: 0.84rem;
}

.conversation {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.88), rgba(244, 247, 251, 0.96)),
    #f5f7fa;
}

.conversation-header {
  min-height: 72px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 22px;
  background: rgba(255, 255, 255, 0.92);
  border-bottom: 1px solid #dde3ec;
  flex-shrink: 0;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.tool-button {
  height: 34px;
  padding: 0 13px;
  border: 1px solid #d4dbe7;
  border-radius: 8px;
  background: #fff;
  color: #667085;
  cursor: pointer;
  font-size: 0.82rem;
}

.tool-button:hover {
  color: #d92d20;
  border-color: #f1a6a0;
}

.tool-button:disabled {
  color: #98a2b3;
  border-color: #d4dbe7;
  cursor: not-allowed;
  background: #f8fafc;
}

.chat-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.empty-state {
  align-self: center;
  margin-top: 20vh;
  max-width: 420px;
  text-align: center;
  color: #667085;
}

.empty-title {
  color: #172033;
  font-weight: 700;
  font-size: 1rem;
  margin-bottom: 8px;
}

.empty-copy {
  line-height: 1.6;
  font-size: 0.92rem;
}

.message {
  max-width: min(620px, 76%);
}

.message-consecutive {
  margin-top: -6px;
}

.message-user {
  align-self: flex-end;
}

.message-assistant {
  align-self: flex-start;
}

.message-label {
  font-size: 0.75rem;
  color: #8b95a5;
  margin-bottom: 5px;
  padding: 0 4px;
}

.message-user .message-label {
  text-align: right;
}

.message-bubble {
  padding: 11px 14px;
  border-radius: 14px;
  font-size: 0.96rem;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  border: 1px solid transparent;
}

.message-user .message-bubble {
  background: #25324a;
  color: #fff;
  border-bottom-right-radius: 5px;
}

.message-assistant .message-bubble {
  background: #fff;
  color: #1d2939;
  border-color: #e3e8ef;
  border-bottom-left-radius: 5px;
  box-shadow: 0 8px 20px rgba(16, 24, 40, 0.06);
}

.typing {
  color: #8b95a5;
}

.chat-error {
  margin: 0 24px 12px;
  padding: 9px 12px;
  border-radius: 8px;
  background: #fff1f0;
  color: #b42318;
  border: 1px solid #ffd3cc;
  font-size: 0.86rem;
  flex-shrink: 0;
}

.composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 86px;
  gap: 10px;
  padding: 14px 18px 16px;
  background: rgba(255, 255, 255, 0.96);
  border-top: 1px solid #dde3ec;
  flex-shrink: 0;
}

.composer textarea {
  width: 100%;
  min-height: 42px;
  max-height: 108px;
  padding: 11px 13px;
  border: 1px solid #d4dbe7;
  border-radius: 8px;
  resize: none;
  color: #172033;
  font-size: 0.95rem;
  line-height: 1.45;
  font-family: inherit;
  box-sizing: border-box;
  background: #fff;
}

.composer textarea:focus {
  outline: none;
  border-color: #7c8db5;
  box-shadow: 0 0 0 3px rgba(124, 141, 181, 0.16);
}

.btn-send {
  height: 42px;
  border: none;
  border-radius: 8px;
  background: #7c5cff;
  color: #fff;
  font-size: 0.95rem;
  font-weight: 700;
  cursor: pointer;
}

.btn-send:hover:not(:disabled) {
  background: #6848ee;
}

.btn-send:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

@media (max-width: 860px) {
  .chat-shell {
    grid-template-columns: 1fr;
  }

  .companion-panel {
    display: none;
  }

  .conversation-header {
    min-height: 64px;
  }

  .message {
    max-width: 88%;
  }
}
</style>
