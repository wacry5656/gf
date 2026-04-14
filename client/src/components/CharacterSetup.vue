<script setup lang="ts">
import { reactive } from 'vue'
import type { Character } from '../api'

const emit = defineEmits<{
  confirm: [character: Character]
}>()

const presetPersonalities = [
  '温柔体贴、善解人意',
  '活泼开朗、古灵精怪',
  '高冷傲娇、口是心非',
  '知性优雅、博学多才',
  '元气少女、天真烂漫',
  '成熟稳重、可靠温暖',
]

const form = reactive({
  name: '',
  gender: 'female' as Character['gender'],
  personality: presetPersonalities[0],
  customPersonality: '',
  useCustom: false,
  description: '',
})

function submit() {
  if (!form.name.trim()) return
  const personality = form.useCustom
    ? form.customPersonality.trim()
    : form.personality
  if (!personality) return

  emit('confirm', {
    name: form.name.trim(),
    gender: form.gender,
    personality,
    description: form.description.trim() || '一个友善的虚拟聊天伙伴',
  })
}
</script>

<template>
  <div class="setup-container">
    <div class="setup-card">
      <h2>创建你的聊天角色</h2>

      <form @submit.prevent="submit">
        <div class="field">
          <label>角色名称</label>
          <input v-model="form.name" placeholder="给角色起个名字..." maxlength="20" required />
        </div>

        <div class="field">
          <label>性别</label>
          <div class="radio-group">
            <label><input type="radio" v-model="form.gender" value="female" /> 女</label>
            <label><input type="radio" v-model="form.gender" value="male" /> 男</label>
            <label><input type="radio" v-model="form.gender" value="other" /> 其它</label>
          </div>
        </div>

        <div class="field">
          <label>
            性格设定
            <span class="toggle" @click="form.useCustom = !form.useCustom">
              {{ form.useCustom ? '选择预设 ▾' : '自定义 ✎' }}
            </span>
          </label>
          <select v-if="!form.useCustom" v-model="form.personality">
            <option v-for="p in presetPersonalities" :key="p" :value="p">{{ p }}</option>
          </select>
          <input v-else v-model="form.customPersonality" placeholder="输入自定义性格描述词..."
            maxlength="100" />
        </div>

        <div class="field">
          <label>角色描述 <span class="optional">(可选)</span></label>
          <textarea v-model="form.description" placeholder="描述角色的背景、说话风格等..."
            rows="3" maxlength="300"></textarea>
        </div>

        <button type="submit" class="btn-primary">开始聊天</button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.setup-container {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: #f0f2f5;
}

.setup-card {
  background: #fff;
  border-radius: 12px;
  padding: 32px;
  width: 100%;
  max-width: 480px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}

.setup-card h2 {
  margin: 0 0 24px;
  text-align: center;
  color: #1a1a2e;
}

.field {
  margin-bottom: 18px;
}

.field > label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  margin-bottom: 6px;
  color: #333;
  font-size: 0.9rem;
}

.optional {
  font-weight: 400;
  color: #999;
  font-size: 0.8rem;
}

.toggle {
  font-weight: 400;
  color: #6c63ff;
  cursor: pointer;
  font-size: 0.8rem;
}

.toggle:hover {
  text-decoration: underline;
}

input, select, textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #ddd;
  border-radius: 8px;
  font-size: 0.95rem;
  box-sizing: border-box;
  font-family: inherit;
}

input:focus, select:focus, textarea:focus {
  outline: none;
  border-color: #6c63ff;
  box-shadow: 0 0 0 2px rgba(108, 99, 255, 0.15);
}

.radio-group {
  display: flex;
  gap: 20px;
}

.radio-group label {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  font-weight: 400;
}

.btn-primary {
  width: 100%;
  padding: 12px;
  background: #6c63ff;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  margin-top: 8px;
}

.btn-primary:hover {
  background: #5a52d9;
}
</style>
