/**
 * 统一用户会话管理工具
 *
 * 所有页面/组件应通过此模块获取当前用户信息，
 * 而不是各自从 localStorage 读取，避免 userId 丢失或不一致。
 */

import type { User } from './api'

const STORAGE_KEY = 'user'
const ACTIVE_CHARACTER_KEY = 'activeCharacterId'
const CHAT_DRAFT_PREFIX = 'chatDraft'

function getChatDraftKey(userId: number, characterId: number): string {
  return `${CHAT_DRAFT_PREFIX}:${userId}:${characterId}`
}

/** 获取当前登录用户，未登录返回 null */
export function getCurrentUser(): User | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const user = JSON.parse(raw) as User
    if (!user.userId || !user.username) return null
    return user
  } catch {
    return null
  }
}

/** 获取当前 userId，未登录返回 null */
export function getCurrentUserId(): number | null {
  const user = getCurrentUser()
  return user ? user.userId : null
}

/**
 * 要求 userId 必须存在，否则抛出错误。
 * 用于必须登录才能执行的操作。
 */
export function requireUserId(): number {
  const userId = getCurrentUserId()
  if (!userId) {
    throw new Error('请重新登录')
  }
  return userId
}

/** 保存用户登录信息 */
export function saveUser(user: User): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(user))
}

/** 清除用户登录信息 */
export function clearUser(): void {
  localStorage.removeItem(STORAGE_KEY)
}

/** 获取当前激活的角色 ID，未选择时返回 null */
export function getActiveCharacterId(): number | null {
  try {
    const raw = localStorage.getItem(ACTIVE_CHARACTER_KEY)
    if (!raw) return null
    const parsed = Number(raw)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

/** 保存当前激活的角色 ID */
export function saveActiveCharacterId(characterId: number): void {
  localStorage.setItem(ACTIVE_CHARACTER_KEY, String(characterId))
}

/** 清除当前激活的角色 ID */
export function clearActiveCharacterId(): void {
  localStorage.removeItem(ACTIVE_CHARACTER_KEY)
}

/** 读取某个角色的未发送草稿 */
export function getChatDraft(userId: number, characterId: number): string {
  return localStorage.getItem(getChatDraftKey(userId, characterId)) || ''
}

/** 保存某个角色的未发送草稿 */
export function saveChatDraft(userId: number, characterId: number, draft: string): void {
  localStorage.setItem(getChatDraftKey(userId, characterId), draft)
}

/** 清除某个角色的未发送草稿 */
export function clearChatDraft(userId: number, characterId: number): void {
  localStorage.removeItem(getChatDraftKey(userId, characterId))
}
