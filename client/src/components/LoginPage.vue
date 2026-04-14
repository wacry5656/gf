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
      <h2>{{ isRegister ? '注册账号' : '登录' }}</h2>

      <form @submit.prevent="submit">
        <div class="field">
          <label>用户名</label>
          <input v-model="username" placeholder="请输入用户名" maxlength="20" autofocus />
        </div>

        <div class="field">
          <label>密码</label>
          <input v-model="password" type="password" placeholder="请输入密码" />
        </div>

        <div v-if="isRegister" class="field">
          <label>确认密码</label>
          <input v-model="confirmPassword" type="password" placeholder="再次输入密码" />
        </div>

        <div v-if="error" class="error-msg">{{ error }}</div>

        <button type="submit" class="btn-primary" :disabled="loading">
          {{ loading ? '处理中...' : (isRegister ? '注册' : '登录') }}
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
  border-radius: 12px;
  padding: 32px;
  width: 100%;
  max-width: 380px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}

.auth-card h2 {
  margin: 0 0 24px;
  text-align: center;
  color: #1a1a2e;
}

.field {
  margin-bottom: 16px;
}

.field label {
  display: block;
  font-weight: 600;
  margin-bottom: 6px;
  color: #333;
  font-size: 0.9rem;
}

.field input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #ddd;
  border-radius: 8px;
  font-size: 0.95rem;
  box-sizing: border-box;
}

.field input:focus {
  outline: none;
  border-color: #6c63ff;
  box-shadow: 0 0 0 2px rgba(108, 99, 255, 0.15);
}

.error-msg {
  color: #d32f2f;
  font-size: 0.85rem;
  margin-bottom: 12px;
  text-align: center;
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
}

.btn-primary:hover:not(:disabled) {
  background: #5a52d9;
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.toggle-link {
  text-align: center;
  margin-top: 16px;
  font-size: 0.85rem;
  color: #666;
}

.toggle-link a {
  color: #6c63ff;
  text-decoration: none;
}

.toggle-link a:hover {
  text-decoration: underline;
}
</style>
