<script setup lang="ts">
import { reactive } from 'vue'
import type { Character } from '../api'

const props = defineProps<{
  submitting?: boolean
}>()

const emit = defineEmits<{
  confirm: [character: Character]
}>()

const presetPersonalities = [
  '自然：像普通人聊天，认真接话，不表演',
  '温和：语气柔和，会照顾情绪，但不长篇安慰',
  '直率：直接表达想法，不绕弯，不突然发脾气',
  '轻松：口语自然，偶尔开玩笑，但不过度玩梗',
  '克制：话少一点，但必须正常回答，不用沉默代替回复',
  '慢热：一开始简短自然，熟悉后更主动一点',
  '毒舌：嘴毒但心不坏，关键时还是关心',
]

const replyStyles = [
  '短句：每次1到2条消息，每条尽量不超过18个字',
  '自然：每次1到3条消息，像微信聊天',
  '主动：可以多追问一句，但不要连续提问',
]

const form = reactive({
  name: '',
  gender: 'female' as Character['gender'],
  userGender: 'male' as NonNullable<Character['userGender']>,
  relationshipMode: 'lover' as NonNullable<Character['relationshipMode']>,
  personality: presetPersonalities[0],
  replyStyle: replyStyles[1],
  customPersonality: '',
  useCustom: false,
  description: '',
})

function submit() {
  if (props.submitting) return
  if (!form.name.trim()) return
  const personality = form.useCustom
    ? form.customPersonality.trim()
    : form.personality
  if (!personality) return
  const finalPersonality = [
    personality,
    form.replyStyle,
    '边界：禁止旁白、动作描写、心理描写、沉默状态、睡眠状态、呼吸声、突然骂人、阴阳怪气、辱骂用户。',
  ].join('\n')

  emit('confirm', {
    name: form.name.trim(),
    gender: form.gender,
    userGender: form.userGender,
    relationshipMode: form.relationshipMode,
    personality: finalPersonality,
    description: form.description.trim() || (
      form.relationshipMode === 'lover'
        ? '你们是恋人关系，但只用微信式短消息聊天，不写旁白和动作。'
        : '你们是熟悉的日常聊天对象，只用微信式短消息聊天，不写旁白和动作。'
    ),
  })
}
</script>

<template>
  <div class="setup-container">
    <div class="setup-card">
      <div class="setup-header">
        <div class="setup-icon">✨</div>
        <h2>创建你的角色</h2>
        <p class="setup-sub">定义对方的性格和你们的聊天方式</p>
      </div>

      <form @submit.prevent="submit">
        <div class="field">
          <label>角色名称</label>
          <input v-model="form.name" placeholder="给角色起个名字..." maxlength="20" required />
        </div>

        <div class="field field-row">
          <div class="field-col">
            <label>角色性别</label>
            <div class="btn-group">
              <button type="button" :class="['btn-opt', form.gender === 'female' ? 'active' : '']" @click="form.gender = 'female'">♀ 女</button>
              <button type="button" :class="['btn-opt', form.gender === 'male' ? 'active' : '']" @click="form.gender = 'male'">♂ 男</button>
              <button type="button" :class="['btn-opt', form.gender === 'other' ? 'active' : '']" @click="form.gender = 'other'">其他</button>
            </div>
          </div>
          <div class="field-col">
            <label>你的性别</label>
            <div class="btn-group">
              <button type="button" :class="['btn-opt', form.userGender === 'male' ? 'active' : '']" @click="form.userGender = 'male'">♂ 男</button>
              <button type="button" :class="['btn-opt', form.userGender === 'female' ? 'active' : '']" @click="form.userGender = 'female'">♀ 女</button>
            </div>
          </div>
        </div>

        <div class="field">
          <label>关系</label>
          <div class="btn-group wide">
            <button type="button" :class="['btn-opt', form.relationshipMode === 'lover' ? 'active' : '']" @click="form.relationshipMode = 'lover'">💕 恋人</button>
            <button type="button" :class="['btn-opt', form.relationshipMode === 'friend' ? 'active' : '']" @click="form.relationshipMode = 'friend'">👋 朋友</button>
          </div>
        </div>

        <div class="field">
          <label>
            人格风格
            <span class="toggle" @click="form.useCustom = !form.useCustom">
              {{ form.useCustom ? '选择预设 ▾' : '自定义 ✎' }}
            </span>
          </label>
          <select v-if="!form.useCustom" v-model="form.personality" class="input-select">
            <option v-for="p in presetPersonalities" :key="p" :value="p">{{ p }}</option>
          </select>
          <input v-else v-model="form.customPersonality" placeholder="输入自定义性格描述词..." maxlength="100" />
        </div>

        <div class="field">
          <label>回复节奏</label>
          <select v-model="form.replyStyle" class="input-select">
            <option v-for="style in replyStyles" :key="style" :value="style">{{ style }}</option>
          </select>
        </div>

        <div class="field">
          <label>角色描述 <span class="optional">(可选)</span></label>
          <textarea v-model="form.description" placeholder="描述角色的背景、说话风格等..." rows="3" maxlength="300"></textarea>
        </div>

        <button type="submit" class="btn-primary" :disabled="submitting">
          {{ submitting ? '创建中...' : '开始聊天 →' }}
        </button>
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
  border-radius: 16px;
  padding: 32px 28px;
  width: 100%;
  max-width: 460px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06);
}

.setup-header {
  text-align: center;
  margin-bottom: 24px;
}

.setup-icon {
  font-size: 2rem;
  margin-bottom: 4px;
}

.setup-card h2 {
  margin: 0 0 4px;
  color: #111827;
  font-size: 1.25rem;
}

.setup-sub {
  color: #9ca3af;
  font-size: 0.85rem;
  margin: 0;
}

.field {
  margin-bottom: 16px;
}

.field > label,
.field-row > div > label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  margin-bottom: 6px;
  color: #374151;
  font-size: 0.85rem;
}

.optional {
  font-weight: 400;
  color: #9ca3af;
  font-size: 0.78rem;
}

.toggle {
  font-weight: 400;
  color: #07c160;
  cursor: pointer;
  font-size: 0.78rem;
}

.toggle:hover {
  text-decoration: underline;
}

.field-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.field-col label {
  display: block;
  font-weight: 600;
  margin-bottom: 6px;
  color: #374151;
  font-size: 0.85rem;
}

.btn-group {
  display: flex;
  gap: 6px;
}

.btn-group.wide {
  gap: 8px;
}

.btn-opt {
  flex: 1;
  padding: 8px 10px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #f9fafb;
  color: #6b7280;
  font-size: 0.82rem;
  cursor: pointer;
  transition: all 0.15s;
  font-family: inherit;
  text-align: center;
}

.btn-opt.active {
  background: #07c160;
  color: #fff;
  border-color: #07c160;
}

.btn-opt:hover:not(.active) {
  border-color: #9ca3af;
  background: #f3f4f6;
}

input, .input-select, textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  font-size: 0.92rem;
  box-sizing: border-box;
  font-family: inherit;
  background: #f9fafb;
  transition: border-color 0.15s, box-shadow 0.15s;
}

input:focus, .input-select:focus, textarea:focus {
  outline: none;
  border-color: #95ec69;
  background: #fff;
  box-shadow: 0 0 0 2px rgba(149, 236, 105, 0.2);
}

.input-select {
  appearance: none;
  -webkit-appearance: none;
  padding-right: 30px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
}

.btn-primary {
  width: 100%;
  padding: 12px;
  background: #07c160;
  color: #fff;
  border: none;
  border-radius: 10px;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  margin-top: 8px;
  transition: background 0.15s;
}

.btn-primary:hover:not(:disabled) {
  background: #06ad56;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 560px) {
  .field-row {
    grid-template-columns: 1fr;
  }
}
</style>