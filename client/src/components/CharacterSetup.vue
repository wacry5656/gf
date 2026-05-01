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
        ? '你们是恋人关系，但只用微信/WhatsApp式短消息聊天，不写旁白和动作。'
        : '你们是熟悉的日常聊天对象，只用微信/WhatsApp式短消息聊天，不写旁白和动作。'
    ),
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
          <label>角色性别</label>
          <div class="radio-group">
            <label><input type="radio" v-model="form.gender" value="female" /> 女</label>
            <label><input type="radio" v-model="form.gender" value="male" /> 男</label>
            <label><input type="radio" v-model="form.gender" value="other" /> 不限定</label>
          </div>
        </div>

        <div class="field field-split">
          <div>
            <label>你的性别</label>
            <div class="radio-group compact">
              <label><input type="radio" v-model="form.userGender" value="male" /> 男</label>
              <label><input type="radio" v-model="form.userGender" value="female" /> 女</label>
            </div>
          </div>
          <div>
            <label>关系</label>
            <div class="radio-group compact">
              <label><input type="radio" v-model="form.relationshipMode" value="lover" /> 恋人</label>
              <label><input type="radio" v-model="form.relationshipMode" value="friend" /> 非恋人</label>
            </div>
          </div>
        </div>

        <div class="field">
          <label>
            人格
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
          <label>回复节奏</label>
          <select v-model="form.replyStyle">
            <option v-for="style in replyStyles" :key="style" :value="style">{{ style }}</option>
          </select>
        </div>

        <div class="field">
          <label>角色描述 <span class="optional">(可选)</span></label>
          <textarea v-model="form.description" placeholder="描述角色的背景、说话风格等..."
            rows="3" maxlength="300"></textarea>
        </div>

        <button type="submit" class="btn-primary" :disabled="submitting">
          {{ submitting ? '创建中...' : '开始聊天' }}
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

.field > label,
.field-split > div > label {
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

.field-split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}

.radio-group.compact {
  gap: 12px;
}

.radio-group label {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  font-weight: 400;
}

@media (max-width: 560px) {
  .field-split {
    grid-template-columns: 1fr;
  }
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

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
