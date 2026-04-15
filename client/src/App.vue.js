/// <reference types="../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref, onMounted } from 'vue';
import { getCharacters, createCharacter, deleteCharacter, getMessages } from './api';
import LoginPage from './components/LoginPage.vue';
import CharacterSetup from './components/CharacterSetup.vue';
import ChatWindow from './components/ChatWindow.vue';
const user = ref(null);
const characters = ref([]);
const activeCharacter = ref(null);
const chatMessages = ref([]);
const showNewCharacter = ref(false);
const loading = ref(false);
// 初始化：检查本地存储的登录信息
onMounted(() => {
    const saved = localStorage.getItem('user');
    if (saved) {
        try {
            user.value = JSON.parse(saved);
            loadCharacters();
        }
        catch (e) {
            console.error('[App] 解析本地用户数据失败:', e);
        }
    }
});
function onLogin(u) {
    user.value = u;
    localStorage.setItem('user', JSON.stringify(u));
    loadCharacters();
}
function onLogout() {
    user.value = null;
    activeCharacter.value = null;
    chatMessages.value = [];
    characters.value = [];
    showNewCharacter.value = false;
    localStorage.removeItem('user');
}
async function loadCharacters() {
    if (!user.value)
        return;
    loading.value = true;
    try {
        characters.value = await getCharacters(user.value.userId);
    }
    catch (e) {
        console.error(e);
    }
    finally {
        loading.value = false;
    }
}
async function onCharacterConfirm(char) {
    if (!user.value)
        return;
    try {
        const charId = await createCharacter(user.value.userId, char);
        char.id = charId;
        characters.value.unshift(char);
        showNewCharacter.value = false;
        await selectCharacter(char);
    }
    catch (e) {
        console.error(e);
    }
}
async function selectCharacter(char) {
    activeCharacter.value = char;
    chatMessages.value = [];
    if (char.id && user.value) {
        try {
            chatMessages.value = await getMessages(char.id, user.value.userId);
        }
        catch (e) {
            console.error('[App] 加载历史消息失败:', e);
        }
    }
}
async function onDeleteCharacter(char) {
    if (!char.id || !user.value)
        return;
    try {
        await deleteCharacter(char.id, user.value.userId);
        // 删除成功后，重新请求角色列表而非只做本地过滤
        if (activeCharacter.value?.id === char.id) {
            activeCharacter.value = null;
            chatMessages.value = [];
        }
        await loadCharacters();
    }
    catch (e) {
        console.error(e);
        alert(e.message || '删除角色失败，请重试');
    }
}
function goBack() {
    activeCharacter.value = null;
    chatMessages.value = [];
}
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['app-header']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-header']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-logout']} */ ;
/** @type {__VLS_StyleScopedClasses['char-list-header']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-primary-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['char-card']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-delete']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "app-container" },
});
/** @type {__VLS_StyleScopedClasses['app-container']} */ ;
if (!__VLS_ctx.user) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
        ...{ class: "app-header" },
    });
    /** @type {__VLS_StyleScopedClasses['app-header']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.h1, __VLS_intrinsics.h1)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.main, __VLS_intrinsics.main)({
        ...{ class: "app-main" },
    });
    /** @type {__VLS_StyleScopedClasses['app-main']} */ ;
    const __VLS_0 = LoginPage;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
        ...{ 'onLogin': {} },
    }));
    const __VLS_2 = __VLS_1({
        ...{ 'onLogin': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_1));
    let __VLS_5;
    const __VLS_6 = ({ login: {} },
        { onLogin: (__VLS_ctx.onLogin) });
    var __VLS_3;
    var __VLS_4;
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
        ...{ class: "app-header" },
    });
    /** @type {__VLS_StyleScopedClasses['app-header']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.h1, __VLS_intrinsics.h1)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "header-right" },
    });
    /** @type {__VLS_StyleScopedClasses['header-right']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "user-info" },
    });
    /** @type {__VLS_StyleScopedClasses['user-info']} */ ;
    (__VLS_ctx.user.username);
    if (__VLS_ctx.activeCharacter) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.goBack) },
            ...{ class: "btn-header" },
        });
        /** @type {__VLS_StyleScopedClasses['btn-header']} */ ;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.onLogout) },
        ...{ class: "btn-header btn-logout" },
    });
    /** @type {__VLS_StyleScopedClasses['btn-header']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-logout']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.main, __VLS_intrinsics.main)({
        ...{ class: "app-main" },
    });
    /** @type {__VLS_StyleScopedClasses['app-main']} */ ;
    if (__VLS_ctx.showNewCharacter) {
        const __VLS_7 = CharacterSetup;
        // @ts-ignore
        const __VLS_8 = __VLS_asFunctionalComponent1(__VLS_7, new __VLS_7({
            ...{ 'onConfirm': {} },
        }));
        const __VLS_9 = __VLS_8({
            ...{ 'onConfirm': {} },
        }, ...__VLS_functionalComponentArgsRest(__VLS_8));
        let __VLS_12;
        const __VLS_13 = ({ confirm: {} },
            { onConfirm: (__VLS_ctx.onCharacterConfirm) });
        var __VLS_10;
        var __VLS_11;
    }
    else if (__VLS_ctx.activeCharacter) {
        const __VLS_14 = ChatWindow;
        // @ts-ignore
        const __VLS_15 = __VLS_asFunctionalComponent1(__VLS_14, new __VLS_14({
            character: (__VLS_ctx.activeCharacter),
            userId: (__VLS_ctx.user.userId),
            messages: (__VLS_ctx.chatMessages),
        }));
        const __VLS_16 = __VLS_15({
            character: (__VLS_ctx.activeCharacter),
            userId: (__VLS_ctx.user.userId),
            messages: (__VLS_ctx.chatMessages),
        }, ...__VLS_functionalComponentArgsRest(__VLS_15));
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "char-list-container" },
        });
        /** @type {__VLS_StyleScopedClasses['char-list-container']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "char-list-header" },
        });
        /** @type {__VLS_StyleScopedClasses['char-list-header']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h2, __VLS_intrinsics.h2)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!!(!__VLS_ctx.user))
                        return;
                    if (!!(__VLS_ctx.showNewCharacter))
                        return;
                    if (!!(__VLS_ctx.activeCharacter))
                        return;
                    __VLS_ctx.showNewCharacter = true;
                    // @ts-ignore
                    [user, user, user, onLogin, activeCharacter, activeCharacter, activeCharacter, goBack, onLogout, showNewCharacter, showNewCharacter, onCharacterConfirm, chatMessages,];
                } },
            ...{ class: "btn-primary-sm" },
        });
        /** @type {__VLS_StyleScopedClasses['btn-primary-sm']} */ ;
        if (__VLS_ctx.loading) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "char-loading" },
            });
            /** @type {__VLS_StyleScopedClasses['char-loading']} */ ;
        }
        else if (__VLS_ctx.characters.length === 0) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "char-empty" },
            });
            /** @type {__VLS_StyleScopedClasses['char-empty']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({});
        }
        else {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "char-grid" },
            });
            /** @type {__VLS_StyleScopedClasses['char-grid']} */ ;
            for (const [char] of __VLS_vFor((__VLS_ctx.characters))) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ onClick: (...[$event]) => {
                            if (!!(!__VLS_ctx.user))
                                return;
                            if (!!(__VLS_ctx.showNewCharacter))
                                return;
                            if (!!(__VLS_ctx.activeCharacter))
                                return;
                            if (!!(__VLS_ctx.loading))
                                return;
                            if (!!(__VLS_ctx.characters.length === 0))
                                return;
                            __VLS_ctx.selectCharacter(char);
                            // @ts-ignore
                            [loading, characters, characters, selectCharacter,];
                        } },
                    key: (char.id),
                    ...{ class: "char-card" },
                });
                /** @type {__VLS_StyleScopedClasses['char-card']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "char-avatar" },
                });
                /** @type {__VLS_StyleScopedClasses['char-avatar']} */ ;
                (char.gender === 'female' ? '👧' : char.gender === 'male' ? '👦' : '🧑');
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "char-info" },
                });
                /** @type {__VLS_StyleScopedClasses['char-info']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "char-name" },
                });
                /** @type {__VLS_StyleScopedClasses['char-name']} */ ;
                (char.name);
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "char-desc" },
                });
                /** @type {__VLS_StyleScopedClasses['char-desc']} */ ;
                (char.personality);
                __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                    ...{ onClick: (...[$event]) => {
                            if (!!(!__VLS_ctx.user))
                                return;
                            if (!!(__VLS_ctx.showNewCharacter))
                                return;
                            if (!!(__VLS_ctx.activeCharacter))
                                return;
                            if (!!(__VLS_ctx.loading))
                                return;
                            if (!!(__VLS_ctx.characters.length === 0))
                                return;
                            __VLS_ctx.onDeleteCharacter(char);
                            // @ts-ignore
                            [onDeleteCharacter,];
                        } },
                    ...{ class: "btn-delete" },
                    title: "删除角色",
                });
                /** @type {__VLS_StyleScopedClasses['btn-delete']} */ ;
                // @ts-ignore
                [];
            }
        }
    }
}
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
