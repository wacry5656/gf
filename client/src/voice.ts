/**
 * 语音能力封装：
 *  - 朗读（TTS）：基于 Web Speech API 的 speechSynthesis，让角色"说话"。
 *  - 语音输入（STT）：基于 SpeechRecognition，把说话转成输入框文字。
 *
 * 全部做特性检测，浏览器不支持时静默降级，不影响其它功能。
 */

const VOICE_PREF_KEY = 'voice-read-aloud'

// ---------- 朗读偏好 ----------

export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

export function getReadAloud(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(VOICE_PREF_KEY) === '1'
}

export function setReadAloud(enabled: boolean): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(VOICE_PREF_KEY, enabled ? '1' : '0')
  if (!enabled) cancelSpeak()
}

let cachedVoices: SpeechSynthesisVoice[] = []

function loadVoices(): SpeechSynthesisVoice[] {
  if (!isSpeechSupported()) return []
  const voices = window.speechSynthesis.getVoices()
  if (voices.length) cachedVoices = voices
  return cachedVoices
}

// 语音列表在部分浏览器里是异步就绪的，这里提前监听一次。
if (isSpeechSupported()) {
  loadVoices()
  window.speechSynthesis.onvoiceschanged = () => loadVoices()
}

function pickVoice(gender: 'male' | 'female' | 'other'): SpeechSynthesisVoice | null {
  const voices = loadVoices()
  if (!voices.length) return null

  const zh = voices.filter((v) => /zh|cmn|chinese/i.test(v.lang) || /chinese|中文|普通话/i.test(v.name))
  const pool = zh.length ? zh : voices

  // 尝试按性别在语音名里做一次弱匹配（不同平台命名差异较大）。
  const femaleHint = /female|woman|xiaoxiao|xiaoyi|yaoyao|mei|ting|婷|小|女/i
  const maleHint = /male|man|yunxi|yunyang|kangkang|云|男/i
  if (gender === 'female') {
    const match = pool.find((v) => femaleHint.test(v.name))
    if (match) return match
  } else if (gender === 'male') {
    const match = pool.find((v) => maleHint.test(v.name))
    if (match) return match
  }
  return pool[0]
}

/** 朗读一段文字；会先打断上一段未读完的内容。 */
export function speak(text: string, gender: 'male' | 'female' | 'other' = 'female'): void {
  if (!isSpeechSupported()) return
  const clean = text.replace(/​/g, '').trim()
  if (!clean) return

  try {
    const synth = window.speechSynthesis
    synth.cancel()
    const utter = new SpeechSynthesisUtterance(clean)
    const voice = pickVoice(gender)
    if (voice) {
      utter.voice = voice
      utter.lang = voice.lang
    } else {
      utter.lang = 'zh-CN'
    }
    // 女生音调略高、男生略低，让"角色感"更强一点。
    utter.pitch = gender === 'male' ? 0.9 : gender === 'female' ? 1.15 : 1
    utter.rate = 1.02
    synth.speak(utter)
  } catch {
    // 忽略朗读异常，绝不影响聊天主流程。
  }
}

/** 朗读多条消息（角色连发时按顺序读）。 */
export function speakSequence(texts: string[], gender: 'male' | 'female' | 'other' = 'female'): void {
  const joined = texts.map((t) => t.replace(/​/g, '').trim()).filter(Boolean).join('，')
  speak(joined, gender)
}

export function cancelSpeak(): void {
  if (!isSpeechSupported()) return
  try {
    window.speechSynthesis.cancel()
  } catch {
    // ignore
  }
}

// ---------- 语音输入（STT） ----------

interface MinimalSpeechRecognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((event: any) => void) | null
  onerror: ((event: any) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionCtor = new () => MinimalSpeechRecognition

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as any
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

export function isVoiceInputSupported(): boolean {
  return getRecognitionCtor() !== null
}

export interface VoiceInputSession {
  stop: () => void
}

/**
 * 启动一次语音识别。
 * @param onText  识别出的（累积）文本回调，可用于实时预览。
 * @param onDone  识别结束回调，参数为最终完整文本。
 * @param onError 出错回调。
 */
export function startVoiceInput(
  onText: (text: string) => void,
  onDone: (finalText: string) => void,
  onError?: (message: string) => void,
): VoiceInputSession | null {
  const Ctor = getRecognitionCtor()
  if (!Ctor) {
    onError?.('当前浏览器不支持语音输入')
    return null
  }

  const recognition = new Ctor()
  recognition.lang = 'zh-CN'
  recognition.continuous = false
  recognition.interimResults = true

  let finalText = ''

  recognition.onresult = (event: any) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0]?.transcript || ''
      if (event.results[i].isFinal) {
        finalText += transcript
      } else {
        interim += transcript
      }
    }
    onText((finalText + interim).trim())
  }

  recognition.onerror = (event: any) => {
    const code = event?.error || 'unknown'
    const map: Record<string, string> = {
      'not-allowed': '麦克风权限被拒绝',
      'no-speech': '没有听清，再说一次',
      'audio-capture': '找不到麦克风设备',
      network: '语音识别网络异常',
    }
    onError?.(map[code] || '语音识别失败')
  }

  recognition.onend = () => {
    onDone(finalText.trim())
  }

  try {
    recognition.start()
  } catch {
    onError?.('无法启动语音输入')
    return null
  }

  return {
    stop: () => {
      try {
        recognition.stop()
      } catch {
        // ignore
      }
    },
  }
}
