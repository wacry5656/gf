/**
 * 角色归属权限校验工具
 *
 * 所有涉及 characterId 的接口在执行前必须先校验：
 *   SELECT id FROM characters WHERE id = ? AND user_id = ?
 *
 * - 不存在 → 404
 * - user_id 不匹配 → 403
 */
import { Response } from 'express';
import db from '../db';

interface OwnershipResult {
  ok: boolean;
}

/**
 * 校验角色是否存在且属于指定用户。
 *
 * 校验失败时自动向 res 写入错误响应并返回 { ok: false }。
 * 调用方在 ok === false 时应立即 return，不再执行后续逻辑。
 */
export function ensureCharacterOwnership(
  characterId: number,
  userId: number,
  res: Response
): OwnershipResult {
  if (!characterId || isNaN(characterId)) {
    res.status(400).json({ error: '无效的角色 ID' });
    return { ok: false };
  }
  if (!userId || isNaN(userId)) {
    res.status(400).json({ error: '缺少 userId 参数' });
    return { ok: false };
  }

  const character = db
    .prepare('SELECT id, user_id FROM characters WHERE id = ?')
    .get(characterId) as { id: number; user_id: number } | undefined;

  if (!character) {
    res.status(404).json({ error: '角色不存在' });
    return { ok: false };
  }

  if (character.user_id !== userId) {
    res.status(403).json({ error: '无权操作该角色' });
    return { ok: false };
  }

  return { ok: true };
}
