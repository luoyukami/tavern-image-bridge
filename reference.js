// 参考图（角色一致性）：楼层选图、上传落盘、状态规范化、说明块、取字节。
// 纯逻辑（收集 / 规范化 / 说明块 / 尺寸计算）不碰 DOM，可用 node --test 覆盖；
// 只有「blob → 缩放 → data URL」这一段用浏览器 API，通过参数注入，测试里换成桩。
import { DEFAULT_REFERENCE_PROMPT, KEY, routeRequest, safeError } from './core.js';

export const REFS_KEY = 'tavern_image_bridge_refs';

// 上限 = 一次生成最多附几张参考图。每张图都会变成一次输入 image tokens（约 1024）并走上行流量，
// 实测一张 512×512 就要 1024 输入 tokens，所以这里刻意压到 2：够「一张脸 + 一张全身」。
export const REF_LIMITS = Object.freeze({
    count: 2,
    noteLength: 120,
    maxBytes: 8 * 1024 * 1024,
    maxSide: 1280,
    shrinkAtBytes: 1.5 * 1024 * 1024,
    jpegQuality: 0.92,
    cachePerChat: 8,
    pickerFloors: 200,
});

const INLINE_IMAGE = /!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)|<img[^>]+src\s*=\s*["']([^"']+)["']/gi;
const DATA_URL = /^data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+$/i;

/** 参考图能不能真的取到：data URL、同源绝对路径（/user/images/...）或 http(s)。 */
export function isUsableImageUrl(value) {
    const url = String(value ?? '').trim();
    if (!url || /\s/.test(url)) return false;
    if (DATA_URL.test(url)) return true;
    if (/^https?:\/\//i.test(url) || /^\/[^/]/.test(url)) return true;
    return false;
}

export function isDataUrl(value) {
    return DATA_URL.test(String(value ?? '').trim());
}

/** 稳定 id：同一个 url 每次载入都是同一个 id，界面重绘与去重都靠它。 */
export function refId(url) {
    let hash = 5381;
    for (const char of String(url ?? '')) hash = ((hash << 5) + hash + char.codePointAt(0)) >>> 0;
    return `ref-${hash.toString(16)}`;
}

export function refSourceLabel(ref = {}) {
    if (ref.source === 'upload') return '本地上传';
    return Number.isInteger(ref.floor) ? `第 ${ref.floor + 1} 层` : '聊天图片';
}

export function inlineImages(text) {
    const urls = [];
    for (const match of String(text ?? '').matchAll(INLINE_IMAGE)) urls.push(match[1] ?? match[2]);
    return urls.filter(Boolean);
}

/** 收集所有楼层里可用的图片，按楼层顺序去重，返回最后 N 条（最新的在后面）。 */
export function collectFloorImages(chat = [], { limit = REF_LIMITS.pickerFloors } = {}) {
    const rows = [];
    const seen = new Set();
    const push = (message, index, url, kind) => {
        const value = String(url ?? '').trim();
        if (!isUsableImageUrl(value) || seen.has(value)) return;
        seen.add(value);
        rows.push({ index, name: String(message?.name ?? ''), url: value, kind, id: refId(value) });
    };
    chat.forEach((message, index) => {
        if (!message || message.is_system) return;
        for (const record of message.extra?.[KEY] ?? []) push(message, index, record?.url, 'generated');
        for (const media of message.extra?.media ?? []) push(message, index, media?.url, 'media');
        push(message, index, message.extra?.image, 'legacy');
        for (const url of message.extra?.image_swipes ?? []) push(message, index, url, 'legacy');
        // 正文要按原文找图：cleanMessage 会把 markdown 图片、<img> 和 data URL 一起删掉。
        for (const url of inlineImages(message.mes)) push(message, index, url, 'inline');
    });
    return rows.slice(-limit);
}

/** 规范化任意来源的参考图状态：丢坏数据、按 url 去重、截断到上限。 */
export function normalizeRefs(value) {
    const rows = Array.isArray(value) ? value : [];
    const refs = [];
    const seen = new Set();
    for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const url = String(row.url ?? '').trim();
        if (!isUsableImageUrl(url) || seen.has(url)) continue;
        seen.add(url);
        const floor = Number(row.floor);
        refs.push({
            id: String(row.id ?? '').trim() || refId(url),
            url,
            source: row.source === 'upload' ? 'upload' : 'floor',
            floor: Number.isInteger(floor) && floor >= 0 ? floor : null,
            note: String(row.note ?? '').replace(/\s+/g, ' ').trim().slice(0, REF_LIMITS.noteLength),
            enabled: row.enabled !== false,
            addedAt: typeof row.addedAt === 'string' ? row.addedAt : '',
        });
        if (refs.length >= REF_LIMITS.count) break;
    }
    return refs;
}

export function activeRefs(value) {
    return normalizeRefs(value).filter(ref => ref.enabled);
}

/** 加一张：重复的 url 只算一次；到上限时 added=false、full=true，界面据此提示。 */
export function addRef(refs, incoming = {}) {
    const current = normalizeRefs(refs);
    const url = String(incoming.url ?? '').trim();
    if (!isUsableImageUrl(url)) return { refs: current, added: false, full: false, invalid: true };
    if (current.some(ref => ref.url === url)) return { refs: current, added: false, full: false, invalid: false };
    const next = normalizeRefs([...current, { ...incoming, url, id: refId(url), addedAt: new Date().toISOString() }]);
    return { refs: next, added: next.length > current.length, full: next.length <= current.length, invalid: false };
}

export function removeRef(refs, id) {
    return normalizeRefs(refs).filter(ref => ref.id !== id);
}

export function toggleRef(refs, id, enabled) {
    return normalizeRefs(refs).map(ref => ref.id === id ? { ...ref, enabled: enabled ?? !ref.enabled } : ref);
}

export function setRefNote(refs, id, note) {
    return normalizeRefs(refs).map(ref => ref.id === id ? { ...ref, note: String(note ?? '').slice(0, REF_LIMITS.noteLength) } : ref);
}

export function describeRefs(refs) {
    const list = normalizeRefs(refs);
    if (!list.length) return '还没有参考图。上传一张，或从楼层里挑一张，生成时就会作为脸 / 身材 / 画风参考一起发送。';
    const labels = list.map(ref => `${refSourceLabel(ref)}${ref.enabled ? '' : '（已停用）'}`);
    return `${list.length} 张参考图 · ${labels.join('、')} · 上限 ${REF_LIMITS.count} 张`;
}

/**
 * 参考图说明块。模板里 {{count}} = 张数、{{list}} = 每张一行的清单、{{char}} = 角色名。
 * 默认文案把「脸 / 身材 / 画风看参考图、其余看正文」写死，契约测试会锁住这句话。
 */
export function buildReferenceBlock(refs, { template = DEFAULT_REFERENCE_PROMPT, char = '' } = {}) {
    const list = normalizeRefs(refs).filter(ref => ref.enabled);
    if (!list.length) return '';
    const lines = list.map((ref, order) => {
        const base = `- 第 ${order + 1} 张（${refSourceLabel(ref)}）：参考脸部、身材与画风。`;
        return ref.note ? `${base}备注：${ref.note}` : base;
    }).join('\n');
    return String(template)
        .replace(/\{\{(count|list|char)\}\}/g, (_, key) => (key === 'count' ? String(list.length) : key === 'list' ? lines : String(char ?? '')))
        .trim();
}

/** 分支 / 检查点只带 {main_chat}，参考图不跟过去：按对话名留一份有界副本供一键沿用。 */
export function rememberRefs(cache = {}, chatName, refs, limit = REF_LIMITS.cachePerChat) {
    const name = String(chatName ?? '').trim();
    const list = normalizeRefs(refs);
    const next = { ...cache };
    if (!name || !list.length) delete next[name];
    else next[name] = { refs: list, updatedAt: new Date().toISOString() };
    const names = Object.keys(next);
    if (names.length <= limit) return next;
    const oldestFirst = names.sort((a, b) => String(next[a]?.updatedAt).localeCompare(String(next[b]?.updatedAt)));
    return Object.fromEntries(oldestFirst.slice(-limit).map(key => [key, next[key]]));
}

export function parentRefs(cache = {}, chatMetadata = {}) {
    const parent = String(chatMetadata?.main_chat ?? '').trim();
    const refs = parent ? normalizeRefs(cache?.[parent]?.refs) : [];
    return refs.length ? { name: parent, refs } : null;
}

export function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** 等比缩放计划：只缩不放，供压缩前判断使用。 */
export function planResize({ width, height } = {}, { maxSide = REF_LIMITS.maxSide } = {}) {
    const w = Number(width), h = Number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || !Number.isFinite(maxSide) || maxSide <= 0) return null;
    const longest = Math.max(w, h);
    if (longest <= maxSide) return { width: Math.round(w), height: Math.round(h), scaled: false };
    const ratio = maxSide / longest;
    return { width: Math.max(1, Math.round(w * ratio)), height: Math.max(1, Math.round(h * ratio)), scaled: true };
}

/** 是否需要压缩：太大、或长边超限（缩图）都要过一遍 canvas。 */
export function needsShrink({ bytes, width, height } = {}, limits = REF_LIMITS) {
    const size = Number(bytes) || 0;
    if (size > limits.shrinkAtBytes) return true;
    const plan = planResize({ width, height }, { maxSide: limits.maxSide });
    return Boolean(plan?.scaled);
}

export function formatLabel(mime) {
    const value = String(mime ?? '').toLowerCase();
    if (value.includes('jpeg') || value.includes('jpg')) return 'jpg';
    if (value.includes('webp')) return 'webp';
    if (value.includes('png')) return 'png';
    return '';
}

export async function blobToDataUrl(blob) {
    const buffer = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buffer.length; i += 8192) binary += String.fromCharCode(...buffer.subarray(i, i + 8192));
    return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

/** 浏览器侧测量：createImageBitmap 优先，老 Safari 退回 <img>。 */
export async function measureBlob(blob) {
    if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(blob);
        const size = { width: bitmap.width, height: bitmap.height };
        bitmap.close?.();
        return size;
    }
    const url = URL.createObjectURL(blob);
    try {
        return await new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
            image.onerror = () => reject(new Error('无法读取图片尺寸。'));
            image.src = url;
        });
    } finally { URL.revokeObjectURL(url); }
}

/**
 * 浏览器侧压缩：长边超过 maxSide 就等比缩小，并统一转成 JPEG（铺白底，避免透明变黑）。
 * 参考图只用来固定长相，1280 已经足够；实测楼层图单张 2.3 MB，压完只剩零头。
 */
export async function shrinkImage(blob, { maxSide = REF_LIMITS.maxSide, quality = REF_LIMITS.jpegQuality, mime = 'image/jpeg' } = {}) {
    const size = await measureBlob(blob);
    const plan = planResize(size, { maxSide });
    if (!plan) return blob;
    const canvas = document.createElement('canvas');
    canvas.width = plan.width; canvas.height = plan.height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, plan.width, plan.height);
    if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(blob);
        context.drawImage(bitmap, 0, 0, plan.width, plan.height);
        bitmap.close?.();
    } else {
        const url = URL.createObjectURL(blob);
        try {
            const image = await new Promise((resolve, reject) => {
                const node = new Image();
                node.onload = () => resolve(node);
                node.onerror = () => reject(new Error('无法读取图片。'));
                node.src = url;
            });
            context.drawImage(image, 0, 0, plan.width, plan.height);
        } finally { URL.revokeObjectURL(url); }
    }
    const shrunk = await new Promise(resolve => canvas.toBlob(resolve, mime, quality));
    return shrunk ?? blob;
}

async function fetchByUrl(ref, { settings, requestHeaders, fetchImpl, signal }) {
    // 同源路径（楼层图 / 本扩展落盘的图）直接取；绝对地址走 routeRequest，
    // 这样后台转发模式下不会撞 CORS / 混合内容，也不会把 API 密钥带给图片站。
    if (/^\/[^/]/.test(ref.url)) return fetchImpl(ref.url, { signal, credentials: 'same-origin', cache: 'no-store' });
    const request = routeRequest(settings, ref.url, { signal, requestHeaders, withApiKey: false, accept: 'image/png,image/jpeg,image/webp,image/gif' });
    return fetchImpl(request.url, request.options);
}

async function readBlob(response) {
    if (!response?.ok) throw new Error(`取图失败：HTTP ${response?.status ?? '未知'}`);
    const blob = await response.blob();
    const type = String(blob.type || response.headers?.get?.('content-type') || '').toLowerCase();
    if (type && !type.startsWith('image/')) throw new Error(`返回的不是图片（${type}）。`);
    if (!blob.size) throw new Error('取到的是空文件。');
    return blob;
}

function dataUrlBlob(dataUrl) {
    const raw = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png' });
}

/**
 * 取参考图字节 → data URL。逐张独立失败：一张拿不到不会让整单失败，
 * 失败项带 label 交给界面提示（楼层被删、分支后失效都会走到这里）。
 */
export async function loadReferenceImages(refs, {
    settings = {}, requestHeaders = {}, fetchImpl = fetch, signal, shrink = null, measure = null, limits = REF_LIMITS,
} = {}) {
    const images = [];
    const failed = [];
    for (const ref of activeRefs(refs)) {
        const label = refSourceLabel(ref);
        try {
            let blob = isDataUrl(ref.url) ? dataUrlBlob(ref.url.trim()) : await readBlob(await fetchByUrl(ref, { settings, requestHeaders, fetchImpl, signal }));
            const probe = measure ? await measure(blob).catch(() => null) : null;
            if (shrink && needsShrink({ bytes: blob.size, width: probe?.width, height: probe?.height }, limits)) {
                blob = await shrink(blob, { maxSide: limits.maxSide, quality: limits.jpegQuality });
            }
            if (blob.size > limits.maxBytes) throw new Error(`图片 ${formatBytes(blob.size)}，超过 ${formatBytes(limits.maxBytes)} 上限。`);
            const dataUrl = await blobToDataUrl(blob);
            let size = probe;
            if (!size && measure) size = await measure(blob).catch(() => null);
            images.push({ id: ref.id, label, image_url: dataUrl, bytes: blob.size, width: size?.width ?? null, height: size?.height ?? null, note: ref.note });
        } catch (error) {
            if (signal?.aborted) throw error;
            failed.push({ id: ref.id, label, reason: safeError(error, settings.apiKey) });
        }
    }
    return { images, failed };
}

export function describeLoadedImages(images = []) {
    if (!images.length) return '（本次没有参考图）';
    return images.map((image, order) => {
        const size = image.width && image.height ? `${image.width}×${image.height}` : '尺寸未知';
        return `第 ${order + 1} 张 · ${image.label} · ${size} · ${formatBytes(image.bytes)}${image.note ? ` · 备注：${image.note}` : ''}`;
    }).join('\n');
}
