/// <reference types="../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref } from 'vue';
import { login, register } from '../api';
const emit = defineEmits();
const isRegister = ref(false);
const username = ref('');
const password = ref('');
const confirmPassword = ref('');
const error = ref('');
const loading = ref(false);
async function submit() {
    error.value = '';
    const u = username.value.trim();
    const p = password.value;
    if (!u || !p) {
        error.value = '请填写用户名和密码';
        return;
    }
    if (isRegister.value) {
        if (p !== confirmPassword.value) {
            error.value = '两次密码不一致';
            return;
        }
    }
    loading.value = true;
    try {
        let user;
        if (isRegister.value) {
            user = await register(u, p);
        }
        else {
            user = await login(u, p);
        }
        emit('login', user);
    }
    catch (e) {
        error.value = e.message || '操作失败';
    }
    finally {
        loading.value = false;
    }
}
function toggleMode() {
    isRegister.value = !isRegister.value;
    error.value = '';
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
/** @type {__VLS_StyleScopedClasses['auth-card']} */ ;
/** @type {__VLS_StyleScopedClasses['field']} */ ;
/** @type {__VLS_StyleScopedClasses['field']} */ ;
/** @type {__VLS_StyleScopedClasses['field']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['toggle-link']} */ ;
/** @type {__VLS_StyleScopedClasses['toggle-link']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "auth-container" },
});
/** @type {__VLS_StyleScopedClasses['auth-container']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "auth-card" },
});
/** @type {__VLS_StyleScopedClasses['auth-card']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h2, __VLS_intrinsics.h2)({});
(__VLS_ctx.isRegister ? '注册账号' : '登录');
__VLS_asFunctionalElement1(__VLS_intrinsics.form, __VLS_intrinsics.form)({
    ...{ onSubmit: (__VLS_ctx.submit) },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "field" },
});
/** @type {__VLS_StyleScopedClasses['field']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
__VLS_asFunctionalElement1(__VLS_intrinsics.input)({
    placeholder: "请输入用户名",
    maxlength: "20",
    autofocus: true,
});
(__VLS_ctx.username);
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "field" },
});
/** @type {__VLS_StyleScopedClasses['field']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
__VLS_asFunctionalElement1(__VLS_intrinsics.input)({
    type: "password",
    placeholder: "请输入密码",
});
(__VLS_ctx.password);
if (__VLS_ctx.isRegister) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "field" },
    });
    /** @type {__VLS_StyleScopedClasses['field']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        type: "password",
        placeholder: "再次输入密码",
    });
    (__VLS_ctx.confirmPassword);
}
if (__VLS_ctx.error) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "error-msg" },
    });
    /** @type {__VLS_StyleScopedClasses['error-msg']} */ ;
    (__VLS_ctx.error);
}
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    type: "submit",
    ...{ class: "btn-primary" },
    disabled: (__VLS_ctx.loading),
});
/** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
(__VLS_ctx.loading ? '处理中...' : (__VLS_ctx.isRegister ? '注册' : '登录'));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "toggle-link" },
});
/** @type {__VLS_StyleScopedClasses['toggle-link']} */ ;
if (__VLS_ctx.isRegister) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.a, __VLS_intrinsics.a)({
        ...{ onClick: (__VLS_ctx.toggleMode) },
        href: "#",
    });
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.a, __VLS_intrinsics.a)({
        ...{ onClick: (__VLS_ctx.toggleMode) },
        href: "#",
    });
}
// @ts-ignore
[isRegister, isRegister, isRegister, isRegister, submit, username, password, confirmPassword, error, error, loading, loading, toggleMode, toggleMode,];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
});
export default {};
