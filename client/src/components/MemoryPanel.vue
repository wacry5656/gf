<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import type { MemoryItem, SummaryInfo, PersonalityTraitItem, DiaryEntry, ReminderItem, ChatStats } from '../api'
import { getMemories, deleteMemory, getSummaryInfo, getPersonalityTraitsList, getDiaryEntries, getReminders, deleteReminder, getChatStats } from '../api'

const props = defineProps<{
  characterId: number
  userId: number
  characterName: string
}>()

const memories = ref<MemoryItem[]>([])
const summaryInfo = ref<SummaryInfo | null>(null)
const traits = ref<PersonalityTraitItem[]>([])
const diaryEntries = ref<DiaryEntry[]>([])
const reminders = ref<ReminderItem[]>([])
const stats = ref<ChatStats | null>(null)
const loading = ref(false)
const error = ref('')
const deletingId = ref<number | null>(null)
const activeTab = ref<'summary' | 'diary' | 'memories' | 'stats'>('summary')

const memoryTypeLabel: Record<string, string> = {
  fact: '事实', state: '状态', preference: '偏好', plan: '计划', relationship: '关系', other: '其他',
}
const memoryTypeColor: Record<string, string> = {
  fact: '#3b82f6', state: '#f59e0b', preference: '#10b981', plan: '#8b5cf6', relationship: '#ec4899', other: '#6b7280',
}

const hasContent = computed(() => {
  return summaryInfo.value?.summary || traits.value.length > 0 || memories.value.length > 0
    || diaryEntries.value.length > 0 || stats.value
})

const weekLabels = ['日', '一', '二', '三', '四', '五', '六']

async function loadData() {
  if (!props.characterId || !props.userId) return
  loading.value = true
  error.value = ''
  try {
    const [memoriesResult, summaryResult, traitsResult, diaryResult, remindersResult, statsResult] = await Promise.allSettled([
      getMemories(props.characterId, props.userId),
      getSummaryInfo(props.characterId, props.userId),
      getPersonalityTraitsList(props.characterId, props.userId),
      getDiaryEntries(props.characterId, props.userId),
      getReminders(props.characterId, props.userId),
      getChatStats(props.characterId, props.userId),
    ])

    if (memoriesResult.status === 'fulfilled') memories.value = memoriesResult.value
    if (summaryResult.status === 'fulfilled') summaryInfo.value = summaryResult.value
    if (traitsResult.status === 'fulfilled') traits.value = traitsResult.value
    if (diaryResult.status === 'fulfilled') diaryEntries.value = diaryResult.value
    if (remindersResult.status === 'fulfilled') reminders.value = remindersResult.value
    if (statsResult.status === 'fulfilled') stats.value = statsResult.value
  } catch (e: any) {
    error.value = e?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function onDeleteMemory(memoryId: number) {
  if (!window.confirm('确定删除这条记忆吗？')) return
  deletingId.value = memoryId
  try {
    await deleteMemory(memoryId, props.userId)
    memories.value = memories.value.filter(m => m.id !== memoryId)
    if (summaryInfo.value) summaryInfo.value.memoryCount = Math.max(0, summaryInfo.value.memoryCount - 1)
  } catch (e: any) {
    alert(e?.message || '删除失败')
  } finally {
    deletingId.value = null
  }
}

async function onDeleteReminder(reminderId: number) {
  if (!window.confirm('确定删除这个提醒吗？')) return
  try {
    await deleteReminder(reminderId, props.userId)
    reminders.value = reminders.value.filter(r => r.id !== reminderId)
  } catch (e: any) {
    alert(e?.message || '删除失败')
  }
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const diff = Math.floor((now.getTime() - d.getTime()) / 86400000)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  if (diff < 7) return `${diff}天前`
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function getBarColor(value: number): string {
  if (value >= 80) return '#10b981'
  if (value >= 50) return '#3b82f6'
  if (value >= 30) return '#f59e0b'
  return '#ef4444'
}

onMounted(loadData)
</script>

<template>
  <div class="memory-panel">
    <div class="memory-panel-header">
      <h3>关于你</h3>
      <p class="memory-subtitle">{{ characterName }} 记得这些</p>
    </div>

    <div class="memory-tabs">
      <button class="memory-tab" :class="{ active: activeTab === 'summary' }" @click="activeTab = 'summary'">画像</button>
      <button class="memory-tab" :class="{ active: activeTab === 'diary' }" @click="activeTab = 'diary'">日记</button>
      <button class="memory-tab" :class="{ active: activeTab === 'memories' }" @click="activeTab = 'memories'">记忆</button>
      <button class="memory-tab" :class="{ active: activeTab === 'stats' }" @click="activeTab = 'stats'">统计</button>
    </div>

    <div v-if="loading" class="memory-loading">加载中...</div>
    <div v-else-if="error" class="memory-error">{{ error }}</div>
    <div v-else-if="!hasContent" class="memory-empty">
      <div class="memory-empty-icon">📝</div>
      <p>还没有足够的记忆</p>
      <p class="memory-empty-hint">多和 {{ characterName }} 聊聊天吧</p>
    </div>

    <div v-else class="memory-content">
      <!-- 画像 -->
      <div v-if="activeTab === 'summary'" class="tab-content">
        <div v-if="summaryInfo?.summary" class="summary-section">
          <div class="section-label">整体印象</div>
          <div class="summary-text">{{ summaryInfo.summary }}</div>
        </div>

        <div v-if="traits.length > 0" class="traits-section">
          <div class="section-label">人格特征</div>
          <div class="traits-list">
            <div v-for="trait in traits" :key="trait.key + trait.value" class="trait-tag" :title="`置信度: ${Math.round(trait.confidence * 100)}%`">
              {{ trait.value }}
            </div>
          </div>
        </div>

        <div v-if="reminders.length > 0" class="reminders-section">
          <div class="section-label">待提醒</div>
          <div class="reminders-list">
            <div v-for="r in reminders" :key="r.id" class="reminder-row">
              <span class="reminder-dot"></span>
              <span class="reminder-title">{{ r.title }}</span>
              <span class="reminder-date">{{ r.remind_at }}</span>
              <button class="btn-delete-reminder" @click="onDeleteReminder(r.id)">✕</button>
            </div>
          </div>
        </div>

        <div class="stats-grid">
          <div class="stat-card">
            <span class="stat-value">{{ summaryInfo?.memoryCount || memories.length }}</span>
            <span class="stat-label">条记忆</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">{{ diaryEntries.length }}</span>
            <span class="stat-label">篇日记</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">{{ reminders.length }}</span>
            <span class="stat-label">个提醒</span>
          </div>
        </div>
      </div>

      <!-- 日记 -->
      <div v-if="activeTab === 'diary'" class="tab-content">
        <div v-if="diaryEntries.length === 0" class="memory-empty">
          <p>还没有日记</p>
          <p class="memory-empty-hint">聊得越多，日记越丰富</p>
        </div>
        <div v-else class="diary-list">
          <div v-for="entry in diaryEntries" :key="entry.entry_date" class="diary-card">
            <div class="diary-date">{{ formatDate(entry.entry_date) }}</div>
            <div class="diary-text">{{ entry.content }}</div>
          </div>
        </div>
      </div>

      <!-- 记忆 -->
      <div v-if="activeTab === 'memories'" class="tab-content">
        <div v-if="memories.length === 0" class="memory-empty"><p>还没有记忆</p></div>
        <div v-else class="memories-list">
          <div v-for="memory in memories" :key="memory.id" class="memory-card">
            <div class="memory-card-header">
              <span class="memory-type-badge" :style="{ background: memoryTypeColor[memory.memory_type] + '15', color: memoryTypeColor[memory.memory_type] }">
                {{ memoryTypeLabel[memory.memory_type] || '其他' }}
              </span>
              <span class="memory-importance" v-if="memory.importance >= 4">★</span>
              <button class="btn-delete-memory" :disabled="deletingId === memory.id" @click="onDeleteMemory(memory.id)" title="删除">{{ deletingId === memory.id ? '...' : '✕' }}</button>
            </div>
            <div class="memory-text">{{ memory.text }}</div>
            <div class="memory-meta">
              <span>命中 {{ memory.hit_count }} 次</span>
              <span>{{ new Date(memory.created_at).toLocaleDateString() }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 统计 -->
      <div v-if="activeTab === 'stats'" class="tab-content">
        <div v-if="!stats" class="memory-empty"><p>还没有数据</p></div>
        <div v-else class="stats-content">
          <div class="stats-numbers">
            <div class="stat-big">
              <span class="stat-big-value">{{ stats.totalMessages }}</span>
              <span class="stat-big-label">总消息</span>
            </div>
            <div class="stat-big">
              <span class="stat-big-value">{{ stats.todayMessages }}</span>
              <span class="stat-big-label">今日</span>
            </div>
            <div class="stat-big">
              <span class="stat-big-value">{{ stats.avgReplyLength }}</span>
              <span class="stat-big-label">平均字/句</span>
            </div>
          </div>

          <div v-if="stats.weeklyActivity.length > 0" class="chart-section">
            <div class="section-label">最近7天</div>
            <div class="week-chart">
              <div v-for="day in stats.weeklyActivity" :key="day.day" class="week-bar-wrap">
                <div class="week-bar" :style="{ height: `${Math.min(100, day.count * 3)}px`, background: getBarColor(day.count) }"></div>
                <span class="week-day">{{ weekLabels[new Date(day.day).getDay()] }}</span>
              </div>
            </div>
          </div>

          <div v-if="stats.topWords.length > 0" class="words-section">
            <div class="section-label">常说的话</div>
            <div class="words-cloud">
              <span v-for="w in stats.topWords" :key="w.word" class="word-tag" :style="{ fontSize: `${0.75 + w.count * 0.05}rem`, opacity: 0.5 + Math.min(0.5, w.count * 0.05) }">
                {{ w.word }}
              </span>
            </div>
          </div>

          <div v-if="stats.firstChatDate" class="first-chat">
            第一次聊天：{{ new Date(stats.firstChatDate).toLocaleDateString() }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.memory-panel { padding: 20px; height: 100%; overflow-y: auto; background: var(--panel-bg, #fff); }
.memory-panel-header { margin-bottom: 16px; }
.memory-panel-header h3 { margin: 0; font-size: 1.1rem; color: var(--text-primary, #111827); }
.memory-subtitle { margin: 4px 0 0; font-size: 0.82rem; color: #9ca3af; }

.memory-tabs { display: flex; gap: 6px; margin-bottom: 16px; border-bottom: 1px solid #f0f2f5; padding-bottom: 8px; overflow-x: auto; }
.memory-tab { padding: 6px 12px; border: none; background: none; color: #9ca3af; font-size: 0.82rem; cursor: pointer; border-radius: 8px; transition: all 0.15s; font-family: inherit; white-space: nowrap; }
.memory-tab:hover { background: #f3f4f6; color: var(--text-primary, #374151); }
.memory-tab.active { background: #ede9fe; color: #6b21a8; font-weight: 600; }

.memory-loading, .memory-error, .memory-empty { text-align: center; padding: 40px 20px; color: #9ca3af; }
.memory-empty-icon { font-size: 2.5rem; margin-bottom: 12px; }
.memory-empty-hint { font-size: 0.82rem; margin-top: 4px; }
.memory-error { color: #b91c1c; background: #fef2f2; border-radius: 10px; }

.tab-content { display: flex; flex-direction: column; gap: 14px; }

.section-label { font-size: 0.72rem; font-weight: 600; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }

.summary-section, .traits-section, .reminders-section { background: var(--app-bg, #f9fafb); padding: 12px; border-radius: 12px; }
.summary-text { font-size: 0.88rem; color: var(--text-primary, #374151); line-height: 1.6; }
.traits-list { display: flex; flex-wrap: wrap; gap: 8px; }
.trait-tag { padding: 4px 12px; border-radius: 999px; background: linear-gradient(135deg, #ede9fe, #fce7f3); color: #6b21a8; font-size: 0.82rem; }

.reminders-list { display: flex; flex-direction: column; gap: 8px; }
.reminder-row { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; color: #374151; }
.reminder-dot { width: 6px; height: 6px; border-radius: 50%; background: #f59e0b; flex-shrink: 0; }
.reminder-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reminder-date { font-size: 0.75rem; color: #9ca3af; flex-shrink: 0; }
.btn-delete-reminder { background: none; border: none; color: #d1d5db; font-size: 0.8rem; cursor: pointer; padding: 2px 6px; }
.btn-delete-reminder:hover { color: #ef4444; }

.stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.stat-card { background: var(--app-bg, #f9fafb); padding: 14px; border-radius: 12px; text-align: center; }
.stat-value { display: block; font-size: 1.4rem; font-weight: 700; color: var(--text-primary, #111827); }
.stat-label { font-size: 0.75rem; color: #9ca3af; }

.diary-list { display: flex; flex-direction: column; gap: 10px; }
.diary-card { background: var(--app-bg, #f9fafb); padding: 14px; border-radius: 12px; }
.diary-date { font-size: 0.75rem; font-weight: 600; color: #6b21a8; margin-bottom: 6px; }
.diary-text { font-size: 0.88rem; color: var(--text-primary, #374151); line-height: 1.6; font-style: italic; }

.memories-list { display: flex; flex-direction: column; gap: 10px; }
.memory-card { background: var(--app-bg, #f9fafb); padding: 12px; border-radius: 12px; }
.memory-card:hover { background: #f3f4f6; }
.memory-card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.memory-type-badge { font-size: 0.72rem; padding: 2px 8px; border-radius: 999px; font-weight: 500; }
.memory-importance { color: #f59e0b; font-size: 0.85rem; }
.btn-delete-memory { margin-left: auto; background: none; border: none; color: #d1d5db; font-size: 0.8rem; cursor: pointer; padding: 2px 6px; border-radius: 4px; }
.btn-delete-memory:hover { color: #ef4444; background: #fef2f2; }
.memory-text { font-size: 0.88rem; color: var(--text-primary, #374151); line-height: 1.5; margin-bottom: 8px; }
.memory-meta { display: flex; gap: 12px; font-size: 0.75rem; color: #9ca3af; }

.stats-content { display: flex; flex-direction: column; gap: 16px; }
.stats-numbers { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.stat-big { background: var(--app-bg, #f9fafb); padding: 16px; border-radius: 12px; text-align: center; }
.stat-big-value { display: block; font-size: 1.6rem; font-weight: 700; color: var(--text-primary, #111827); }
.stat-big-label { font-size: 0.78rem; color: #9ca3af; }

.chart-section { background: var(--app-bg, #f9fafb); padding: 14px; border-radius: 12px; }
.week-chart { display: flex; align-items: flex-end; justify-content: space-around; gap: 8px; height: 100px; padding-top: 10px; }
.week-bar-wrap { display: flex; flex-direction: column; align-items: center; gap: 4px; flex: 1; }
.week-bar { width: 100%; max-width: 24px; min-height: 4px; border-radius: 4px; transition: height 0.4s ease; }
.week-day { font-size: 0.72rem; color: #9ca3af; }

.words-section { background: var(--app-bg, #f9fafb); padding: 14px; border-radius: 12px; }
.words-cloud { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.word-tag { padding: 3px 10px; border-radius: 999px; background: #ede9fe; color: #6b21a8; }

.first-chat { text-align: center; font-size: 0.82rem; color: #9ca3af; padding: 8px; }
</style>
