/// <reference types="../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { reactive } from 'vue';
const emit = defineEmits();
const presetPersonalities = [
    '温柔体贴、善解人意',
    '活泼开朗、古灵精怪',
    '高冷傲娇、口是心非',
    '知性优雅、博学多才',
    '元气少女、天真烂漫',
    '成熟稳重、可靠温暖',
];
const form = reactive({
    name: '',
    gender: 'female',
    personality: presetPersonalities[0],
    customPersonality: '',
    useCustom: false,
    description: '',
});
function submit() {
    if (!form.name.trim())
        return;
    const personality = form.useCustom
        ? form.customPersonality.trim()
        : form.personality;
    if (!personality)
        return;
    emit('confirm', {
        name: form.name.trim(),
        gender: form.gender,
        personality,
        description: form.description.trim() || (form.gender === 'female'
            ? '你是用户的女朋友，你们正在恋爱中，日常聊天温馨甜蜜'
            : form.gender === 'male'
                ? '你是用户的男朋友，你们正在恋爱中，日常聊天温馨甜蜜'
                : '你是用户的亲密伙伴，你们关系很好'),
    });
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
/** @type {__VLS_StyleScopedClasses['setup-card']} */ ;
/** @type {__VLS_StyleScopedClasses['field']} */ ;
/** @type {__VLS_StyleScopedClasses['toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['radio-group']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "setup-container" },
});
/** @type {__VLS_StyleScopedClasses['setup-container']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "setup-card" },
});
/** @type {__VLS_StyleScopedClasses['setup-card']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h2, __VLS_intrinsics.h2)({});
__VLS_asFunctionalElement1(__VLS_intrinsics.form, __VLS_intrinsics.form)({
    ...{ onSubmit: (__VLS_ctx.submit) },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "field" },
});
/** @type {__VLS_StyleScopedClasses['field']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
__VLS_asFunctionalElement1(__VLS_intrinsics.input)({
    placeholder: "给角色起个名字...",
    maxlength: "20",
    required: true,
});
(__VLS_ctx.form.name);
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "field" },
});
/** @type {__VLS_StyleScopedClasses['field']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "radio-group" },
});
/** @type {__VLS_StyleScopedClasses['radio-group']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
__VLS_asFunctionalElement1(__VLS_intrinsics.input)({
    type: "radio",
    value: "female",
});
(__VLS_ctx.form.gender);
__VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
__VLS_asFunctionalElement1(__VLS_intrinsics.input)({
    type: "radio",
    value: "male",
});
(__VLS_ctx.form.gender);
__VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
__VLS_asFunctionalElement1(__VLS_intrinsics.input)({
    type: "radio",
    value: "other",
});
(__VLS_ctx.form.gender);
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "field" },
});
/** @type {__VLS_StyleScopedClasses['field']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.form.useCustom = !__VLS_ctx.form.useCustom;
            // @ts-ignore
            [submit, form, form, form, form, form, form,];
        } },
    ...{ class: "toggle" },
});
/** @type {__VLS_StyleScopedClasses['toggle']} */ ;
(__VLS_ctx.form.useCustom ? '选择预设 ▾' : '自定义 ✎');
if (!__VLS_ctx.form.useCustom) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
        value: (__VLS_ctx.form.personality),
    });
    for (const [p] of __VLS_vFor((__VLS_ctx.presetPersonalities))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            key: (p),
            value: (p),
        });
        (p);
        // @ts-ignore
        [form, form, form, presetPersonalities,];
    }
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        placeholder: "输入自定义性格描述词...",
        maxlength: "100",
    });
    (__VLS_ctx.form.customPersonality);
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "field" },
});
/** @type {__VLS_StyleScopedClasses['field']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "optional" },
});
/** @type {__VLS_StyleScopedClasses['optional']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.textarea, __VLS_intrinsics.textarea)({
    value: (__VLS_ctx.form.description),
    placeholder: "描述角色的背景、说话风格等...",
    rows: "3",
    maxlength: "300",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    type: "submit",
    ...{ class: "btn-primary" },
});
/** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
// @ts-ignore
[form, form,];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
});
export default {};
