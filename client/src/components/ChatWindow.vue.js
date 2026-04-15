/// <reference types="../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref, nextTick, watch, onMounted } from 'vue';
import { sendMessageStream, saveMessage, clearMessages, getEmotion, getRelationship } from '../api';
const props = defineProps();
const emit = defineEmits();
const inputText = ref('');
const loading = ref(false);
const streaming = ref(false);
const error = ref('');
const chatBody = ref(null);
const moodLabel = ref('');
const phaseLabel = ref('');
async function fetchEmotion() {
    if (!props.character?.id || !props.userId) {
        moodLabel.value = '';
        return;
    }
    const info = await getEmotion(props.character.id, props.userId);
    if (info)
        moodLabel.value = info.moodLabel;
    else
        moodLabel.value = '';
}
async function fetchRelationship() {
    if (!props.character?.id || !props.userId) {
        phaseLabel.value = '';
        return;
    }
    const info = await getRelationship(props.character.id, props.userId);
    if (info)
        phaseLabel.value = info.phaseLabel;
    else
        phaseLabel.value = '';
}
async function fetchStatus() {
    await Promise.all([fetchEmotion(), fetchRelationship()]);
}
onMounted(fetchStatus);
watch(() => props.character?.id, fetchStatus);
watch(() => props.userId, fetchStatus);
function scrollToBottom() {
    nextTick(() => {
        if (chatBody.value) {
            chatBody.value.scrollTop = chatBody.value.scrollHeight;
        }
    });
}
watch(() => props.messages.length, scrollToBottom);
async function send() {
    const text = inputText.value.trim();
    if (!text || loading.value)
        return;
    error.value = '';
    const userMsg = { role: 'user', content: text };
    const updated = [...props.messages, userMsg];
    emit('update:messages', updated);
    inputText.value = '';
    loading.value = true;
    streaming.value = false;
    // 保存用户消息到数据库
    if (props.character.id) {
        saveMessage(props.character.id, 'user', text, props.userId).catch((e) => {
            console.error('[ChatWindow] 保存用户消息失败:', e);
        });
    }
    try {
        let streamContent = '';
        const replies = await sendMessageStream(props.character, updated, (delta) => {
            if (!streaming.value) {
                // First chunk: switch from "思考中..." to streaming display
                streaming.value = true;
            }
            streamContent += delta;
            emit('update:messages', [
                ...updated,
                { role: 'assistant', content: streamContent }
            ]);
            scrollToBottom();
        }, props.userId);
        // Replace streaming message with cleaned/split replies
        if (replies.length > 0) {
            const finalMessages = [...updated];
            for (const reply of replies) {
                finalMessages.push({ role: 'assistant', content: reply });
            }
            emit('update:messages', finalMessages);
        }
        else if (streamContent) {
            // Fallback: no split replies received, use raw stream content
            emit('update:messages', [...updated, { role: 'assistant', content: streamContent }]);
        }
        // AI 回复由服务端兜底保存，前端不再重复保存
        // 刷新情绪和关系标签
        fetchStatus();
    }
    catch (e) {
        error.value = e.message || '发送失败';
        // Remove placeholder on error
        emit('update:messages', updated);
    }
    finally {
        loading.value = false;
        streaming.value = false;
    }
}
async function onClearHistory() {
    if (!props.character.id)
        return;
    try {
        await clearMessages(props.character.id, props.userId);
        emit('update:messages', []);
    }
    catch {
        error.value = '清空失败';
    }
}
function handleKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
    }
}
const __VLS_ctx = {
    ...{},
    ...{},
    ...{},
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['btn-clear']} */ ;
/** @type {__VLS_StyleScopedClasses['message-user']} */ ;
/** @type {__VLS_StyleScopedClasses['message-label']} */ ;
/** @type {__VLS_StyleScopedClasses['message-user']} */ ;
/** @type {__VLS_StyleScopedClasses['message-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['message-assistant']} */ ;
/** @type {__VLS_StyleScopedClasses['message-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-input-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-input-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-send']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-send']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "chat-container" },
});
/** @type {__VLS_StyleScopedClasses['chat-container']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "chat-info" },
});
/** @type {__VLS_StyleScopedClasses['chat-info']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({});
(__VLS_ctx.character.name);
if (__VLS_ctx.moodLabel) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "emotion-tag" },
    });
    /** @type {__VLS_StyleScopedClasses['emotion-tag']} */ ;
    (__VLS_ctx.moodLabel);
}
if (__VLS_ctx.phaseLabel) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "relation-tag" },
    });
    /** @type {__VLS_StyleScopedClasses['relation-tag']} */ ;
    (__VLS_ctx.phaseLabel);
}
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "chat-personality" },
});
/** @type {__VLS_StyleScopedClasses['chat-personality']} */ ;
(__VLS_ctx.character.personality);
if (__VLS_ctx.messages.length > 0) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.onClearHistory) },
        ...{ class: "btn-clear" },
    });
    /** @type {__VLS_StyleScopedClasses['btn-clear']} */ ;
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "chat-body" },
    ref: "chatBody",
});
/** @type {__VLS_StyleScopedClasses['chat-body']} */ ;
if (__VLS_ctx.messages.length === 0) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "chat-empty" },
    });
    /** @type {__VLS_StyleScopedClasses['chat-empty']} */ ;
    (__VLS_ctx.character.name);
}
for (const [msg, i] of __VLS_vFor((__VLS_ctx.messages))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        key: (i),
        ...{ class: ([
                'message',
                msg.role === 'user' ? 'message-user' : 'message-assistant',
                i > 0 && __VLS_ctx.messages[i - 1].role === msg.role ? 'message-consecutive' : ''
            ]) },
    });
    /** @type {__VLS_StyleScopedClasses['message']} */ ;
    if (!(i > 0 && __VLS_ctx.messages[i - 1].role === msg.role)) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "message-label" },
        });
        /** @type {__VLS_StyleScopedClasses['message-label']} */ ;
        (msg.role === 'user' ? '你' : __VLS_ctx.character.name);
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "message-bubble" },
    });
    /** @type {__VLS_StyleScopedClasses['message-bubble']} */ ;
    (msg.content);
    // @ts-ignore
    [character, character, character, character, moodLabel, moodLabel, phaseLabel, phaseLabel, messages, messages, messages, messages, messages, onClearHistory,];
}
if (__VLS_ctx.loading && !__VLS_ctx.streaming) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "message message-assistant" },
    });
    /** @type {__VLS_StyleScopedClasses['message']} */ ;
    /** @type {__VLS_StyleScopedClasses['message-assistant']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "message-label" },
    });
    /** @type {__VLS_StyleScopedClasses['message-label']} */ ;
    (__VLS_ctx.character.name);
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "message-bubble typing" },
    });
    /** @type {__VLS_StyleScopedClasses['message-bubble']} */ ;
    /** @type {__VLS_StyleScopedClasses['typing']} */ ;
}
if (__VLS_ctx.error) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "chat-error" },
    });
    /** @type {__VLS_StyleScopedClasses['chat-error']} */ ;
    (__VLS_ctx.error);
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "chat-input-bar" },
});
/** @type {__VLS_StyleScopedClasses['chat-input-bar']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.textarea, __VLS_intrinsics.textarea)({
    ...{ onKeydown: (__VLS_ctx.handleKeydown) },
    value: (__VLS_ctx.inputText),
    placeholder: "输入消息... (Enter 发送)",
    rows: "1",
    disabled: (__VLS_ctx.loading),
});
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.send) },
    disabled: (__VLS_ctx.loading || !__VLS_ctx.inputText.trim()),
    ...{ class: "btn-send" },
});
/** @type {__VLS_StyleScopedClasses['btn-send']} */ ;
(__VLS_ctx.loading ? '...' : '发送');
// @ts-ignore
[character, loading, loading, loading, loading, streaming, error, error, handleKeydown, inputText, inputText, send,];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
    __typeProps: {},
});
export default {};
