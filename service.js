import { KEY, apiRequest, captureTarget, createImageId, extractImage, readJson, resolveTargetIndex, targetStillValid, validateSettings } from './core.js';
import {
    buildMemoryDiffMessages, buildMemorySummaryMessages, buildPrompt, describeMemory, extractChatText,
    memoryConnection, memoryRequest, mergeEntries, normalizeMemory, parseAppearance, parseMemoryDiff,
    speakerNames, userIdentities, validateMemorySettings,
} from './memory.js';

export class TargetChangedError extends Error {
    constructor() { super('原聊天或楼层已变化，图片已保留。可下载，或手动插入当前选择的楼层。'); this.name = 'TargetChangedError'; }
}

export function createService(getContext, fetchImpl = fetch) {
    return {
        // 生图：档案在这里被快照，所以形象总结/diff 与生图互不阻塞，
        // 本次请求用的是"点下按钮那一刻"的档案。
        async generate(settings, requestedIndex, signal, memory = null) {
            validateSettings(settings);
            const context = getContext();
            const index = resolveTargetIndex(context.chat, requestedIndex);
            const target = captureTarget(context, index);
            const { prompt, count } = buildPrompt(context, settings, index, memory);
            const requestHeaders = context.getRequestHeaders();
            const body = await apiRequest(settings, 'generate', { signal, prompt, fetchImpl, requestHeaders });
            const image = await extractImage(body, { signal, fetchImpl, settings, requestHeaders });
            return { id: createImageId(), image, target, count, model: settings.model, url: null, boundTarget: null, saved: false };
        },
        // 总结请求：给最近 N 层，让模型产出完整的角色形象档案。
        async summarize(settings, signal) {
            const connection = validateMemorySettings(settings);
            const context = getContext();
            const { messages, index, count } = buildMemorySummaryMessages(context, settings);
            const body = await memoryRequest(settings, { messages, signal, fetchImpl, requestHeaders: context.getRequestHeaders() });
            const entries = parseAppearance(extractChatText(body), { exclude: userIdentities(context), speakers: speakerNames(context.chat) });
            return { entries, index, count, model: connection.model, kind: 'summary' };
        },
        // diff 请求：只用最新一层回复对比现有档案，返回 NoUpdate 表示不需要改动。
        async diff(settings, memory, signal) {
            const connection = validateMemorySettings(settings);
            const context = getContext();
            const { messages, index, text } = buildMemoryDiffMessages(context, settings, memory);
            const body = await memoryRequest(settings, { messages, signal, fetchImpl, requestHeaders: context.getRequestHeaders() });
            const result = parseMemoryDiff(extractChatText(body), { exclude: userIdentities(context), speakers: speakerNames(context.chat) });
            if (!result.updated) return { updated: false, entries: {}, index, text, model: connection.model, kind: 'diff' };
            const entries = mergeEntries(normalizeMemory(memory).entries, result.entries);
            return { updated: true, entries, changed: Object.keys(result.entries), index, text, model: connection.model, kind: 'diff' };
        },
        describeMemory,
        async persist(result, signal) {
            if (result.url) return result.url;
            const folder = result.target.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'Tavern';
            const response = await fetchImpl('/api/images/upload', {
                method: 'POST', headers: getContext().getRequestHeaders(), signal,
                body: JSON.stringify({ image: result.image.base64, format: result.image.format, ch_name: folder, filename: `tavern-image-${result.id}` }),
            });
            const body = await readJson(response);
            if (typeof body.path !== 'string' || !body.path || /^(?:[a-z]+:|\/\/)/i.test(body.path) || body.path.includes('\\')) throw new Error('酒馆返回的图片保存路径无效。');
            result.url = body.path;
            return result.url;
        },
        async attach(result, target = result.boundTarget || result.target) {
            if (!result.url) throw new Error('请先保存图片。');
            const context = getContext();
            if (!targetStillValid(context, target)) throw new TargetChangedError();
            if (result.boundTarget && result.boundTarget.message !== target.message) throw new Error('图片已写入原楼层，不能重复插入其他楼层；请回到原聊天重试保存。');
            const message = target.message;
            message.extra ??= {};
            const records = message.extra[KEY] ??= [];
            if (!records.some(record => record.id === result.id)) {
                if (typeof context.ensureMessageMediaIsArray === 'function') {
                    context.ensureMessageMediaIsArray(message);
                    message.extra.media ??= [];
                    message.extra.media.push({ url: result.url, type: 'image', source: 'generated', title: '聊天场景插画' });
                    message.extra.media_index = message.extra.media.length - 1;
                    message.extra.inline_image = true;
                } else {
                    // Older ST releases use a single image plus gallery swipes.
                    const images = [...(message.extra.image_swipes || [])];
                    if (message.extra.image && !images.includes(message.extra.image)) images.push(message.extra.image);
                    if (!images.includes(result.url)) images.push(result.url);
                    message.extra.image_swipes = images;
                    message.extra.image = result.url;
                    message.extra.inline_image = true;
                    message.extra.title = '聊天场景插画';
                }
                records.push({ id: result.id, url: result.url, model: result.model, createdAt: new Date().toISOString() });
                result.boundTarget = target;
                // Keep attachments when ST switches away from and back to this text swipe.
                if (Array.isArray(message.swipe_info) && Number.isInteger(message.swipe_id) && message.swipe_info[message.swipe_id]) {
                    message.swipe_info[message.swipe_id].extra = structuredClone(message.extra);
                }
            }
            const index = context.chat.indexOf(message);
            // Start saving before any asynchronous render could switch chats.
            await context.saveChat();
            result.saved = true;
            if (targetStillValid(getContext(), target)) context.updateMessageBlock?.(index, message, { rerenderMessage: false });
            return index;
        },
    };
}
