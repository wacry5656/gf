import db from '../db';
import { callQwenAPI } from './qwen';
import { getEmotionState } from './emotion';
import { getUserIdFromCharacter } from './personality';

interface MilestoneCheck {
  detected: boolean;
  milestone: string;
  detail: string;
}

const MILESTONE_MESSAGE_COUNTS = [100, 500, 1000, 2000, 5000];
const MILESTONE_DAYS = [7, 30, 100, 365];

export function checkMilestone(characterId: number): MilestoneCheck {
  const msgRow = db.prepare(
    'SELECT COUNT(*) as cnt FROM chat_messages WHERE character_id = ?'
  ).get(characterId) as { cnt: number };

  const firstRow = db.prepare(
    'SELECT created_at FROM chat_messages WHERE character_id = ? ORDER BY id ASC LIMIT 1'
  ).get(characterId) as { created_at: string } | undefined;

  if (!firstRow) return { detected: false, milestone: '', detail: '' };

  const daysSince = Math.floor((Date.now() - new Date(firstRow.created_at).getTime()) / 86400000);

  for (const count of MILESTONE_MESSAGE_COUNTS) {
    if (msgRow.cnt === count) {
      return { detected: true, milestone: `msg_${count}`, detail: `你们已经聊了 ${count} 条消息` };
    }
  }

  for (const days of MILESTONE_DAYS) {
    if (daysSince === days) {
      return { detected: true, milestone: `days_${days}`, detail: `你们认识已经 ${days} 天了` };
    }
  }

  return { detected: false, milestone: '', detail: '' };
}

export function wasMilestoneCelebrated(characterId: number, milestone: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM initiative_log WHERE character_id = ? AND trigger_reason = ? LIMIT 1"
  ).get(characterId, `milestone:${milestone}`);
  return !!row;
}

export async function generateMilestoneGreeting(
  characterId: number,
  milestone: string,
  detail: string,
): Promise<string[]> {
  const userId = getUserIdFromCharacter(characterId);
  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(characterId) as any;
  if (!character) return [];

  if (wasMilestoneCelebrated(characterId, milestone)) return [];

  const emotionState = userId ? getEmotionState(userId, characterId) : null;
  const roleGender = character.gender === 'male' ? '男生' : character.gender === 'female' ? '女生' : '人';
  const userGender = character.userGender === 'female' ? '女生' : '男生';
  const relation = character.relationship_mode === 'friend' ? '朋友' : '恋人';
  const moodText = emotionState?.mood === 'happy' ? '很开心' : emotionState?.mood === 'warm' ? '心情不错' : '心情还行';

  const systemPrompt = `你是${character.name}，${roleGender}，和对方（${userGender}）是${relation}关系。你在微信里给人发消息。${detail}，你想自然地提一下这个里程碑。${moodText}。要求：1~2条短消息，像真实的人发现一个值得纪念的时刻时说的话。不要太煽情，不写动作旁白，不用每句都感叹号。`;

  try {
    const raw = await callQwenAPI(
      [{ role: 'system', content: systemPrompt }],
      150,
    );

    const cleaned = raw
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/\*[^*]*\*/g, '')
      .replace(/【[^】]*】/g, '')
      .replace(/^.{1,6}[：:]\s*/gm, '')
      .replace(/\n\s*\n/g, '\n')
      .trim();

    const replies = cleaned
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && l.length <= 42)
      .slice(0, 2);

    if (replies.length === 0) return [];

    const insertAll = db.transaction(() => {
      for (const reply of replies) {
        db.prepare('INSERT INTO chat_messages (character_id, role, content) VALUES (?, ?, ?)')
          .run(characterId, 'assistant', reply);
      }
      db.prepare('INSERT INTO initiative_log (character_id, trigger_reason, content) VALUES (?, ?, ?)')
        .run(characterId, `milestone:${milestone}`, replies.join('\n'));
    });
    insertAll();

    return replies;
  } catch {
    return [];
  }
}
