/**
 * 角色归属权限校验工具
 *
 * 所有涉及 characterId 的接口在执行前必须先校验角色归属。
 *
 * 当前实现采用两段式校验：
 *   1. 先通过 SELECT id, user_id FROM characters WHERE id = ? 查询角色是否存在
 *   2. 再比较查询结果中的 user_id 与传入的 userId 是否一致
 *
 * 返回策略：
 * - 角色不存在 → 404
 * - 角色存在但 user_id 不匹配 → 403
 * - 参数无效（characterId / userId 缺失或非法） → 400
 */
import { Response } from 'express';
import db from '../db';

interface OwnershipResult {
  ok: boolean;
}

/**
 * 校验角色是否存在且属于指定用户（两段式校验）。
 *
 * 步骤：
 *   1. 查询 characters 表确认角色存在（不存在则返回 404）
 *   2. 比较角色的 user_id 与传入的 userId（不匹配则返回 403）
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
