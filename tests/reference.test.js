import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, DEFAULT_REFERENCE_PROMPT, apiRequest, endpoints, makePayload } from '../core.js';
import { buildPrompt } from '../memory.js';
import {
    REF_LIMITS, activeRefs, addRef, buildReferenceBlock, collectFloorImages, describeLoadedImages, describeRefs,
    formatBytes, isUsableImageUrl, loadReferenceImages, needsShrink, normalizeRefs, parentRefs, planResize,
    refId, rememberRefs, removeRef, setRefNote, toggleRef,
} from '../reference.js';
import { createService } from '../service.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const dataUrl = `data:image/png;base64,${png}`;
const ref = (url, extra = {}) => ({ url, ...extra });
const settings = { ...DEFAULTS, transport: 'direct', recentCount: 2, apiKey: 'test-secret' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('endpoints expose the edits route without duplicating /v1', () => {
    assert.equal(endpoints('http://localhost:8317/v1').edit, 'http://localhost:8317/v1/images/edits');
    assert.equal(endpoints('http://localhost:8317/v1/images/edits').edit, 'http://localhost:8317/v1/images/edits');
    assert.equal(endpoints('https://proxy.test/openai/v1/').generate, 'https://proxy.test/openai/v1/images/generations');
});

test('payload only carries images when references exist, and only as data URLs', () => {
    assert.equal('images' in makePayload(settings, 'x'), false);
    const payload = makePayload(settings, 'x', [dataUrl, { image_url: dataUrl }]);
    assert.deepEqual(payload.images, [{ image_url: dataUrl }, { image_url: dataUrl }]);
    for (const value of ['http://images.test/a.png', '', 'data:image/png;base64,***', { image_url: 5 }]) {
        assert.throws(() => makePayload(settings, 'x', [value]), /参考图/);
    }
});

test('an edit request goes to /v1/images/edits with the reference attached', async () => {
    let captured;
    await apiRequest(settings, 'edit', { prompt: '参考她', images: [dataUrl], fetchImpl: async (url, init) => { captured = { url, init }; return json({ data: [{ b64_json: png }] }); } });
    assert.match(captured.url, /\/v1\/images\/edits$/);
    const body = JSON.parse(captured.init.body);
    assert.equal(body.prompt, '参考她');
    assert.deepEqual(body.images, [{ image_url: dataUrl }]);
    assert.equal(body.output_format, 'png');
});

test('floor images are collected from every known source, newest last, without duplicates', () => {
    const chat = [
        { name: '莉娅', mes: '第一层', extra: { media: [{ url: '/user/images/lia/a.png' }] } },
        { is_system: true, mes: 'system', extra: { media: [{ url: '/user/images/lia/system.png' }] } },
        { name: '莉娅', mes: '![图](/user/images/lia/b.png) 说明', extra: { image: '/user/images/lia/a.png', image_swipes: ['/user/images/lia/c.png'] } },
        { name: '莉娅', mes: `<img src="${dataUrl}">`, extra: { media: [{ url: 'blob:https://x/1' }, { url: '/user/images/lia/d.png' }] } },
        { name: '莉娅', mes: '生成了插画', extra: { tavern_image_bridge: [{ id: 'x', url: '/user/images/lia/e.png' }] } },
    ];
    const rows = collectFloorImages(chat);
    // 同一层内：扩展记录 → extra.media → 老格式 image/image_swipes → 正文内联；
    // 跨层保持楼层顺序，最新的在最后（界面用它反着排）。
    assert.deepEqual(rows.map(row => row.url), [
        '/user/images/lia/a.png', '/user/images/lia/c.png', '/user/images/lia/b.png',
        '/user/images/lia/d.png', dataUrl, '/user/images/lia/e.png',
    ]);
    assert.deepEqual(rows.map(row => row.index), [0, 2, 2, 3, 3, 4]);
    assert.equal(rows.find(row => row.url === '/user/images/lia/e.png').id, refId('/user/images/lia/e.png'));
    assert.equal(isUsableImageUrl('blob:https://x/1'), false);
    assert.equal(isUsableImageUrl('javascript:alert(1)'), false);
});

test('reference state drops junk, dedupes by url and stops at the cap', () => {
    const kept = normalizeRefs([
        { url: '/user/images/lia/a.png', source: 'floor', floor: 11 },
        { url: '/user/images/lia/a.png', source: 'floor', floor: 12 },
        { url: 'nonsense' },
        null,
        { url: 'https://img.test/b.png', note: '  只参考画风  '.repeat(40), enabled: false },
        { url: '/user/images/lia/c.png' },
    ]);
    assert.equal(kept.length, REF_LIMITS.count);
    assert.deepEqual(kept.map(item => item.url), ['/user/images/lia/a.png', 'https://img.test/b.png']);
    assert.equal(kept[0].source, 'floor');
    assert.equal(kept[0].floor, 11);
    assert.equal(kept[1].enabled, false);
    assert.ok(kept[1].note.length <= REF_LIMITS.noteLength);
    assert.deepEqual(activeRefs(kept).map(item => item.url), ['/user/images/lia/a.png']);
    assert.deepEqual(removeRef(kept, kept[0].id).map(item => item.url), ['https://img.test/b.png']);
    assert.equal(toggleRef(kept, kept[1].id, true).find(item => item.id === kept[1].id).enabled, true);
    assert.equal(setRefNote(kept, kept[0].id, '只参考脸').find(item => item.id === kept[0].id).note, '只参考脸');
});

test('adding a reference reports duplicates and the cap instead of failing silently', () => {
    const first = addRef([], ref('/user/images/lia/a.png', { source: 'upload' }));
    assert.equal(first.added, true);
    assert.equal(first.refs.length, 1);
    assert.equal(first.refs[0].source, 'upload');
    const duplicate = addRef(first.refs, ref('/user/images/lia/a.png'));
    assert.equal(duplicate.added, false);
    assert.equal(duplicate.full, false);
    const second = addRef(first.refs, ref('/user/images/lia/b.png'));
    const third = addRef(second.refs, ref('/user/images/lia/c.png'));
    assert.equal(third.added, false);
    assert.equal(third.full, true);
    assert.equal(third.refs.length, REF_LIMITS.count);
    assert.equal(addRef([], ref('ftp://a.test/x.png')).invalid, true);
});

test('the reference block states the face/body/style scope and keeps everything else from the chat', () => {
    for (const phrase of ['脸', '身材', '画风', '以聊天原文为准']) assert.ok(DEFAULT_REFERENCE_PROMPT.includes(phrase), phrase);
    const block = buildReferenceBlock([
        { url: '/user/images/lia/a.png', source: 'floor', floor: 11 },
        { url: '/user/images/lia/b.png', source: 'upload', note: '只参考画风' },
    ], { char: '莉娅' });
    assert.match(block, /^【参考图】/);
    assert.match(block, /本次附上 2 张参考图/);
    assert.match(block, /- 第 1 张（第 12 层）：参考脸部、身材与画风。/);
    assert.match(block, /- 第 2 张（本地上传）：参考脸部、身材与画风。备注：只参考画风/);
    assert.match(block, /以【聊天情节】里的最新剧情为准/);
    assert.equal(buildReferenceBlock([]), '');
    assert.equal(buildReferenceBlock([{ url: '/user/images/lia/a.png', enabled: false }]), '');
    // A custom template without {{list}} still renders the count and never throws.
    assert.equal(buildReferenceBlock([{ url: '/user/images/lia/a.png' }], { template: '{{count}} 张 / {{char}}', char: '莉娅' }), '1 张 / 莉娅');
});

test('resize planning never upscales and only shrinks oversized images', () => {
    assert.deepEqual(planResize({ width: 800, height: 600 }), { width: 800, height: 600, scaled: false });
    assert.deepEqual(planResize({ width: 2560, height: 1440 }), { width: 1280, height: 720, scaled: true });
    assert.equal(planResize({ width: 0, height: 10 }), null);
    assert.equal(needsShrink({ bytes: 100, width: 800, height: 600 }), false);
    assert.equal(needsShrink({ bytes: 100, width: 4000, height: 600 }), true);
    assert.equal(needsShrink({ bytes: 3 * 1024 * 1024, width: 800, height: 600 }), true);
    assert.equal(formatBytes(2048), '2 KB');
});

test('per-chat copies let a branch inherit the reference images', () => {
    const refs = normalizeRefs([{ url: '/user/images/lia/a.png', source: 'upload' }]);
    const cache = rememberRefs({}, 'rainy-tavern', refs);
    assert.deepEqual(parentRefs(cache, { main_chat: 'rainy-tavern' }).refs[0].url, '/user/images/lia/a.png');
    assert.equal(parentRefs(cache, {}), null);
    assert.equal(parentRefs({}, { main_chat: 'rainy-tavern' }), null);
    assert.deepEqual(Object.keys(rememberRefs(cache, 'rainy-tavern', [])), []);
});

test('loading references keeps a data URL and fetches same-origin tavern paths with the session', async () => {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
        calls.push({ url, options });
        return new Response(Buffer.from(png, 'base64'), { headers: { 'Content-Type': 'image/png' } });
    };
    const { images, failed } = await loadReferenceImages([
        { url: dataUrl, source: 'upload' },
        { url: '/user/images/lia/a.png', source: 'floor', floor: 3 },
    ], { settings, fetchImpl, measure: async () => ({ width: 8, height: 8 }) });
    assert.equal(failed.length, 0);
    assert.equal(images.length, 2);
    assert.equal(images[0].image_url, dataUrl);
    assert.equal(images[1].image_url, dataUrl);
    assert.equal(images[1].label, '第 4 层');
    assert.equal(images[1].width, 8);
    // A data URL needs no request; the tavern path is same-origin and keeps the session cookie.
    assert.deepEqual(calls.map(call => call.url), ['/user/images/lia/a.png']);
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert.equal(images[1].bytes, Buffer.from(png, 'base64').length);
});

test('a reference that cannot be read is reported per image instead of failing the whole batch', async () => {
    const fetchImpl = async url => {
        if (url === '/user/images/lia/broken.png') return new Response('missing', { status: 404 });
        return new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    };
    const { images, failed } = await loadReferenceImages([
        { url: '/user/images/lia/broken.png', source: 'floor', floor: 4 },
        { url: '/user/images/lia/not-image.png', source: 'floor', floor: 5 },
    ], { settings, fetchImpl, measure: async () => ({ width: 8, height: 8 }) });
    assert.equal(images.length, 0);
    assert.deepEqual(failed.map(item => item.label), ['第 5 层', '第 6 层']);
    assert.match(failed[0].reason, /404/);
    assert.match(failed[1].reason, /不是图片/);
});

test('absolute reference URLs go through the server proxy without the API key, and shrink when injected', async () => {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
        calls.push({ url, options });
        return new Response(Buffer.from(png, 'base64'), { headers: { 'Content-Type': 'image/png' } });
    };
    const serverSettings = { ...settings, transport: 'server', apiKey: 'test-secret' };
    const big = { width: 4000, height: 3000 };
    const { images, failed } = await loadReferenceImages([{ url: 'https://img.test/c.png', source: 'floor', floor: 1 }], {
        settings: serverSettings, fetchImpl, measure: async () => big,
        shrink: async (blob, options) => { assert.equal(options.maxSide, REF_LIMITS.maxSide); return new Blob([new Uint8Array(12)], { type: 'image/jpeg' }); },
    });
    assert.equal(failed.length, 0);
    assert.equal(decodeURIComponent(calls[0].url.slice('/proxy/'.length)), 'https://img.test/c.png');
    assert.equal(calls[0].options.headers['x-api-key'], undefined);
    assert.equal(images[0].bytes, 12);
    assert.match(images[0].image_url, /^data:image\/jpeg;base64,/);
});

test('oversized references fail with a readable message instead of being sent', async () => {
    const { images, failed } = await loadReferenceImages([{ url: dataUrl, source: 'upload' }], {
        settings, limits: { ...REF_LIMITS, maxBytes: 4 }, measure: async () => ({ width: 8, height: 8 }),
    });
    assert.equal(images.length, 0);
    assert.match(failed[0].reason, /超过/);
});

test('describeRefs and describeLoadedImages summarise what will be sent', () => {
    assert.match(describeRefs([]), /还没有参考图/);
    const refs = normalizeRefs([{ url: '/user/images/lia/a.png', source: 'upload' }, { url: '/user/images/lia/b.png', source: 'floor', floor: 4, enabled: false }]);
    assert.match(describeRefs(refs), /2 张参考图 · 本地上传、第 5 层（已停用）/);
    assert.match(describeLoadedImages([{ label: '本地上传', bytes: 2048, width: 64, height: 64 }]), /第 1 张 · 本地上传 · 64×64 · 2 KB/);
});

test('service sends an edit request with references and an untouched generation request without them', async () => {
    const chat = [{ name: '莉娅', mes: '雨夜的酒馆', extra: {}, swipe_id: 0, swipe_info: [{ extra: {} }] }];
    const context = { chat, chatId: 'a', name1: '旅行者', name2: '莉娅', getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) };
    const requests = [];
    const service = createService(() => context, async (url, init) => {
        requests.push({ url, init });
        return json({ data: [{ b64_json: png }] });
    });
    const withRefs = await service.generate(settings, 0, undefined, null, { refs: [{ url: dataUrl, source: 'upload' }], images: [{ id: 'r', label: '本地上传', image_url: dataUrl, bytes: 70 }] });
    assert.match(requests[0].url, /\/v1\/images\/edits$/);
    assert.equal(JSON.parse(requests[0].init.body).images.length, 1);
    assert.equal(withRefs.reference, 1);
    assert.match(withRefs.prompt, /【参考图】/);
    const withoutRefs = await service.generate(settings, 0, undefined, null, { refs: [], images: [] });
    assert.match(requests[1].url, /\/v1\/images\/generations$/);
    assert.equal('images' in JSON.parse(requests[1].init.body), false);
    assert.equal(withoutRefs.reference, 0);
    assert.doesNotMatch(withoutRefs.prompt, /【参考图】/);
});

test('prompt assembly places the reference block by placeholder or appends it last', () => {
    const context = { chat: [{ name: '莉娅', mes: '雨夜的酒馆' }], name1: '旅行者', name2: '莉娅' };
    const block = buildReferenceBlock([{ url: '/user/images/lia/a.png', source: 'floor', floor: 2 }]);
    const placed = buildPrompt(context, { ...settings, preset: '画 {{char}}。{{appearance}}\n{{reference}}' }, 0, null, block).prompt;
    assert.ok(placed.indexOf('【参考图】') < placed.indexOf('【聊天情节】'));
    const appended = buildPrompt(context, { ...settings, preset: '画 {{char}}。', memoryInject: false }, 0, null, block).prompt;
    assert.ok(appended.indexOf('画 莉娅。') < appended.indexOf('【参考图】'));
    assert.equal(buildPrompt(context, { ...settings, preset: '画 {{char}}。' }, 0, null, '').prompt.includes('【参考图】'), false);
});
