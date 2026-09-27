import { KEY, apiRequest, buildPrompt, captureTarget, extractImage, readJson, resolveTargetIndex, targetStillValid, validateSettings } from './core.js';

export class TargetChangedError extends Error {
    constructor() { super('原聊天或楼层已变化，图片已保留。可下载，或手动插入当前选择的楼层。'); this.name = 'TargetChangedError'; }
}

export function createService(getContext, fetchImpl = fetch) {
    return {
        async generate(settings, requestedIndex, signal) {
            validateSettings(settings);
            const context = getContext();
            const index = resolveTargetIndex(context.chat, requestedIndex);
            const target = captureTarget(context, index);
            const { prompt, count } = buildPrompt(context, settings, index);
            const body = await apiRequest(settings, 'generate', { signal, prompt, fetchImpl });
            const image = await extractImage(body, { signal, fetchImpl });
            return { id: crypto.randomUUID(), image, target, count, model: settings.model, url: null, boundTarget: null, saved: false };
        },
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
