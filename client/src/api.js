// ====== 认证 ======
export async function register(username, password) {
    const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok)
        throw new Error(data.error || '注册失败');
    return data;
}
export async function login(username, password) {
    const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok)
        throw new Error(data.error || '登录失败');
    return data;
}
// ====== 聊天 ======
export async function sendMessage(character, messages, userId) {
    const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character, messages, characterId: character.id, userId }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `请求失败 (${res.status})`);
    }
    const data = await res.json();
    return data.replies || [data.reply];
}
// ====== 角色数据 ======
export async function getCharacters(userId) {
    const res = await fetch(`/api/data/characters?userId=${userId}`);
    const data = await res.json();
    if (!res.ok)
        throw new Error(data.error || '获取角色失败');
    return data.characters;
}
export async function createCharacter(userId, char) {
    const res = await fetch('/api/data/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, ...char }),
    });
    const data = await res.json();
    if (!res.ok)
        throw new Error(data.error || '创建角色失败');
    return data.characterId;
}
export async function deleteCharacter(characterId, userId) {
    const res = await fetch(`/api/data/characters/${characterId}?userId=${userId}`, { method: 'DELETE' });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '删除角色失败');
    }
}
// ====== 聊天记录 ======
export async function getMessages(characterId, userId) {
    const res = await fetch(`/api/data/messages/${characterId}?userId=${userId}`);
    const data = await res.json();
    if (!res.ok)
        throw new Error(data.error || '获取消息失败');
    return data.messages;
}
export async function saveMessage(characterId, role, content, userId) {
    const res = await fetch('/api/data/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterId, role, content, userId }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '保存消息失败');
    }
}
export async function clearMessages(characterId, userId) {
    const res = await fetch(`/api/data/messages/${characterId}?userId=${userId}`, { method: 'DELETE' });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '清空消息失败');
    }
}
export async function getEmotion(characterId, userId) {
    try {
        const res = await fetch(`/api/data/emotion/${characterId}?userId=${userId}`);
        if (!res.ok)
            return null;
        return await res.json();
    }
    catch {
        return null;
    }
}
export async function getRelationship(characterId, userId) {
    try {
        const res = await fetch(`/api/data/relationship/${characterId}?userId=${userId}`);
        if (!res.ok)
            return null;
        return await res.json();
    }
    catch {
        return null;
    }
}
// ====== 流式聊天 ======
export async function sendMessageStream(character, messages, onDelta, userId) {
    const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character, messages, characterId: character.id, userId }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `请求失败 (${res.status})`);
    }
    if (!res.body) {
        throw new Error('响应体为空');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let replies = [];
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: '))
                continue;
            const data = trimmed.slice(6).trim();
            if (data === '[DONE]')
                continue;
            try {
                const parsed = JSON.parse(data);
                if (parsed.delta)
                    onDelta(parsed.delta);
                if (parsed.replies)
                    replies = parsed.replies;
                if (parsed.error)
                    throw new Error(parsed.error);
            }
            catch (e) {
                // Only rethrow application errors, not JSON parse errors from partial SSE chunks
                if (e instanceof SyntaxError)
                    continue;
                throw e;
            }
        }
    }
    return replies;
}
