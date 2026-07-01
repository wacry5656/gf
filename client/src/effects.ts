/**
 * 视觉与音效引擎（纯前端，无第三方依赖）：
 *  - playEffect：全屏 canvas 粒子特效（彩带 / 爱心 / 花瓣 / 烟花 / 星星）。
 *  - playSound：WebAudio 合成的轻量 UI 音效（无需音频文件）。
 *
 * 全部惰性初始化：不触发就不会创建 canvas / AudioContext。
 */

export type EffectType = 'confetti' | 'hearts' | 'petals' | 'fireworks' | 'stars'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  rot: number
  vrot: number
  size: number
  gravity: number
  drag: number
  life: number
  maxLife: number
  color: string
  glyph?: string
  shape: 'rect' | 'circle' | 'glyph'
}

let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null
let particles: Particle[] = []
let rafId = 0
let running = false
let dpr = 1

function reducedMotion(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function ensureCanvas(): void {
  if (typeof document === 'undefined') return
  if (!canvas) {
    canvas = document.createElement('canvas')
    canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;'
    canvas.setAttribute('aria-hidden', 'true')
    document.body.appendChild(canvas)
    ctx = canvas.getContext('2d')
    window.addEventListener('resize', sizeCanvas)
  }
  sizeCanvas()
}

function sizeCanvas(): void {
  if (!canvas || !ctx) return
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.floor(window.innerWidth * dpr)
  canvas.height = Math.floor(window.innerHeight * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

const CONFETTI_COLORS = ['#f472b6', '#c084fc', '#60a5fa', '#34d399', '#fbbf24', '#fb7185', '#38bdf8']
const HEART_GLYPHS = ['❤️', '💖', '💗', '💕', '💘']
const STAR_GLYPHS = ['✨', '⭐', '🌟', '💫']

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function spawnConfetti(count: number): void {
  const cx = window.innerWidth / 2
  for (let i = 0; i < count; i++) {
    particles.push({
      x: rand(cx - 120, cx + 120),
      y: -20,
      vx: rand(-6, 6),
      vy: rand(2, 7),
      rot: rand(0, Math.PI * 2),
      vrot: rand(-0.3, 0.3),
      size: rand(6, 12),
      gravity: 0.18,
      drag: 0.995,
      life: 0,
      maxLife: rand(90, 150),
      color: pick(CONFETTI_COLORS),
      shape: 'rect',
    })
  }
}

function spawnRising(count: number, glyphs: string[]): void {
  const w = window.innerWidth
  for (let i = 0; i < count; i++) {
    particles.push({
      x: rand(w * 0.15, w * 0.85),
      y: window.innerHeight + rand(0, 60),
      vx: rand(-0.8, 0.8),
      vy: rand(-3.4, -1.8),
      rot: rand(-0.3, 0.3),
      vrot: rand(-0.04, 0.04),
      size: rand(20, 40),
      gravity: -0.008,
      drag: 1,
      life: 0,
      maxLife: rand(110, 170),
      color: '#fff',
      glyph: pick(glyphs),
      shape: 'glyph',
    })
  }
}

function spawnPetals(count: number): void {
  const w = window.innerWidth
  for (let i = 0; i < count; i++) {
    particles.push({
      x: rand(0, w),
      y: rand(-80, -10),
      vx: rand(-0.6, 1.4),
      vy: rand(1.2, 2.8),
      rot: rand(0, Math.PI * 2),
      vrot: rand(-0.06, 0.06),
      size: rand(18, 30),
      gravity: 0.002,
      drag: 1,
      life: 0,
      maxLife: rand(140, 220),
      color: '#fff',
      glyph: pick(['🌸', '🌷', '🌹']),
      shape: 'glyph',
    })
  }
}

function spawnFireworkBurst(x: number, y: number): void {
  const color = pick(CONFETTI_COLORS)
  const arms = 26
  for (let i = 0; i < arms; i++) {
    const angle = (Math.PI * 2 * i) / arms + rand(-0.1, 0.1)
    const speed = rand(2.5, 5.5)
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      rot: 0,
      vrot: 0,
      size: rand(2.5, 4.5),
      gravity: 0.06,
      drag: 0.96,
      life: 0,
      maxLife: rand(50, 80),
      color,
      shape: 'circle',
    })
  }
}

function spawnFireworks(): void {
  const w = window.innerWidth
  const h = window.innerHeight
  const bursts = reducedMotion() ? 1 : 3
  for (let b = 0; b < bursts; b++) {
    setTimeout(() => {
      spawnFireworkBurst(rand(w * 0.2, w * 0.8), rand(h * 0.2, h * 0.5))
      startLoop()
    }, b * 260)
  }
}

function step(): void {
  if (!ctx || !canvas) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  for (const p of particles) {
    p.life++
    p.vy += p.gravity
    p.vx *= p.drag
    p.vy *= p.drag
    p.x += p.vx
    p.y += p.vy
    p.rot += p.vrot

    const fade = 1 - Math.max(0, (p.life - p.maxLife * 0.6) / (p.maxLife * 0.4))
    ctx.globalAlpha = Math.max(0, Math.min(1, fade))

    if (p.shape === 'glyph' && p.glyph) {
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.rotate(p.rot)
      ctx.font = `${p.size}px serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(p.glyph, 0, 0)
      ctx.restore()
    } else if (p.shape === 'circle') {
      ctx.beginPath()
      ctx.fillStyle = p.color
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
      ctx.fill()
    } else {
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.rotate(p.rot)
      ctx.fillStyle = p.color
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6)
      ctx.restore()
    }
  }
  ctx.globalAlpha = 1

  particles = particles.filter(
    (p) => p.life < p.maxLife && p.y < window.innerHeight + 80 && p.y > -200,
  )

  if (particles.length > 0) {
    rafId = requestAnimationFrame(step)
  } else {
    running = false
    if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height)
  }
}

function startLoop(): void {
  if (!running) {
    running = true
    rafId = requestAnimationFrame(step)
  }
}

/** 播放一次全屏特效。 */
export function playEffect(type: EffectType): void {
  try {
    ensureCanvas()
    if (!ctx) return
    const scale = reducedMotion() ? 0.4 : 1

    switch (type) {
      case 'confetti':
        spawnConfetti(Math.round(90 * scale))
        startLoop()
        break
      case 'hearts':
        spawnRising(Math.round(22 * scale), HEART_GLYPHS)
        startLoop()
        break
      case 'petals':
        spawnPetals(Math.round(28 * scale))
        startLoop()
        break
      case 'stars':
        spawnRising(Math.round(20 * scale), STAR_GLYPHS)
        startLoop()
        break
      case 'fireworks':
        spawnFireworks()
        break
    }
  } catch {
    // 特效永远不能影响主流程
  }
}

/** 立即停止并清空所有特效。 */
export function clearEffects(): void {
  particles = []
  running = false
  if (rafId) cancelAnimationFrame(rafId)
  if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height)
}

// ---------- 音效 ----------

let audioCtx: AudioContext | null = null
let soundEnabled = false

export function setSoundEnabled(enabled: boolean): void {
  soundEnabled = enabled
}

function getAudioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!audioCtx) {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext
    if (!Ctor) return null
    audioCtx = new Ctor()
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
  return audioCtx
}

interface Tone {
  freq: number
  dur: number
  type: OscillatorType
  gain?: number
  delay?: number
}

const SOUND_PRESETS: Record<string, Tone[]> = {
  send: [{ freq: 660, dur: 0.09, type: 'sine' }, { freq: 990, dur: 0.08, type: 'sine', delay: 0.05 }],
  receive: [{ freq: 523, dur: 0.1, type: 'sine' }, { freq: 392, dur: 0.12, type: 'sine', delay: 0.06 }],
  like: [{ freq: 880, dur: 0.08, type: 'triangle' }, { freq: 1318, dur: 0.1, type: 'triangle', delay: 0.05 }],
  gift: [
    { freq: 587, dur: 0.1, type: 'sine' },
    { freq: 784, dur: 0.1, type: 'sine', delay: 0.08 },
    { freq: 1046, dur: 0.16, type: 'sine', delay: 0.16 },
  ],
}

/** 播放合成音效（关闭时或不支持时静默）。 */
export function playSound(kind: keyof typeof SOUND_PRESETS): void {
  if (!soundEnabled) return
  const ac = getAudioCtx()
  if (!ac) return
  const tones = SOUND_PRESETS[kind]
  if (!tones) return

  try {
    const now = ac.currentTime
    for (const tone of tones) {
      const osc = ac.createOscillator()
      const gainNode = ac.createGain()
      const start = now + (tone.delay || 0)
      const peak = tone.gain ?? 0.12
      osc.type = tone.type
      osc.frequency.value = tone.freq
      gainNode.gain.setValueAtTime(0.0001, start)
      gainNode.gain.exponentialRampToValueAtTime(peak, start + 0.012)
      gainNode.gain.exponentialRampToValueAtTime(0.0001, start + tone.dur)
      osc.connect(gainNode)
      gainNode.connect(ac.destination)
      osc.start(start)
      osc.stop(start + tone.dur + 0.02)
    }
  } catch {
    // 忽略音效异常
  }
}
