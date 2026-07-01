<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  count?: number
  symbols?: string[]
}>(), {
  count: 14,
  symbols: () => ['❤', '✦', '❀', '♡', '✧', '·'],
})

interface Particle {
  left: number
  size: number
  delay: number
  duration: number
  symbol: string
  drift: number
  opacity: number
}

// 预生成一批随机漂浮粒子。纯 CSS 动画，不跑 JS 帧循环，几乎零成本。
const particles = computed<Particle[]>(() => {
  const list: Particle[] = []
  for (let i = 0; i < props.count; i++) {
    list.push({
      left: Math.random() * 100,
      size: 8 + Math.random() * 16,
      delay: Math.random() * 12,
      duration: 11 + Math.random() * 12,
      symbol: props.symbols[Math.floor(Math.random() * props.symbols.length)],
      drift: (Math.random() - 0.5) * 60,
      opacity: 0.25 + Math.random() * 0.5,
    })
  }
  return list
})
</script>

<template>
  <div class="ambient" aria-hidden="true">
    <div class="ambient-glow ambient-glow-a"></div>
    <div class="ambient-glow ambient-glow-b"></div>
    <span
      v-for="(p, i) in particles"
      :key="i"
      class="ambient-particle"
      :style="{
        left: `${p.left}%`,
        fontSize: `${p.size}px`,
        animationDelay: `${p.delay}s`,
        animationDuration: `${p.duration}s`,
        '--drift': `${p.drift}px`,
        '--pop': p.opacity,
      }"
    >{{ p.symbol }}</span>
  </div>
</template>

<style scoped>
.ambient {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
}

.ambient-glow {
  position: absolute;
  width: 460px;
  height: 460px;
  border-radius: 50%;
  filter: blur(70px);
  opacity: 0.9;
}

.ambient-glow-a {
  top: -120px;
  left: -80px;
  background: var(--ambient-a, rgba(124, 92, 255, 0.12));
  animation: glow-float-a 18s ease-in-out infinite;
}

.ambient-glow-b {
  bottom: -140px;
  right: -80px;
  background: var(--ambient-b, rgba(233, 95, 128, 0.12));
  animation: glow-float-b 22s ease-in-out infinite;
}

.ambient-particle {
  position: absolute;
  bottom: -30px;
  color: var(--particle-color, rgba(124, 92, 255, 0.4));
  animation-name: particle-rise;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  will-change: transform, opacity;
  user-select: none;
}

@keyframes particle-rise {
  0% {
    transform: translate(0, 0) scale(0.6) rotate(0deg);
    opacity: 0;
  }
  12% {
    opacity: var(--pop, 0.5);
  }
  85% {
    opacity: var(--pop, 0.5);
  }
  100% {
    transform: translate(var(--drift, 0), -102vh) scale(1) rotate(90deg);
    opacity: 0;
  }
}

@keyframes glow-float-a {
  0%, 100% { transform: translate(0, 0); }
  50% { transform: translate(60px, 40px); }
}

@keyframes glow-float-b {
  0%, 100% { transform: translate(0, 0); }
  50% { transform: translate(-50px, -40px); }
}

@media (prefers-reduced-motion: reduce) {
  .ambient-particle {
    display: none;
  }
  .ambient-glow {
    animation: none;
  }
}
</style>
