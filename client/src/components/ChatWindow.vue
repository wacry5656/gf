<script setup lang="ts">
import { ref, nextTick, watch } from 'vue'
import type { Character, ChatMessage } from '../api'
import { sendMessageStream, saveMessage, clearMessages } from '../api'

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

function scrollToBottom() {
  nextTick(() => {
    if (chatBody.value) {
      chatBody.value.scrollTop = chatBody.value.scrollHeight
    }
  })
}

watch(() => props.messages.length, scrollToBottom)

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

  // 创建 AI 占位消息用于流式更新
  const aiPlaceholder: ChatMessage = { role: 'assistant', content: '' }
  const withPlaceholder = [...updated, aiPlaceholder]
  emit('update:messages', withPlaceholder)
  scrollToBottom()

  let fullReply = ''

  await sendMessageStream(
    props.character,
    updated,
    // onChunk
    (chunk: string) => {
      fullReply += chunk
      // 更新占位消息内容
      const current = [...props.messages]
      const lastMsg = current[current.length - 1]
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.content = fullReply
        emit('update:messages', [...current])
        scrollToBottom()
      }
    },
    // onDone
    () => {
      loading.value = false
      if (!fullReply) {
        // 如果没有收到任何内容，移除占位消息
        const current = [...props.messages]
        if (current.length > 0 && current[current.length - 1].role === 'assistant' && current[current.length - 1].content === '') {
          current.pop()
          emit('update:messages', current)
        }
        return
      }
      // 保存完整 AI 回复到数据库
      if (props.character.id && fullReply) {
        saveMessage(props.character.id, 'assistant', fullReply).catch(() => {})
      }
    },
    // onError
    (errMsg: string) => {
      loading.value = false
      error.value = errMsg || '发送失败'
      // 移除空的占位消息
      const current = [...props.messages]
      if (current.length > 0 && current[current.length - 1].role === 'assistant' && current[current.length - 1].content === '') {
        current.pop()
        emit('update:messages', current)
      }
    }
  )
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
    <div class="chat-info">
      正在与「<strong>{{ character.name }}</strong>」聊天
      <span class="chat-personality">— {{ character.personality }}</span>
      <button v-if="messages.length > 0" class="btn-clear" @click="onClearHistory">清空记录</button>
    </div>

    <div class="chat-body" ref="chatBody">
      <div v-if="messages.length === 0" class="chat-empty">
        发送消息开始和「{{ character.name }}」聊天吧 ✨
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

      <div v-if="loading && (!messages.length || messages[messages.length - 1].role !== 'assistant' || messages[messages.length - 1].content !== '')" class="message message-assistant">
        <div class="message-label">{{ character.name }}</div>
        <div class="message-bubble typing">思考中...</div>
      </div>
    </div>

    <div v-if="error" class="chat-error">{{ error }}</div>

    <div class="chat-input-bar">
      <textarea
        v-model="inputText"
        @keydown="handleKeydown"
        placeholder="输入消息... (Enter 发送)"
        rows="1"
        :disabled="loading"
      ></textarea>
      <button @click="send" :disabled="loading || !inputText.trim()" class="btn-send">
        {{ loading ? '...' : '发送' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.chat-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #f0f2f5;
  overflow: hidden;
}

.chat-info {
  padding: 10px 20px;
  background: #fff;
  border-bottom: 1px solid #e8e8e8;
  font-size: 0.85rem;
  color: #555;
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.chat-personality {
  color: #999;
  flex: 1;
}

.btn-clear {
  background: none;
  border: 1px solid #ddd;
  color: #999;
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 0.75rem;
  cursor: pointer;
  margin-left: auto;
}

.btn-clear:hover {
  color: #e53935;
  border-color: #e53935;
}

.chat-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.chat-empty {
  text-align: center;
  color: #aaa;
  margin-top: 60px;
  font-size: 0.95rem;
}

.message {
  max-width: 75%;
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
  color: #888;
  margin-bottom: 4px;
  padding: 0 4px;
}

.message-user .message-label {
  text-align: right;
}

.message-bubble {
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 0.95rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.message-user .message-bubble {
  background: #6c63ff;
  color: #fff;
  border-bottom-right-radius: 4px;
}

.message-assistant .message-bubble {
  background: #fff;
  color: #333;
  border-bottom-left-radius: 4px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
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

.chat-input-bar {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  background: #fff;
  border-top: 1px solid #e8e8e8;
  flex-shrink: 0;
}

.chat-input-bar textarea {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid #ddd;
  border-radius: 8px;
  font-size: 0.95rem;
  resize: none;
  font-family: inherit;
  min-height: 40px;
  max-height: 100px;
  box-sizing: border-box;
}

.chat-input-bar textarea:focus {
  outline: none;
  border-color: #6c63ff;
}

.btn-send {
  padding: 10px 20px;
  background: #6c63ff;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.btn-send:hover:not(:disabled) {
  background: #5a52d9;
}

.btn-send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
