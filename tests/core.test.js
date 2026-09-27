import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, apiRequest, captureTarget, decodeImage, endpoints, extractImage, planAutoGeneration, safeError, targetStillValid } from '../core.js';
import { buildPrompt } from '../memory.js';
import { createService, TargetChangedError } from '../service.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const settings = { ...DEFAULTS, transport: 'direct', recentCount: 2, apiKey: 'test-secret' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function host(modern = true) {
    let saves = 0, renders = 0;
    const ctx = {
        characterId: 0, name1: '旅行者', name2: '莉娅', chatId: 'chat-a', characters: [{ avatar: 'lia.png' }],
        chat: [{ name: '莉娅', mes: '雨夜的酒馆', swipe_id: 0, swipe_info: [{ extra: {} }], extra: {} }, { name: '旅行者', mes: '推开门，走近壁炉。', is_user: true }],
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'local-only' }),
        saveChat: async () => { saves++; }, updateMessageBlock: () => { renders++; },
    };
    if (modern) ctx.ensureMessageMediaIsArray = message => { message.extra.media ??= []; };
    return { ctx, stats: () => ({ saves, renders }) };
}

test('root, /v1, full generation URL and custom prefix normalize without duplicate v1', () => {
    for (const value of ['http://localhost:8317', 'http://localhost:8317/v1/', 'http://localhost:8317/v1/images/generations']) assert.equal(endpoints(value).generate, 'http://localhost:8317/v1/images/generations');
    assert.equal(endpoints('https://proxy.test/openai/v1').models, 'https://proxy.test/openai/v1/models');
    for (const value of ['javascript:alert(1)', 'https://user:secret@a.test/v1', 'https://a.test/v1?key=abc', 'https://a.test/v1/chat/completions']) assert.throws(() => endpoints(value));
});

test('context ends at target, counts eligible floors, preserves roles, and excludes hidden/system/images', () => {
    const { ctx } = host();
    ctx.chat.splice(1, 0, { is_system: true, mes: 'do not include' });
    ctx.chat.push({ name: '莉娅', mes: '<think>secret reasoning</think><p>请坐。</p> ![image](data:image/png;base64,AAAA)' });
    const result = buildPrompt(ctx, settings, 3);
    assert.deepEqual(result.indices, [2, 3]);
    assert.match(result.prompt, /第 3 层 · 旅行者/);
    assert.doesNotMatch(result.prompt, /do not include|secret reasoning|data:image|雨夜/);
    assert.doesNotMatch(buildPrompt(ctx, settings, 2).prompt, /请坐/);
});

test('preset without placeholder appends chat, replacement is one pass and long prompts are rejected', () => {
    const { ctx } = host(); ctx.chat[1].mes = '{{char}} $&';
    const prompt = buildPrompt(ctx, { ...settings, preset: '画 {{char}}。{{chat}}' }, 1).prompt;
    assert.ok(prompt.includes('画 莉娅。')); assert.ok(prompt.includes('{{char}} $&'));
    assert.match(buildPrompt(ctx, { ...settings, preset: '水彩' }, 1).prompt, /【聊天情节】/);
    assert.throws(() => buildPrompt(ctx, { ...settings, preset: 'x'.repeat(32001) }, 1), /32000/);
});

test('generate uses images endpoint and never sends ST headers, supports model aliases', async () => {
    let captured;
    await apiRequest({ ...settings, model: 'codex/gpt-image-2.5' }, 'generate', { prompt: 'test', fetchImpl: async (url, init) => { captured = { url, init }; return json({ data: [{ b64_json: png }] }); } });
    assert.match(captured.url, /\/v1\/images\/generations$/);
    const body = JSON.parse(captured.init.body);
    assert.equal(body.model, 'codex/gpt-image-2.5'); assert.equal(body.stream, false); assert.equal(body.prompt, 'test');
    assert.equal(captured.init.headers.Authorization, 'Bearer test-secret'); assert.equal(captured.init.headers['X-CSRF-Token'], undefined);
    assert.equal(captured.init.credentials, 'omit');
});

test('HTTP errors and empty results surface useful errors with redacted secrets', async () => {
    await assert.rejects(apiRequest(settings, 'models', { fetchImpl: async () => json({ error: { message: 'Invalid key test-secret' } }, 401) }), /401/);
    assert.equal(safeError(new Error('Invalid key test-secret'), 'test-secret'), 'Invalid key [已隐藏密钥]');
    await assert.rejects(extractImage({ data: [] }), /没有返回图片/);
    assert.throws(() => decodeImage(btoa('<svg onload="alert(1)">')), /不是 PNG/);
});

test('base64 and data URL decode; remote image download gets no API key or cookies', async () => {
    assert.equal((await extractImage({ data: [{ b64_json: png }] })).format, 'png');
    assert.equal((await extractImage({ data: [{ url: `data:image/png;base64,${png}` }] })).base64, png);
    let options;
    const result = await extractImage({ data: [{ url: 'https://images.test/a.png' }] }, { fetchImpl: async (_, init) => { options = init; return new Response(Buffer.from(png, 'base64')); } });
    assert.equal(result.format, 'png'); assert.equal(options.headers.Authorization, undefined); assert.equal(options.credentials, 'omit');
    await assert.rejects(extractImage({ data: [{ url: 'file:///tmp/result.png' }] }), /HTTP/);
});

test('target identity tolerates new messages and reindexing but rejects edits, swipes and chat changes', () => {
    const { ctx } = host(); const target = captureTarget(ctx, 1);
    ctx.chat.push({ mes: 'later' }); assert.ok(targetStillValid(ctx, target));
    ctx.chat.shift(); assert.ok(targetStillValid(ctx, target));
    ctx.chatId = 'other'; assert.equal(targetStillValid(ctx, target), false); ctx.chatId = 'chat-a';
    target.message.swipe_id = 1; assert.equal(targetStillValid(ctx, target), false); target.message.swipe_id = undefined;
    target.message.mes = 'edited'; assert.equal(targetStillValid(ctx, target), false);
});

test('end-to-end: generate, upload, attach, save and keep original text and existing media', async () => {
    const { ctx, stats } = host(); ctx.chat[0].extra.media = [{ type: 'image', url: 'existing.png' }];
    const requests = [];
    const service = createService(() => ctx, async (url, init) => { requests.push({ url, init }); return url === '/api/images/upload' ? json({ path: '/user/images/lia/result.png' }) : json({ data: [{ b64_json: png }] }); });
    const result = await service.generate(settings, 0);
    await service.persist(result); await service.attach(result);
    assert.equal(ctx.chat[0].mes, '雨夜的酒馆'); assert.equal(ctx.chat[0].extra.media.length, 2);
    assert.equal(ctx.chat[0].swipe_info[0].extra.media.length, 2); assert.deepEqual(stats(), { saves: 1, renders: 1 });
    assert.equal(requests[1].init.headers.Authorization, undefined); assert.equal(requests[1].init.headers['X-CSRF-Token'], 'local-only');
    assert.equal(JSON.parse(requests[1].init.body).format, 'png');
    await service.persist(result); await service.attach(result);
    assert.equal(ctx.chat[0].extra.media.length, 2); assert.equal(requests.length, 2);
});

test('switching chats during API request preserves result without writing to wrong chat', async () => {
    const { ctx, stats } = host();
    const service = createService(() => ctx, async url => { if (url !== '/api/images/upload') ctx.chatId = 'chat-b'; return url === '/api/images/upload' ? json({ path: '/user/images/result.png' }) : json({ data: [{ b64_json: png }] }); });
    const result = await service.generate(settings, 0); await service.persist(result);
    await assert.rejects(service.attach(result), TargetChangedError);
    assert.equal(stats().saves, 0); assert.equal(ctx.chat[0].extra.media, undefined); assert.equal(result.image.base64, png);
});

test('deleting original target or changing swipe while upload waits prevents wrong attachment', async () => {
    for (const mutate of [ctx => ctx.chat.shift(), ctx => { ctx.chat[0].swipe_id = 1; }]) {
        const { ctx } = host();
        const service = createService(() => ctx, async url => {
            if (url === '/api/images/upload') { mutate(ctx); return json({ path: '/user/images/result.png' }); }
            return json({ data: [{ b64_json: png }] });
        });
        const result = await service.generate(settings, 0); await service.persist(result);
        await assert.rejects(service.attach(result), TargetChangedError);
    }
});

test('upload retry retains generated image and does not issue another paid generation', async () => {
    const { ctx } = host(); let generations = 0, uploads = 0;
    const service = createService(() => ctx, async url => {
        if (url === '/api/images/upload') { uploads++; return uploads === 1 ? json({ error: 'disk full' }, 500) : json({ path: '/user/images/result.png' }); }
        generations++; return json({ data: [{ b64_json: png }] });
    });
    const result = await service.generate(settings, -1);
    await assert.rejects(service.persist(result), /disk full/); await service.persist(result); await service.attach(result);
    assert.equal(generations, 1); assert.equal(uploads, 2);
});

test('chat save failure can retry without adding duplicate images', async () => {
    const { ctx } = host(); let attempts = 0;
    ctx.saveChat = async () => { if (++attempts === 1) throw new Error('save failed'); };
    const service = createService(() => ctx, async url => url === '/api/images/upload' ? json({ path: '/user/images/result.png' }) : json({ data: [{ b64_json: png }] }));
    const result = await service.generate(settings, 0); await service.persist(result);
    await assert.rejects(service.attach(result), /save failed/); await service.attach(result);
    assert.equal(ctx.chat[0].extra.media.length, 1); assert.equal(result.saved, true);
});

test('legacy ST image galleries retain the previous image', async () => {
    const { ctx } = host(false); ctx.chat[0].extra.image = 'old.png';
    const service = createService(() => ctx, async url => url === '/api/images/upload' ? json({ path: '/user/images/new.png' }) : json({ data: [{ b64_json: png }] }));
    const result = await service.generate(settings, 0); await service.persist(result); await service.attach(result);
    assert.deepEqual(ctx.chat[0].extra.image_swipes, ['old.png', '/user/images/new.png']);
    assert.equal(ctx.chat[0].extra.image, '/user/images/new.png');
});

test('cancellation propagates and generation is not retried', async () => {
    const controller = new AbortController(); controller.abort(); let calls = 0;
    await assert.rejects(apiRequest(settings, 'generate', { signal: controller.signal, fetchImpl: async (_, init) => { calls++; init.signal.throwIfAborted(); } }), { name: 'AbortError' });
    assert.equal(calls, 1);
});

test('auto trigger only fires for a fresh model reply and skips off, busy, stopped and illustrated floors', () => {
    const { ctx } = host();
    const on = { ...settings, autoTrigger: true };
    // Off by default, including for settings saved before the switch existed.
    assert.equal(DEFAULTS.autoTrigger, false);
    assert.equal(planAutoGeneration({ ...DEFAULTS, ...{ baseUrl: 'http://127.0.0.1:8317/v1' } }, { chat: ctx.chat }).run, false);
    const plan = state => planAutoGeneration(on, { chat: ctx.chat, ...state });
    assert.deepEqual(planAutoGeneration(settings, { chat: ctx.chat }), { run: false, reason: '自动生图未开启' });
    assert.deepEqual(plan({ running: true }), { run: false, reason: '已有生图任务正在进行' });
    assert.deepEqual(plan({ pending: true }), { run: false, reason: '上一张图片尚未插入楼层' });
    assert.deepEqual(plan({ stopped: true }), { run: false, reason: '本次生成已停止' });
    assert.deepEqual(planAutoGeneration(on, { chat: [] }), { run: false, reason: '没有可用的聊天楼层' });
    // The newest eligible floor is the user's own message: nothing to illustrate yet.
    assert.deepEqual(plan({}), { run: false, reason: '最新楼层不是模型回复' });
    // A fresh model reply becomes the target; trailing system and empty floors are ignored.
    ctx.chat.push({ name: '莉娅', mes: '火光落在杯沿上。', extra: {}, swipe_id: 0, swipe_info: [{ extra: {} }] });
    ctx.chat.push({ is_system: true, mes: 'do not illustrate' }, { name: '莉娅', mes: '   ' });
    assert.deepEqual(plan({}), { run: true, index: 2 });
    // Once that floor carries an illustration the trigger stops duplicating paid generations.
    ctx.chat[2].extra.tavern_image_bridge = [{ id: 'first', url: '/user/images/a.png' }];
    assert.deepEqual(plan({}), { run: false, reason: '最新楼层已有插画' });
    ctx.chat[2].extra.tavern_image_bridge = [];
    assert.deepEqual(plan({}), { run: true, index: 2 });
    // Switched chats and regenerated floors that lost their text are not eligible either.
    ctx.chat[2].mes = '';
    assert.deepEqual(plan({}), { run: false, reason: '最新楼层不是模型回复' });
});
