import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, endpoints } from '../core.js';
import {
    MEMORY_DIFF_SYSTEM, MEMORY_KEY, MEMORY_SUMMARY_SYSTEM, NO_UPDATE, buildMemoryDiffMessages,
    buildMemorySummaryMessages, buildPrompt, describeMemory, extractChatText, formatAppearanceBlock,
    memoryConnection, memoryRequest, mergeEntries, normalizeMemory, parentArchive, parseAppearance,
    parseMemoryDiff, planMemoryDiff, rememberArchive, speakerNames, userIdentities, validateMemorySettings,
} from '../memory.js';
import { createService } from '../service.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settings = { ...DEFAULTS, transport: 'direct', apiKey: 'test-secret', memoryModel: 'test-summary' };

function host() {
    return {
        characterId: 0, name1: '旅行者', name2: '莉娅', chatId: 'chat-a', characters: [{ avatar: 'lia.png' }],
        chat: [
            { name: '莉娅', mes: '雨水沿着酒馆的玻璃窗缓缓滑落。', extra: {} },
            { name: '旅行者', mes: '“今晚还有空房吗？”', is_user: true, extra: {} },
            { name: '莉娅', mes: '“当然。”我微笑着从柜台后走来，围裙上还沾着酒渍。', extra: {} },
        ],
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'local-only' }),
    };
}

test('endpoints expose the chat endpoint and still reject it as a base URL', () => {
    assert.equal(endpoints('http://localhost:8317/v1').chat, 'http://localhost:8317/v1/chat/completions');
    assert.equal(endpoints('https://proxy.test/openai/v1/').chat, 'https://proxy.test/openai/v1/chat/completions');
});

test('memory connection inherits the image address and key when left blank', () => {
    const inherited = memoryConnection({ ...settings, memoryBaseUrl: '', memoryApiKey: '' });
    assert.equal(inherited.baseUrl, settings.baseUrl);
    assert.equal(inherited.apiKey, 'test-secret');
    const own = memoryConnection({ ...settings, memoryBaseUrl: 'https://summary.test/v1', memoryApiKey: 'own-key' });
    assert.equal(own.baseUrl, 'https://summary.test/v1');
    assert.equal(own.apiKey, 'own-key');
});

test('validateMemorySettings requires a text model and sane floors and timeout', () => {
    assert.throws(() => validateMemorySettings({ ...settings, memoryModel: '  ' }), /文字模型/);
    assert.throws(() => validateMemorySettings({ ...settings, memoryFloors: 0 }), /1–200/);
    assert.throws(() => validateMemorySettings({ ...settings, memoryFloors: 201 }), /1–200/);
    assert.throws(() => validateMemorySettings({ ...settings, memoryTimeoutSeconds: 10 }), /30–900/);
    assert.throws(() => validateMemorySettings({ ...settings, memoryBaseUrl: 'file:///tmp/x' }), /HTTP/);
    assert.equal(validateMemorySettings({ ...settings, memoryFloors: 12 }).model, 'test-summary');
});

test('user identities and speaker names separate the persona from the characters', () => {
    const context = host();
    assert.deepEqual(userIdentities(context), ['旅行者']);
    assert.deepEqual(speakerNames(context.chat), ['莉娅']);
    context.chat.push({ name: '旁白', is_system: true, mes: 'x' });
    assert.deepEqual(speakerNames(context.chat), ['莉娅']);
});

test('summary request labels floors, lists the cast, and honours the floor limit', () => {
    const context = host();
    const all = buildMemorySummaryMessages(context, { ...settings, memoryFloors: 40 });
    assert.equal(all.count, 3);
    assert.equal(all.index, 2);
    assert.match(all.messages[0].content, /非用户角色/);
    assert.match(all.messages[1].content, /第 1 层 · 莉娅/);
    assert.match(all.messages[1].content, /第 2 层 · 旅行者\]（用户）/);
    assert.match(all.messages[1].content, /聊天中真实出现的角色名：莉娅/);
    const one = buildMemorySummaryMessages(context, { ...settings, memoryFloors: 1 });
    assert.equal(one.count, 1);
    assert.doesNotMatch(one.messages[1].content, /第 1 层/);
    assert.throws(() => buildMemorySummaryMessages({ ...context, chat: [{ name: '莉娅', mes: '  ' }] }, settings), /没有可总结/);
});

test('diff request sends only the newest reply plus the saved archive', () => {
    const context = host();
    const { messages, index, text } = buildMemoryDiffMessages(context, settings, { entries: { 莉娅: '银白长发，深蓝长裙。' } });
    assert.equal(index, 2);
    assert.match(text, /围裙上还沾着酒渍/);
    assert.match(messages[0].content, new RegExp(NO_UPDATE));
    assert.match(messages[1].content, /已保存的形象档案/);
    assert.match(messages[1].content, /银白长发/);
    assert.doesNotMatch(messages[1].content, /雨水沿着酒馆/);
    const empty = buildMemoryDiffMessages(context, settings, { entries: {} });
    assert.match(empty.messages[1].content, /（空）/);
    assert.throws(() => buildMemoryDiffMessages({ ...context, chat: [{ name: '旅行者', mes: 'hi', is_user: true }] }, settings, {}), /用户消息/);
});

test('appearance parsing accepts objects, arrays, fences and prose, and drops the user', () => {
    assert.deepEqual(parseAppearance('{"莉娅":"银发，蓝裙。"}'), { 莉娅: '银发，蓝裙。' });
    assert.deepEqual(parseAppearance('```json\n{"莉娅":"银发"}\n```'), { 莉娅: '银发' });
    assert.deepEqual(parseAppearance('好的，档案如下：\n[{"name":"莉娅","appearance":"金瞳"}]\n以上。'), { 莉娅: '金瞳' });
    assert.deepEqual(parseAppearance('{"莉娅":{"appearance":"短发"}}'), { 莉娅: '短发' });
    assert.deepEqual(parseAppearance('{"莉娅":"  a  \\n\\n b  "}'), { 莉娅: 'a b' });
    assert.deepEqual(parseAppearance('{"旅行者":"黑斗篷","莉娅":"银发"}', { exclude: ['旅行者'] }), { 莉娅: '银发' });
    assert.deepEqual(parseAppearance('{"lia":"x"}', { speakers: ['Lia'] }), { Lia: 'x' });
    assert.deepEqual(parseAppearance('{"「莉娅」":"带引号的名字"}'), { 莉娅: '带引号的名字' });
    assert.throws(() => parseAppearance('没有 JSON'), /没有返回 JSON/);
    assert.throws(() => parseAppearance('{"莉娅": 没引号}'), /解析失败/);
    assert.throws(() => parseAppearance('{"莉娅":""}'), /没有可用的角色条目/);
    const long = parseAppearance(JSON.stringify({ 莉娅: 'x'.repeat(2000) }));
    assert.equal(long.莉娅.length, 800);
});

test('entry count is capped so one runaway reply cannot flood the archive', () => {
    const rows = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`角色${i}`, '描述']));
    assert.equal(Object.keys(parseAppearance(JSON.stringify(rows))).length, 12);
});

test('diff parsing treats every NoUpdate spelling as no change', () => {
    for (const value of ['NoUpdate', 'noupdate', ' no update. ', 'No-Update\n', '```NoUpdate```', 'NO_UPDATE']) {
        assert.deepEqual(parseMemoryDiff(value), { updated: false, entries: {} }, value);
    }
    assert.deepEqual(parseMemoryDiff('{}'), { updated: false, entries: {} });
    assert.deepEqual(parseMemoryDiff('[]'), { updated: false, entries: {} });
    assert.deepEqual(parseMemoryDiff('{"旅行者":"黑斗篷"}', { exclude: ['旅行者'] }), { updated: false, entries: {} });
    const changed = parseMemoryDiff('{"莉娅":"换上海蓝色旅装。"}');
    assert.equal(changed.updated, true);
    assert.deepEqual(changed.entries, { 莉娅: '换上海蓝色旅装。' });
    assert.throws(() => parseMemoryDiff('看起来没变化'), /NoUpdate/);
    assert.throws(() => parseMemoryDiff('   '), /空内容/);
});

test('merging replaces per character, keeps the untouched ones, and caps the total', () => {
    const merged = mergeEntries({ 莉娅: '旧', 老板: '嗯' }, { 莉娅: '新' });
    assert.deepEqual(merged, { 莉娅: '新', 老板: '嗯' });
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`角色${i}`, '描述']));
    assert.equal(Object.keys(mergeEntries(many, {})).length, 12);
});

test('normalizeMemory survives junk without throwing', () => {
    const memory = normalizeMemory({ entries: { 莉娅: ' 银发 ', '': 'x', 旅行者: 3 }, floor: '9', updatedAt: 7, model: 'm'.repeat(200), kind: 'other' });
    assert.deepEqual(memory.entries, { 莉娅: '银发' });
    assert.equal(memory.floor, 9);
    assert.equal(memory.updatedAt, '');
    assert.equal(memory.model.length, 80);
    assert.equal(memory.kind, '');
    assert.deepEqual(normalizeMemory(null).entries, {});
});

test('appearance block states clearly that it is an older archive', () => {
    assert.equal(formatAppearanceBlock({ entries: {} }), '');
    const block = formatAppearanceBlock({ entries: { 莉娅: '银发，深蓝长裙。' }, floor: 12 }, { user: '旅行者' });
    assert.match(block, /上一次的存档/);
    assert.match(block, /可能不是最新/);
    assert.match(block, /截至第 12 层/);
    assert.match(block, /以聊天内容为准/);
    assert.match(block, /不要把它套用到用户（旅行者）身上/);
    assert.match(block, /- 莉娅：银发，深蓝长裙。/);
});

test('image prompt takes the archive as a fallback, by macro or appended at the end', () => {
    const context = host();
    const memory = { entries: { 莉娅: '银发，深蓝长裙。' }, floor: 3, updatedAt: '', model: '', kind: 'summary' };
    const appended = buildPrompt(context, { ...settings, preset: '画 {{char}}。{{chat}}' }, 2, memory).prompt;
    assert.match(appended, /角色形象档案/);
    assert.ok(appended.indexOf('【角色形象档案') > appended.indexOf('【聊天情节】'));
    const placed = buildPrompt(context, { ...settings, preset: '档案：{{appearance}}\n{{chat}}' }, 2, memory).prompt;
    assert.equal(placed.match(/角色形象档案/g).length, 1);
    assert.ok(placed.indexOf('档案：') < placed.indexOf('- 莉娅'));
    assert.doesNotMatch(buildPrompt(context, { ...settings, preset: '{{chat}}' }, 2, memory).prompt.replace(/角色形象档案[\s\S]*/, ''), /- 莉娅：银发/);
    assert.doesNotMatch(buildPrompt(context, { ...settings, memoryInject: false, preset: '{{chat}}' }, 2, memory).prompt, /角色形象档案/);
    assert.doesNotMatch(buildPrompt(context, { ...settings, preset: '{{chat}}' }, 2, null).prompt, /角色形象档案/);
});

test('extractChatText handles string, parts and reasoning-only replies', () => {
    assert.equal(extractChatText({ choices: [{ message: { content: ' A ' } }] }), ' A ');
    assert.equal(extractChatText({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] }), 'ab');
    assert.equal(extractChatText({ choices: [{ message: { content: '', reasoning_content: '{"莉娅":"x"}' } }] }), '{"莉娅":"x"}');
    assert.equal(extractChatText({ choices: [{ text: 'plain' }] }), 'plain');
    assert.equal(extractChatText({}), '');
});

test('auto diff planning skips stops, user floors, repeats and missing config', () => {
    const context = host();
    assert.deepEqual(planMemoryDiff({ ...settings, memoryAuto: false }, { chat: context.chat }), { run: false, reason: '自动形象更新未开启' });
    assert.match(planMemoryDiff({ ...settings, memoryModel: '' }, { chat: context.chat }).reason, /总结模型/);
    assert.match(planMemoryDiff(settings, { chat: context.chat, running: true }).reason, /正在进行/);
    assert.match(planMemoryDiff(settings, { chat: context.chat, stopped: true }).reason, /停止/);
    assert.match(planMemoryDiff(settings, { chat: [{ name: '旅行者', mes: 'hi', is_user: true }] }).reason, /不是模型回复/);
    const plan = planMemoryDiff(settings, { chat: context.chat });
    assert.equal(plan.run, true);
    assert.equal(plan.index, 2);
    assert.match(plan.text, /围裙上还沾着酒渍/);
    assert.match(planMemoryDiff(settings, { chat: context.chat, last: { index: plan.index, text: plan.text } }).reason, /已经对比过/);
});

test('memory requests use the chat endpoint, the memory model, and the right credential header', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return json({ choices: [{ message: { content: '{}' } }] }); };
    await memoryRequest({ ...settings, transport: 'server', memoryModel: 'summary-model' }, { messages: [{ role: 'user', content: 'hi' }], fetchImpl, requestHeaders: { 'X-CSRF-Token': 'csrf' } });
    assert.match(calls[0].url, /^\/proxy\//);
    assert.match(decodeURIComponent(calls[0].url), /\/v1\/chat\/completions$/);
    assert.equal(calls[0].init.headers['x-api-key'], 'test-secret');
    assert.equal(calls[0].init.headers.Authorization, undefined);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, 'summary-model');
    assert.equal(body.stream, false);
    assert.equal(body.messages[0].content, 'hi');
    assert.equal(body.max_tokens, undefined);
    await memoryRequest({ ...settings, memoryModel: 'm2' }, { messages: [], fetchImpl });
    assert.match(decodeURIComponent(calls[1].url), /^http:\/\/127\.0\.0\.1:8317\/v1\/chat\/completions$/);
    assert.equal(calls[1].init.headers.Authorization, 'Bearer test-secret');
    await assert.rejects(memoryRequest(settings, { messages: [], fetchImpl: async () => new Response('<html>', { status: 502 }) }), /没有返回 JSON/);
    await assert.rejects(memoryRequest({ ...settings, memoryModel: '' }, { messages: [], fetchImpl }), /文字模型/);
});

test('prompts keep the archive to stable features and exclude fleeting state', () => {
    const summary = MEMORY_SUMMARY_SYSTEM;
    // Scope: body features and worn items only.
    assert.match(summary, /固定外形特征/);
    assert.match(summary, /发色与发型、瞳色、肤色、身高与体型/);
    assert.match(summary, /上衣、下装、外套、鞋、帽子、手套、围巾/);
    // Excluded: temporary state, carried props, scene, user persona.
    for (const forbidden of ['新伤口、绷带、血迹、污泥、雨水、汗水、妆容', '随身物品与手持道具', '天气、环境、剧情、对白', '用户（{{user}}）的外形']) {
        assert.ok(summary.includes(forbidden), `summary prompt must exclude: ${forbidden}`);
    }
    assert.match(summary, /不要写「未明确」/);
    assert.match(summary, /不超过 80 字/);
    const diff = MEMORY_DIFF_SYSTEM;
    assert.match(diff, /只有这些算变化/);
    assert.match(diff, /换衣、脱衣、穿上或脱下外套、换鞋、摘下或戴上配饰/);
    assert.match(diff, /剪发、染发、新增永久疤痕或纹身/);
    assert.match(diff, /这些不算变化/);
    assert.match(diff, /淋湿、沾血、脏污、出汗、脸红、新伤口与包扎/);
    assert.match(diff, /哪怕用户换了衣服也不要输出/);
    assert.match(diff, /替换整条档案的完整新描述/);
    assert.match(diff, /不超过 80 字/);
    assert.ok(diff.includes(NO_UPDATE));
    // The example must not teach noise back in.
    assert.ok(!/酒渍|铜灯|划痕|沾泥/.test(summary));
    assert.ok(!/酒渍|铜灯|划痕|沾泥/.test(diff));
});

test('service.summarize and service.diff maintain the archive and never block on the user persona', async () => {
    const context = host();
    const bodies = [];
    const replies = ['```json\n{"莉娅":"银白长发，深蓝长裙。"}\n```', NO_UPDATE, '{"莉娅":"换上海蓝色旅装。","旅行者":"黑斗篷"}'];
    const fetchImpl = async (url, init) => { bodies.push(JSON.parse(init.body)); return json({ choices: [{ message: { content: replies.shift() } }] }); };
    const service = createService(() => context, fetchImpl);

    const summary = await service.summarize(settings);
    assert.deepEqual(summary.entries, { 莉娅: '银白长发，深蓝长裙。' });
    assert.equal(summary.index, 2);
    assert.equal(bodies[0].model, 'test-summary');

    const unchanged = await service.diff(settings, { entries: summary.entries });
    assert.equal(unchanged.updated, false);
    assert.equal(unchanged.text, '“当然。”我微笑着从柜台后走来，围裙上还沾着酒渍。');

    const changed = await service.diff(settings, { entries: summary.entries });
    assert.equal(changed.updated, true);
    assert.deepEqual(changed.entries, { 莉娅: '换上海蓝色旅装。' });
    assert.deepEqual(changed.changed, ['莉娅']);
    assert.doesNotMatch(bodies[2].messages[1].content, /旅行者":"黑斗篷/);
});

test('describeMemory reports the archive shape and its source', () => {
    assert.match(describeMemory({ entries: {} }), /还没有形象档案/);
    const text = describeMemory({ entries: { 莉娅: 'x' }, floor: 12, updatedAt: '2026-09-28T03:00:00.000Z', model: 'summary-model', kind: 'diff' });
    assert.match(text, /1 个角色/);
    assert.match(text, /截至第 12 层/);
    assert.match(text, /summary-model/);
    assert.match(text, /对比更新/);
    assert.match(describeMemory({ entries: { 莉娅: 'x' }, kind: 'inherit' }), /继承自母对话/);
    assert.equal(MEMORY_KEY, 'tavern_image_bridge_memory');
});

test('local archive copies let a branch inherit the parent archive', () => {
    const parent = { entries: { 莉娅: '银发，深蓝长裙。' }, floor: 9, updatedAt: '2026-09-28T01:00:00.000Z', model: 'm', kind: 'diff' };
    let cache = rememberArchive({}, 'main chat', parent);
    assert.deepEqual(parentArchive(cache, { main_chat: 'main chat' }).memory.entries, { 莉娅: '银发，深蓝长裙。' });
    assert.equal(parentArchive(cache, { main_chat: 'main chat' }).name, 'main chat');
    assert.deepEqual(parentArchive(cache, { main_chat: 'main chat' }).memory.floor, 9);
    assert.equal(parentArchive(cache, {}), null);
    assert.equal(parentArchive(cache, { main_chat: 'unknown chat' }), null);
    assert.equal(parentArchive(cache, { main_chat: 'main chat-branch' }), null);
    // An empty archive is not worth offering.
    assert.equal(parentArchive(rememberArchive({}, 'empty', { entries: {} }), { main_chat: 'empty' }), null);
    // Untitled chats are not cached, and the cache stays bounded by recency.
    assert.deepEqual(rememberArchive({}, '', parent), {});
    for (let i = 0; i < 12; i++) cache = rememberArchive(cache, `chat-${i}`, { ...parent, updatedAt: `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` });
    assert.equal(Object.keys(cache).length, 8);
    assert.equal('chat-0' in cache, false);
    assert.equal('chat-11' in cache, true);
    assert.equal('main chat' in cache, false);
});
