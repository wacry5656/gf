<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import type { MemoryItem, SummaryInfo, PersonalityTraitItem } from '../api'
import { getMemories, deleteMemory, getSummaryInfo, getPersonalityTraitsList } from '../api'

const props = defineProps<{
  characterId: number
  userId: number
  characterName: string
}>()

const memories = ref<MemoryItem[]>([])
const summaryInfo = ref<SummaryInfo | null>(null)
const traits = ref<PersonalityTraitItem[]>([])
const loading = ref(false)
const error = ref('')
const deletingId = ref<number | null>(null)
const activeTab = ref<'summary' | 'memories'>('summary')

const memoryTypeLabel: Record<string, string> = {
  fact: '事实',
  state: '状态',
  preference: '偏好',
  plan: '计划',
  relationship: '关系',
  other: '其他',
}

const memoryTypeColor: Record<string, string> = {
  fact: '#3b82f6',
  state: '#f59e0b',
  preference: '#10b981',
  plan: '#8b5cf6',
  relationship: '#ec4899',
  other: '#6b7280',
}

const hasContent = computed(() => {
  return summaryInfo.value?.summary || traits.value.length > 0 || memories.value.length > 0
})

async function loadData() {
  if (!props.characterId || !props.userId) return
  loading.value = true
  error.value = ''
  try {
    const [memoriesResult, summaryResult, traitsResult] = await Promise.allSettled([
      getMemories(props.characterId, props.userId),
      getSummaryInfo(props.characterId, props.userId),
      getPersonalityTraitsList(props.characterId, props.userId),
    ])

    if (memoriesResult.status === 'fulfilled') {
      memories.value = memoriesResult.value
    }
    if (summaryResult.status === 'fulfilled') {
      summaryInfo.value = summaryResult.value
    }
    if (traitsResult.status === 'fulfilled') {
      traits.value = traitsResult.value
    }
  } catch (e: any) {
    error.value = e?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function onDeleteMemory(memoryId: number) {
  if (!window.confirm('确定删除这条记忆吗？AI 将不再记得这件事。')) return
  deletingId.value = memoryId
  try {
    await deleteMemory(memoryId, props.userId)
    memories.value = memories.value.filter(m => m.id !== memoryId)
    if (summaryInfo.value) {
      summaryInfo.value.memoryCount = Math.max(0, summaryInfo.value.memoryCount - 1)
    }
  } catch (e: any) {
    alert(e?.message || '删除失败')
  } finally {
    deletingId.value = null
  }
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
      <button
        class="memory-tab"
        :class="{ active: activeTab === 'summary' }"
        @click="activeTab = 'summary'"
      >
        画像
      </button>
      <button
        class="memory-tab"
        :class="{ active: activeTab === 'memories' }"
        @click="activeTab = 'memories'"
      >
        记忆 ({{ memories.length }})
      </button>
    </div>

    <div v-if="loading" class="memory-loading">加载中...</div>
    <div v-else-if="error" class="memory-error">{{ error }}</div>
    <div v-else-if="!hasContent" class="memory-empty">
      <div class="memory-empty-icon">📝</div>
      <p>还没有足够的记忆</p>
      <p class="memory-empty-hint">多和 {{ characterName }} 聊聊天吧</p>
    </div>

    <div v-else class="memory-content">
      <!-- 画像页 -->
      <div v-if="activeTab === 'summary'" class="tab-content">
        <div v-if="summaryInfo?.summary" class="summary-section">
          <div class="section-label">整体印象</div>
          <div class="summary-text">{{ summaryInfo.summary }}</div>
        </div>

        <div v-if="traits.length > 0" class="traits-section">
          <div class="section-label">人格特征</div>
          <div class="traits-list">
            <div
              v-for="trait in traits"
              :key="trait.key + trait.value"
              class="trait-tag"
              :title="`置信度: ${Math.round(trait.confidence * 100)}%`"
            >
              {{ trait.value }}
            </div>
          </div>
        </div>

        <div class="stats-section">
          <div class="stat-item">
            <span class="stat-value">{{ summaryInfo?.memoryCount || memories.length }}</span>
            <span class="stat-label">条记忆</span>
          </div>
        </div>
      </div>

      <!-- 记忆页 -->
      <div v-if="activeTab === 'memories'" class="tab-content">
        <div v-if="memories.length === 0" class="memory-empty">
          <p>还没有记忆</p>
        </div>
        <div v-else class="memories-list">
          <div v-for="memory in memories" :key="memory.id" class="memory-card">
            <div class="memory-card-header">
              <span
                class="memory-type-badge"
                :style="{ background: memoryTypeColor[memory.memory_type] + '15', color: memoryTypeColor[memory.memory_type] }"
              >
                {{ memoryTypeLabel[memory.memory_type] || '其他' }}
              </span>
              <span class="memory-importance" v-if="memory.importance >= 4">★</span>
              <button
                class="btn-delete-memory"
                :disabled="deletingId === memory.id"
                @click="onDeleteMemory(memory.id)"
                title="删除这条记忆"
              >
                {{ deletingId === memory.id ? '...' : '✕' }}
              </button>
            </div>
            <div class="memory-text">{{ memory.text }}</div>
            <div class="memory-meta">
              <span>命中 {{ memory.hit_count }} 次</span>
              <span>{{ new Date(memory.created_at).toLocaleDateString() }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.memory-panel {
  padding: 20px;
  height: 100%;
  overflow-y: auto;
  background: #fff;
}

.memory-panel-header {
  margin-bottom: 16px;
}

.memory-panel-header h3 {
  margin: 0;
  font-size: 1.1rem;
  color: #111827;
}

.memory-subtitle {
  margin: 4px 0 0;
  font-size: 0.82rem;
  color: #9ca3af;
}

.memory-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  border-bottom: 1px solid #f0f2f5;
  padding-bottom: 8px;
}

.memory-tab {
  padding: 6px 14px;
  border: none;
  background: none;
  color: #9ca3af;
  font-size: 0.85rem;
  cursor: pointer;
  border-radius: 8px;
  transition: all 0.15s;
  font-family: inherit;
}

.memory-tab:hover {
  background: #f3f4f6;
  color: #374151;
}

.memory-tab.active {
  background: #ede9fe;
  color: #6b21a8;
  font-weight: 600;
}

.memory-loading,
.memory-error,
.memory-empty {
  text-align: center;
  padding: 40px 20px;
  color: #9ca3af;
}

.memory-empty-icon {
  font-size: 2.5rem;
  margin-bottom: 12px;
}

.memory-empty-hint {
  font-size: 0.82rem;
  margin-top: 4px;
}

.memory-error {
  color: #b91c1c;
  background: #fef2f2;
  border-radius: 10px;
}

.tab-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section-label {
  font-size: 0.78rem;
  font-weight: 600;
  color: #9ca3af;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 8px;
}

.summary-section {
  background: #f9fafb;
  padding: 14px;
  border-radius: 12px;
}

.summary-text {
  font-size: 0.88rem;
  color: #374151;
  line-height: 1.6;
}

.traits-section {
  background: #f9fafb;
  padding: 14px;
  border-radius: 12px;
}

.traits-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.trait-tag {
  padding: 4px 12px;
  border-radius: 999px;
  background: linear-gradient(135deg, #ede9fe, #fce7f3);
  color: #6b21a8;
  font-size: 0.82rem;
}

.stats-section {
  display: flex;
  gap: 16px;
}

.stat-item {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.stat-value {
  font-size: 1.4rem;
  font-weight: 700;
  color: #111827;
}

.stat-label {
  font-size: 0.82rem;
  color: #9ca3af;
}

.memories-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.memory-card {
  background: #f9fafb;
  padding: 12px;
  border-radius: 12px;
  transition: all 0.15s;
}

.memory-card:hover {
  background: #f3f4f6;
}

.memory-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.memory-type-badge {
  font-size: 0.72rem;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 500;
}

.memory-importance {
  color: #f59e0b;
  font-size: 0.85rem;
}

.btn-delete-memory {
  margin-left: auto;
  background: none;
  border: none;
  color: #d1d5db;
  font-size: 0.8rem;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}

.btn-delete-memory:hover {
  color: #ef4444;
  background: #fef2f2;
}

.memory-text {
  font-size: 0.88rem;
  color: #374151;
  line-height: 1.5;
  margin-bottom: 8px;
}

.memory-meta {
  display: flex;
  gap: 12px;
  font-size: 0.75rem;
  color: #9ca3af;
}
</style>
