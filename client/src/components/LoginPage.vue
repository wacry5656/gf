<script setup lang="ts">
import { ref } from 'vue'
import type { User } from '../api'
import { login, register } from '../api'

const emit = defineEmits<{
  login: [user: User]
}>()

const isRegister = ref(false)
const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const error = ref('')
const loading = ref(false)

async function submit() {
  error.value = ''
  const u = username.value.trim()
  const p = password.value

  if (!u || !p) {
    error.value = '请填写用户名和密码'
    return
  }

  if (p.length < 4) {
    error.value = '密码至少4位'
    return
  }

  if (isRegister.value) {
    if (p !== confirmPassword.value) {
      error.value = '两次密码不一致'
      return
    }
  }

  loading.value = true
  try {
    let user: User
    if (isRegister.value) {
      user = await register(u, p)
    } else {
      user = await login(u, p)
    }
    emit('login', user)
  } catch (e: any) {
    error.value = e.message || '操作失败'
  } finally {
    loading.value = false
  }
}

function toggleMode() {
  isRegister.value = !isRegister.value
  error.value = ''
}
</script>

<template>
  <div class="auth-container">
    <div class="auth-card">
      <div class="auth-brand">💬</div>
      <h2>{{ isRegister ? '创建账号' : '欢迎回来' }}</h2>
      <p class="auth-sub">{{ isRegister ? '设置用户名和密码开始使用' : '登录你的账号继续聊天' }}</p>

      <form @submit.prevent="submit">
        <div class="field">
          <label>用户名</label>
          <input v-model="username" placeholder="输入用户名" maxlength="20" autofocus />
        </div>

        <div class="field">
          <label>密码</label>
          <input v-model="password" type="password" placeholder="输入密码" />
        </div>

        <div v-if="isRegister" class="field">
          <label>确认密码</label>
          <input v-model="confirmPassword" type="password" placeholder="再次输入密码" />
        </div>

        <div v-if="error" class="error-msg">{{ error }}</div>

        <button type="submit" class="btn-primary" :disabled="loading">
          {{ loading ? '处理中...' : (isRegister ? '创建账号' : '登录') }}
        </button>
      </form>

      <div class="toggle-link">
        <span v-if="isRegister">
          已有账号？<a href="#" @click.prevent="toggleMode">去登录</a>
        </span>
        <span v-else>
          没有账号？<a href="#" @click.prevent="toggleMode">去注册</a>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.auth-container {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: #f0f2f5;
}

.auth-card {
  background: #fff;
  border-radius: 16px;
  padding: 36px 28px;
  width: 100%;
  max-width: 360px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06);
}

.auth-brand {
  text-align: center;
  font-size: 2.2rem;
  margin-bottom: 8px;
}

.auth-card h2 {
  margin: 0 0 4px;
  text-align: center;
  color: #111827;
  font-size: 1.3rem;
  font-weight: 700;
}

.auth-sub {
  text-align: center;
  color: #9ca3af;
  font-size: 0.85rem;
  margin: 0 0 24px;
}

.field {
  margin-bottom: 14px;
}

.field label {
  display: block;
  font-weight: 600;
  margin-bottom: 5px;
  color: #374151;
  font-size: 0.82rem;
}

.field input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  font-size: 0.92rem;
  box-sizing: border-box;
  background: #f9fafb;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.field input:focus {
  outline: none;
  border-color: #95ec69;
  background: #fff;
  box-shadow: 0 0 0 2px rgba(149, 236, 105, 0.2);
}

.error-msg {
  color: #b91c1c;
  font-size: 0.82rem;
  margin-bottom: 10px;
  text-align: center;
  padding: 6px 10px;
  border-radius: 8px;
  background: #fef2f2;
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
  transition: background 0.15s;
}

.btn-primary:hover:not(:disabled) {
  background: #06ad56;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.toggle-link {
  text-align: center;
  margin-top: 16px;
  font-size: 0.82rem;
  color: #9ca3af;
}

.toggle-link a {
  color: #07c160;
  text-decoration: none;
  font-weight: 500;
}

.toggle-link a:hover {
  text-decoration: underline;
}
</style>