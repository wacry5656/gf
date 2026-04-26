<script setup lang="ts">
import { computed, onMounted, ref, nextTick, watch } from 'vue'
import type { Character, ChatMessage, CharacterInsights, RelationshipState } from '../api'
import { sendMessage, saveMessage, clearMessages, getCharacterState, getCharacterInsights } from '../api'

const props = defineProps<{
  character: Character
  messages: ChatMessage[]
}>()

const emit = defineEmits<{
  'update:messages': [messages: ChatMessage[]]
}>()

const inputText = ref('')
const loading = ref(false)
const error = ref('')
const chatBody = ref<HTMLElement | null>(null)
const relationshipState = ref<RelationshipState | null>(null)
const insights = ref<CharacterInsights | null>(null)
const showInsights = ref(true)

const avatarText = computed(() => props.character.name.trim().slice(0, 1) || '她')
const inputHint = computed(() => `${inputText.value.trim().length} 字`)
const moodLabel = computed(() => {
  const mood = relationshipState.value?.mood || 'steady'
  const map: Record<string, string> = {
    steady: '平稳',
    soft: '心软',
    warm: '亲近',
    concerned: '担心',
    clingy: '黏人',
    guarded: '有脾气',
    angry: '生气',
  }
  return map[mood] || mood
})

const stateItems = computed(() => {
  const state = relationshipState.value
  if (!state) return []
  return [
    { label: '好感', value: state.affection, className: 'tone-affection' },
    { label: '信任', value: state.trust, className: 'tone-trust' },
    { label: '依恋', value: state.attachment, className: 'tone-attachment' },
    { label: '脾气', value: state.tension, className: 'tone-tension' },
  ]
})

function scrollToBottom() {
  nextTick(() => {
    if (chatBody.value) {
      chatBody.value.scrollTop = chatBody.value.scrollHeight
    }
  })
}

watch(() => props.messages.length, scrollToBottom)
watch(() => props.character.id, () => {
  relationshipState.value = null
  insights.value = null
  loadMeta()
}, { immediate: true })

onMounted(loadMeta)

async function loadMeta() {
  if (!props.character.id) return
  const characterId = props.character.id
  const [stateResult, insightsResult] = await Promise.allSettled([
    getCharacterState(characterId),
    getCharacterInsights(characterId),
  ])
  relationshipState.value = stateResult.status === 'fulfilled' ? stateResult.value : null
  insights.value = insightsResult.status === 'fulfilled' ? insightsResult.value : null
}

async function send() {
  const text = inputText.value.trim()
  if (!text || loading.value) return

  error.value = ''
  const userMsg: ChatMessage = { role: 'user', content: text }
  const updated = [...props.messages, userMsg]
  emit('update:messages', updated)
  inputText.value = ''
  loading.value = true

  // 保存用户消息到数据库
  if (props.character.id) {
    saveMessage(props.character.id, 'user', text).catch(() => {})
  }

  try {
    const replies = await sendMessage(props.character, updated)
    let current = [...updated]
    for (const reply of replies) {
      const assistantMsg: ChatMessage = { role: 'assistant', content: reply }
      current = [...current, assistantMsg]
    }
    emit('update:messages', current)

    // 保存每条 AI 回复到数据库
    if (props.character.id) {
      for (const reply of replies) {
        saveMessage(props.character.id, 'assistant', reply).catch(() => {})
      }
      loadMeta()
    }
  } catch (e: any) {
    error.value = e.message || '发送失败'
  } finally {
    loading.value = false
  }
}

async function onClearHistory() {
  if (!props.character.id) return
  try {
    await clearMessages(props.character.id)
    emit('update:messages', [])
  } catch {
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
  <div class="chat-container">
    <div class="chat-topbar">
      <div class="profile-block">
        <div class="profile-avatar">{{ avatarText }}</div>
        <div class="profile-main">
          <div class="profile-line">
            <strong>{{ character.name }}</strong>
            <span class="mood-pill">{{ moodLabel }}</span>
          </div>
          <div class="profile-personality">{{ character.personality }}</div>
        </div>
      </div>

      <div class="state-grid" v-if="stateItems.length">
        <div v-for="item in stateItems" :key="item.label" class="state-item">
          <span>{{ item.label }}</span>
          <div class="state-track">
            <i :class="item.className" :style="{ width: `${item.value}%` }"></i>
          </div>
          <b>{{ item.value }}</b>
        </div>
      </div>

      <div class="top-actions">
        <button class="btn-clear" @click="showInsights = !showInsights">
          {{ showInsights ? '收起记忆' : '记忆' }}
        </button>
        <button v-if="messages.length > 0" class="btn-clear" @click="onClearHistory">清空</button>
      </div>
    </div>

    <div class="chat-main" :class="{ 'with-insights': showInsights }">
      <div class="chat-body" ref="chatBody">
        <div v-if="messages.length === 0" class="chat-empty">
          <div class="empty-avatar">{{ avatarText }}</div>
          <strong>和 {{ character.name }} 开始聊天</strong>
          <span>她默认把自己当作你的对象，也会慢慢形成更多印象。</span>
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

        <div v-if="loading" class="message message-assistant">
          <div class="message-label">{{ character.name }}</div>
          <div class="message-bubble typing">思考中...</div>
        </div>
      </div>

      <aside v-if="showInsights" class="insights-panel">
        <div class="insight-head">
          <strong>记忆面板</strong>
          <span>{{ insights?.memoryCount || 0 }} 条</span>
        </div>

        <section v-if="insights?.summary" class="insight-section">
          <h3>画像摘要</h3>
          <p>{{ insights.summary }}</p>
        </section>

        <section v-if="insights?.activePlans?.length" class="insight-section">
          <h3>未完成计划</h3>
          <ul>
            <li v-for="item in insights.activePlans" :key="item">{{ item }}</li>
          </ul>
        </section>

        <section v-if="insights?.recentStates?.length" class="insight-section">
          <h3>近期状态</h3>
          <ul>
            <li v-for="item in insights.recentStates" :key="item">{{ item }}</li>
          </ul>
        </section>

        <section v-if="insights?.coreMemories?.length" class="insight-section">
          <h3>核心记忆</h3>
          <ul>
            <li v-for="item in insights.coreMemories" :key="item">{{ item }}</li>
          </ul>
        </section>

        <div v-if="!insights || insights.memoryCount === 0" class="insight-empty">
          还没有形成长期记忆
        </div>
      </aside>
    </div>

    <div v-if="error" class="chat-error">{{ error }}</div>

    <div class="composer">
      <textarea
        v-model="inputText"
        @keydown="handleKeydown"
        placeholder="说点什么，Enter 发送，Shift + Enter 换行"
        rows="2"
        maxlength="1200"
        :disabled="loading"
      ></textarea>
      <div class="composer-actions">
        <span>{{ inputHint }}</span>
        <button @click="send" :disabled="loading || !inputText.trim()" class="btn-send">
          {{ loading ? '生成中' : '发送' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #eef1f4;
  overflow: hidden;
}

.chat-topbar {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(260px, 420px) auto;
  align-items: center;
  gap: 16px;
  padding: 14px 18px;
  background: rgba(255, 255, 255, 0.94);
  border-bottom: 1px solid #dfe4ea;
  flex-shrink: 0;
}

.profile-block {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.profile-avatar,
.empty-avatar {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  background: #25324a;
  color: #fff;
  font-weight: 700;
}

.profile-main {
  min-width: 0;
}

.profile-line {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #172033;
}

.mood-pill {
  padding: 2px 8px;
  border-radius: 999px;
  background: #edf3ff;
  color: #365f9d;
  font-size: 0.72rem;
  font-weight: 700;
}

.profile-personality {
  margin-top: 2px;
  color: #667085;
  font-size: 0.78rem;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.state-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(110px, 1fr));
  gap: 8px 12px;
}

.state-item {
  display: grid;
  grid-template-columns: 34px 1fr 24px;
  align-items: center;
  gap: 6px;
  color: #667085;
  font-size: 0.72rem;
}

.state-track {
  height: 5px;
  border-radius: 999px;
  background: #e5e7eb;
  overflow: hidden;
}

.state-track i {
  display: block;
  height: 100%;
  border-radius: inherit;
  transition: width 220ms ease;
}

.tone-affection { background: #e85d75; }
.tone-trust { background: #2f80ed; }
.tone-attachment { background: #8b5cf6; }
.tone-tension { background: #f59e0b; }

.state-item b {
  color: #344054;
  font-size: 0.7rem;
  text-align: right;
}

.top-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.btn-clear {
  background: #fff;
  border: 1px solid #d0d5dd;
  color: #667085;
  padding: 7px 12px;
  border-radius: 8px;
  font-size: 0.78rem;
  cursor: pointer;
}

.btn-clear:hover {
  color: #e53935;
  border-color: #e53935;
}

.chat-main {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr;
}

.chat-main.with-insights {
  grid-template-columns: minmax(0, 1fr) 280px;
}

.chat-body {
  min-height: 0;
  overflow-y: auto;
  padding: 22px 24px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.insights-panel {
  min-height: 0;
  overflow-y: auto;
  padding: 18px 16px;
  background: #f8fafc;
  border-left: 1px solid #dfe4ea;
}

.insight-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #172033;
  font-size: 0.9rem;
  margin-bottom: 14px;
}

.insight-head span {
  color: #667085;
  font-size: 0.75rem;
}

.insight-section {
  padding: 12px 0;
  border-top: 1px solid #e4e7ec;
}

.insight-section h3 {
  margin: 0 0 8px;
  color: #344054;
  font-size: 0.76rem;
}

.insight-section p,
.insight-section li,
.insight-empty {
  color: #667085;
  font-size: 0.78rem;
  line-height: 1.55;
}

.insight-section ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 7px;
}

.insight-section li {
  padding: 7px 8px;
  background: #fff;
  border: 1px solid #e4e7ec;
  border-radius: 8px;
}

.insight-empty {
  padding-top: 14px;
  border-top: 1px solid #e4e7ec;
}

.chat-empty {
  margin: auto;
  min-width: min(320px, 90%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: #667085;
  text-align: center;
}

.chat-empty strong {
  color: #172033;
  font-size: 1rem;
}

.chat-empty span {
  font-size: 0.86rem;
}

.message {
  max-width: min(72%, 560px);
}

.message-consecutive {
  margin-top: -8px;
}

.message-user {
  align-self: flex-end;
}

.message-assistant {
  align-self: flex-start;
}

.message-label {
  font-size: 0.75rem;
  color: #667085;
  margin-bottom: 4px;
  padding: 0 4px;
}

.message-user .message-label {
  text-align: right;
}

.message-bubble {
  padding: 10px 13px;
  border-radius: 14px;
  font-size: 0.95rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.message-user .message-bubble {
  background: #25324a;
  color: #fff;
  border-bottom-right-radius: 5px;
}

.message-assistant .message-bubble {
  background: #fff;
  color: #172033;
  border: 1px solid #e4e7ec;
  border-bottom-left-radius: 5px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
}

.typing {
  color: #999;
  animation: blink 1s infinite;
}

@keyframes blink {
  50% { opacity: 0.5; }
}

.chat-error {
  padding: 8px 20px;
  background: #fff0f0;
  color: #d32f2f;
  font-size: 0.85rem;
  flex-shrink: 0;
}

.composer {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 12px;
  padding: 14px 18px;
  background: #fff;
  border-top: 1px solid #dfe4ea;
  flex-shrink: 0;
}

.composer textarea {
  width: 100%;
  padding: 11px 13px;
  border: 1px solid #d0d5dd;
  border-radius: 10px;
  font-size: 0.95rem;
  resize: none;
  font-family: inherit;
  min-height: 52px;
  max-height: 120px;
  color: #172033;
  background: #f9fafb;
}

.composer textarea:focus {
  outline: none;
  border-color: #25324a;
  background: #fff;
}

.composer-actions {
  min-width: 82px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: space-between;
  gap: 8px;
  color: #98a2b3;
  font-size: 0.72rem;
}

.btn-send {
  padding: 10px 16px;
  background: #25324a;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.btn-send:hover:not(:disabled) {
  background: #344563;
}

.btn-send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 720px) {
  .chat-topbar {
    grid-template-columns: 1fr auto;
  }

  .state-grid {
    grid-column: 1 / -1;
  }

  .top-actions {
    grid-column: 2;
    grid-row: 1;
  }

  .chat-main.with-insights {
    grid-template-columns: 1fr;
  }

  .insights-panel {
    display: none;
  }

  .message {
    max-width: 86%;
  }

  .composer {
    grid-template-columns: 1fr;
  }

  .composer-actions {
    flex-direction: row;
    align-items: center;
  }
}
</style>
