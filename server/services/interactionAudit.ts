export type RelationshipMode = 'lover' | 'friend';

export interface InteractionAudit {
  normalized: string;
  isTooShort: boolean;
  isQuestion: boolean;
  intimateExpression: boolean;
  reassuranceSeeking: boolean;
  caring: boolean;
  repair: boolean;
  commitment: boolean;
  cold: boolean;
  attack: boolean;
  thirdParty: boolean;
  partnerConflict: boolean;
  positiveScore: number;
  negativeScore: number;
  canIncreaseBond: boolean;
  primaryEvent: string | null;
}

const INTIMATE_KEYWORDS = ['想你', '抱抱', '亲亲', '爱你', '宝宝', '老婆', '老公', '乖', '宝贝', '贴贴', 'mua', '陪我', '想我'];
const COLD_KEYWORDS = ['随便', '算了', '滚', '闭嘴', '烦死了', '别吵', '懒得理你', '无所谓', '不想理你', '别烦我'];
const ATTACK_KEYWORDS = ['滚', '闭嘴', '烦死了', '别吵', '懒得理你', '别烦我', '你有病', '神经病', '讨厌你', '不喜欢你', '删了你'];
const THIRD_PARTY_KEYWORDS = ['我陪别人', '别的女生', '别的男生', '另一个女的', '另一个男的', '别人更好', '她比你好', '他比你好', '前任', '前女友', '前男友'];
const CARING_PATTERNS = [
  /你.{0,4}(没事吧|还好吗|累不累|饿不饿|疼不疼|冷不冷)/,
  /(别难过|别怕|别担心|别哭|辛苦了|心疼你|照顾你)/,
  /(我陪你|有我在|我在这|我会在|我听你说)/,
];
const REPAIR_PATTERNS = [
  /(对不起|抱歉|我错了|刚才不该|是我不好|别生气)/,
  /(我们好好说|我会改|下次不会|以后不会|我认真听)/,
];
const COMMITMENT_PATTERNS = [
  /(我会|我想|我愿意).{0,8}(陪你|认真|负责|好好|一直|留下|在一起)/,
  /(不会|不想).{0,8}(丢下你|离开你|敷衍你|骗你)/,
  /(只想和你|认真和你|好好和你)/,
];
const REASSURANCE_PATTERNS = [
  /(想我了吗|想我没|有没有想我|是不是想我)/,
  /(爱不爱我|喜欢我吗|在不在乎我|我重要吗|会不会离开我|是不是不要我)/,
];
const PARTNER_CONFLICT_PATTERN = /(我|本人|老子|这边|现在).{0,4}(有|找了|交了|谈了).{0,3}(女朋友|男朋友|对象)|我.{0,3}(女朋友|男朋友|对象)|我的.{0,3}(女朋友|男朋友|对象)|不是你.{0,6}(女朋友|男朋友|对象)|你不是.{0,6}(女朋友|男朋友|对象)|分手|不要你了|不想和你谈|换一个/;

export function containsAny(text: string, keywords: string[]): boolean {
  return keywords.some(k => text.includes(k));
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

function hasEnoughContext(text: string): boolean {
  if (text.length >= 12) return true;
  return /(今天|刚才|以后|下次|现在|因为|所以|这件事|认真|好好|一直|不会|愿意)/.test(text);
}

export function auditInteraction(input: string, relationshipMode: RelationshipMode): InteractionAudit {
  const normalized = input.replace(/\s+/g, '');
  const trimmed = input.trim();
  const isTooShort = trimmed.length <= 1;
  const isQuestion = /[?？吗呢呀]$/.test(normalized) || /(是不是|有没有|会不会|能不能)/.test(normalized);

  const reassuranceSeeking = relationshipMode === 'lover' && matchesAny(normalized, REASSURANCE_PATTERNS);
  const intimateExpression = relationshipMode === 'lover' && containsAny(normalized, INTIMATE_KEYWORDS);
  const partnerConflict = relationshipMode === 'lover' && PARTNER_CONFLICT_PATTERN.test(normalized);
  const thirdParty = relationshipMode === 'lover' && (containsAny(normalized, THIRD_PARTY_KEYWORDS) || partnerConflict);
  const cold = !isTooShort && containsAny(normalized, COLD_KEYWORDS);
  const attack = !isTooShort && (containsAny(normalized, ATTACK_KEYWORDS) || /分手|不要你了|不想和你谈/.test(normalized));
  const caring = matchesAny(normalized, CARING_PATTERNS);
  const repair = matchesAny(normalized, REPAIR_PATTERNS);
  const commitment = relationshipMode === 'lover' && matchesAny(normalized, COMMITMENT_PATTERNS);

  let positiveScore = 0;
  if (caring) positiveScore += 0.9;
  if (repair) positiveScore += 1.1;
  if (commitment) positiveScore += 1.0;
  if (hasEnoughContext(normalized) && positiveScore > 0) positiveScore += 0.45;
  if (isQuestion && !repair) positiveScore -= 0.35;
  if (intimateExpression && !caring && !repair && !commitment) positiveScore = Math.min(positiveScore, 0.2);
  if (reassuranceSeeking) positiveScore = 0;

  let negativeScore = 0;
  if (partnerConflict) negativeScore += 2.1;
  else if (thirdParty) negativeScore += 0.8;
  if (attack) negativeScore += 1.1;
  else if (cold) negativeScore += 0.65;

  const canIncreaseBond = positiveScore >= 1.25 && negativeScore === 0 && !reassuranceSeeking;
  let primaryEvent: string | null = null;
  if (partnerConflict) primaryEvent = '关系冲突';
  else if (thirdParty) primaryEvent = '第三者话题';
  else if (attack || cold) primaryEvent = '冷淡或攻击互动';
  else if (canIncreaseBond && repair) primaryEvent = '修复关系';
  else if (canIncreaseBond && caring) primaryEvent = '被关心安慰';
  else if (canIncreaseBond && commitment) primaryEvent = '稳定承诺';
  else if (reassuranceSeeking) primaryEvent = '索取确认';
  else if (intimateExpression) primaryEvent = '亲密表达';

  return {
    normalized,
    isTooShort,
    isQuestion,
    intimateExpression,
    reassuranceSeeking,
    caring,
    repair,
    commitment,
    cold,
    attack,
    thirdParty,
    partnerConflict,
    positiveScore: Math.max(0, positiveScore),
    negativeScore,
    canIncreaseBond,
    primaryEvent,
  };
}
