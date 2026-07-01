<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{
  select: [emoji: string]
}>()

interface EmojiGroup {
  name: string
  icon: string
  emojis: string[]
}

const groups: EmojiGroup[] = [
  {
    name: '常用',
    icon: '⭐',
    emojis: ['😊', '😂', '🥰', '😍', '😘', '🤗', '😳', '😭', '🥺', '😅', '😏', '😴', '🤔', '👍', '🙏', '💪', '🎉', '✨', '🔥', '💯'],
  },
  {
    name: '爱心',
    icon: '❤️',
    emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🤍', '🖤', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '❣️', '💌', '😻', '🫶'],
  },
  {
    name: '表情',
    icon: '😜',
    emojis: ['😄', '😁', '😆', '😉', '😋', '😛', '😝', '🤪', '😎', '🥳', '😔', '😞', '😟', '😤', '😠', '😡', '🥹', '😩', '😫', '😰'],
  },
  {
    name: '手势',
    icon: '👋',
    emojis: ['👋', '🤙', '✌️', '🤞', '👌', '🤟', '👏', '🙌', '🤝', '🫂', '💅', '👀', '🫡', '🤭', '🫣', '🙈', '🐶', '🐱', '🌸', '🌙'],
  },
]

const activeGroup = ref(0)
</script>

<template>
  <div class="emoji-picker" @click.stop>
    <div class="emoji-grid">
      <button
        v-for="e in groups[activeGroup].emojis"
        :key="e"
        class="emoji-cell"
        type="button"
        @click="emit('select', e)"
      >{{ e }}</button>
    </div>
    <div class="emoji-tabs">
      <button
        v-for="(g, i) in groups"
        :key="g.name"
        class="emoji-tab"
        :class="{ active: i === activeGroup }"
        type="button"
        :title="g.name"
        @click="activeGroup = i"
      >{{ g.icon }}</button>
    </div>
  </div>
</template>

<style scoped>
.emoji-picker {
  width: 268px;
  padding: 10px;
  border-radius: 14px;
  background: var(--panel-bg, #fff);
  border: 1px solid var(--card-border, #e5e7eb);
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.22);
}

.emoji-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 2px;
  max-height: 176px;
  overflow-y: auto;
}

.emoji-cell {
  border: none;
  background: none;
  font-size: 1.35rem;
  line-height: 1;
  padding: 6px 0;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.12s, transform 0.12s;
}

.emoji-cell:hover {
  background: var(--app-bg, #f3f4f6);
  transform: scale(1.15);
}

.emoji-tabs {
  display: flex;
  justify-content: space-around;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-color, #eee);
}

.emoji-tab {
  border: none;
  background: none;
  font-size: 1.05rem;
  padding: 4px 8px;
  border-radius: 8px;
  cursor: pointer;
  opacity: 0.55;
  transition: opacity 0.12s, background 0.12s;
}

.emoji-tab:hover {
  opacity: 0.85;
  background: var(--app-bg, #f3f4f6);
}

.emoji-tab.active {
  opacity: 1;
  background: color-mix(in srgb, var(--accent, #07c160) 15%, transparent);
}
</style>
