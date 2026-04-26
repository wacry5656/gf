import db from '../db';

export interface RelationshipState {
  characterId: number;
  affection: number;
  trust: number;
  tension: number;
  attachment: number;
  mood: string;
  lastUserTone: string;
  lastEvent: string | null;
}

interface StateRow {
  character_id: number;
  affection: number;
  trust: number;
  tension: number;
  attachment: number;
  mood: string;
  last_user_tone: string;
  last_event: string | null;
}

type Tone =
  | 'affectionate'
  | 'flirty'
  | 'trusting'
  | 'needy'
  | 'hurt'
  | 'angry'
  | 'apologetic'
  | 'playful'
  | 'neutral';

const clamp = (value: number, min = 0, max = 100): number => Math.max(min, Math.min(max, value));
const stateSensitivity = (): number => Number(process.env.RELATIONSHIP_STATE_SENSITIVITY || 1.65);

const DEFAULT_STATE: Omit<RelationshipState, 'characterId'> = {
  affection: 72,
  trust: 62,
  tension: 4,
  attachment: 64,
  mood: 'warm',
  lastUserTone: 'neutral',
  lastEvent: null,
};

export function getRelationshipState(characterId: number): RelationshipState {
  ensureState(characterId);
  const row = db
    .prepare(
      'SELECT character_id, affection, trust, tension, attachment, mood, last_user_tone, last_event FROM character_states WHERE character_id = ?',
    )
    .get(characterId) as StateRow | undefined;

  if (!row) {
    return { characterId, ...DEFAULT_STATE };
  }

  return {
    characterId: row.character_id,
    affection: row.affection,
    trust: row.trust,
    tension: row.tension,
    attachment: row.attachment,
    mood: row.mood,
    lastUserTone: row.last_user_tone,
    lastEvent: row.last_event,
  };
}

export function updateRelationshipStateFromUserMessage(characterId: number, text: string): RelationshipState {
  ensureState(characterId);
  const current = getRelationshipState(characterId);
  const tone = detectTone(text);
  const delta = scaleDelta(getToneDelta(tone, text), text);

  const next = {
    affection: clamp(current.affection + delta.affection),
    trust: clamp(current.trust + delta.trust),
    tension: clamp(current.tension + delta.tension),
    attachment: clamp(current.attachment + delta.attachment),
  };

  const mood = deriveMood(next.affection, next.trust, next.tension, next.attachment, tone);
  const event = buildLastEvent(tone, text);

  db.prepare(
    `UPDATE character_states
     SET affection = ?, trust = ?, tension = ?, attachment = ?, mood = ?, last_user_tone = ?, last_event = ?, updated_at = datetime('now')
     WHERE character_id = ?`,
  ).run(next.affection, next.trust, next.tension, next.attachment, mood, tone, event, characterId);

  return {
    characterId,
    ...next,
    mood,
    lastUserTone: tone,
    lastEvent: event,
  };
}

export function buildRelationshipStatePrompt(state: RelationshipState): string {
  return `===== 关系与脾气状态（这是你的内在状态，不要直接报数值） =====
- 基础关系认同：你默认就是用户的对象/恋人，不是普通朋友；除非用户明确重新定义关系，否则按亲密对象相处。
- 好感：${state.affection}/100；信任：${state.trust}/100；紧张/生气：${state.tension}/100；依恋：${state.attachment}/100
- 当前心情基调：${describeMood(state.mood)}
- 用户上一句语气：${describeTone(state.lastUserTone)}
- 回复时要让这些状态影响语气，但不要解释状态系统，也不要说“好感度/信任值”。`;
}

function ensureState(characterId: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO character_states
      (character_id, affection, trust, tension, attachment, mood, last_user_tone)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    characterId,
    DEFAULT_STATE.affection,
    DEFAULT_STATE.trust,
    DEFAULT_STATE.tension,
    DEFAULT_STATE.attachment,
    DEFAULT_STATE.mood,
    DEFAULT_STATE.lastUserTone,
  );

  // 兼容上一版“普通熟人”默认值：只迁移完全未互动过的初始状态，不覆盖真实聊天形成的状态。
  db.prepare(
    `UPDATE character_states
     SET affection = ?, trust = ?, tension = ?, attachment = ?, mood = ?, updated_at = datetime('now')
     WHERE character_id = ?
       AND affection = 55
       AND trust = 50
       AND tension = 8
       AND attachment = 35
       AND mood = 'steady'
       AND last_user_tone = 'neutral'
       AND last_event IS NULL`,
  ).run(
    DEFAULT_STATE.affection,
    DEFAULT_STATE.trust,
    DEFAULT_STATE.tension,
    DEFAULT_STATE.attachment,
    DEFAULT_STATE.mood,
    characterId,
  );
}

function detectTone(text: string): Tone {
  const t = text.trim();

  if (/(对不起|抱歉|我错了|别生气|原谅我|不好意思|不是故意)/.test(t)) return 'apologetic';
  if (/(烦死|讨厌你|滚|闭嘴|有病|傻|蠢|废物|别理我|不想理你|你怎么这样|太过分)/.test(t)) return 'angry';
  if (/(难过|委屈|崩溃|累死|压力|焦虑|emo|想哭|没人懂|不开心|失眠)/i.test(t)) return 'hurt';
  if (/(喜欢你|爱你|想你|亲亲|抱抱|贴贴|么么|mua|老婆|宝贝|宝宝)/i.test(t)) return 'affectionate';
  if (/(想我|撩|暧昧|吃醋|是不是喜欢|你是不是|心动|脸红)/.test(t)) return 'flirty';
  if (/(只告诉你|秘密|信任你|你懂我|只有你|靠你|安全感|陪陪我)/.test(t)) return 'trusting';
  if (/(陪我|理理我|别走|不要离开|哄我|想要你|黏你|撒娇)/.test(t)) return 'needy';
  if (/(哈哈|笑死|逗你|开玩笑|笨蛋|哼|略略|嘻嘻)/.test(t)) return 'playful';

  return 'neutral';
}

function getToneDelta(tone: Tone, text: string): { affection: number; trust: number; tension: number; attachment: number } {
  const longConfessionBoost = text.length >= 30 ? 2 : 0;

  switch (tone) {
    case 'affectionate':
      return { affection: 7 + longConfessionBoost, trust: 3, tension: -5, attachment: 5 };
    case 'flirty':
      return { affection: 5, trust: 2, tension: -2, attachment: 4 };
    case 'trusting':
      return { affection: 3, trust: 7 + longConfessionBoost, tension: -4, attachment: 4 };
    case 'needy':
      return { affection: 3, trust: 2, tension: 2, attachment: 7 };
    case 'hurt':
      return { affection: 2, trust: 4, tension: -2, attachment: 4 };
    case 'angry':
      return { affection: -9, trust: -7, tension: 18, attachment: -4 };
    case 'apologetic':
      return { affection: 4, trust: 5, tension: -16, attachment: 2 };
    case 'playful':
      return { affection: 3, trust: 1, tension: -3, attachment: 2 };
    default:
      return { affection: 1, trust: 0, tension: -2, attachment: 1 };
  }
}

function scaleDelta(
  delta: { affection: number; trust: number; tension: number; attachment: number },
  text: string,
): { affection: number; trust: number; tension: number; attachment: number } {
  let multiplier = stateSensitivity();
  if (/[!！]{2,}|[?？]{2,}/.test(text)) multiplier += 0.25;
  if (/(特别|真的|超级|超|很|好想|非常|最|一直|必须|不许|讨厌死|烦死)/.test(text)) multiplier += 0.2;
  if (text.length >= 45) multiplier += 0.15;

  return {
    affection: clampDelta(delta.affection * multiplier),
    trust: clampDelta(delta.trust * multiplier),
    tension: clampDelta(delta.tension * multiplier),
    attachment: clampDelta(delta.attachment * multiplier),
  };
}

function clampDelta(value: number): number {
  return Math.max(-28, Math.min(28, Math.round(value)));
}

function deriveMood(affection: number, trust: number, tension: number, attachment: number, tone: Tone): string {
  if (tension >= 70) return 'angry';
  if (tension >= 45) return 'guarded';
  if (tone === 'hurt') return 'concerned';
  if (tone === 'needy' || attachment >= 70) return 'clingy';
  if (affection >= 75 && trust >= 65) return 'warm';
  if (tone === 'flirty' || tone === 'affectionate') return 'soft';
  return 'steady';
}

function buildLastEvent(tone: Tone, text: string): string {
  const shortText = text.trim().replace(/\s+/g, ' ').slice(0, 80);
  return `${describeTone(tone)}：${shortText}`;
}

function describeMood(mood: string): string {
  const map: Record<string, string> = {
    steady: '平稳自然，不主动过度热情',
    soft: '有点心软，语气会更暧昧和亲近',
    warm: '亲近信任，愿意主动关心',
    concerned: '担心对方，优先安抚和追问真实原因',
    clingy: '有点黏人，会希望被回应和被在意',
    guarded: '有点不爽或戒备，先接住话但带一点脾气',
    angry: '明显生气，短句、有边界，但不辱骂不冷暴力',
  };
  return map[mood] || mood;
}

function describeTone(tone: string): string {
  const map: Record<string, string> = {
    affectionate: '表达喜欢或亲近',
    flirty: '暧昧试探',
    trusting: '信任和倾诉',
    needy: '撒娇或求陪伴',
    hurt: '低落委屈',
    angry: '攻击或不满',
    apologetic: '道歉缓和',
    playful: '玩笑调侃',
    neutral: '普通聊天',
  };
  return map[tone] || tone;
}
