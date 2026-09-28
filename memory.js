// 形象记忆（角色外形档案）。这一层只做纯逻辑：提示词构造、返回解析、档案合并、注入文本，
// 以及跨会话的读写规范。所有函数都不碰 DOM，便于用 node --test 覆盖。
import { DEFAULTS, cleanMessage, eligibleMessages, endpoints, readJson, routeRequest } from './core.js';

export const MEMORY_KEY = 'tavern_image_bridge_memory';
export const NO_UPDATE = 'NoUpdate';
export const MEMORY_LIMITS = Object.freeze({ entries: 12, nameLength: 60, descriptionLength: 800, floors: 200, promptChars: 48000 });

export const MEMORY_SUMMARY_SYSTEM = `你是酒馆聊天记录里的角色形象档案员。任务只有一个：从给定的聊天内容里，整理出非用户角色的固定外形特征，供作画时保持人物一致。

只记录这两类内容：
A. 明显的身体特征：发色与发型、瞳色、肤色、身高与体型，以及长期存在的特征（旧疤痕、胎记、纹身、义肢、兽耳兽尾、精灵耳等）。
B. 穿戴物：常穿的上衣、下装、外套、鞋、帽子、手套、围巾，以及常戴的配饰（眼镜、耳环、项链、戒指、发饰、腰带）。

不要记录——它们变得太快，只会干扰作画：
- 临时的身体状态：新伤口、绷带、血迹、污泥、雨水、汗水、妆容、脸红、疲倦、表情、情绪、姿势、动作。
- 随身物品与手持道具：灯、杯、伞、武器、行李、食物、宠物。
- 天气、环境、剧情、对白、心理活动。
- 用户（{{user}}）的外形。

规则：
1. 名字以正文为准，标签不算：每层开头的「[第 N 层 · XX]」是酒馆给楼层打的标签，用的是**角色卡的名字**，可能只是卡片标题而不是剧情里的角色名。要写正文里角色怎么自称、别人怎么称呼的那个名字（正文里自称「伊蕾娜」就写「伊蕾娜」）；某个标签名在正文里从没被当作称呼用过，就不要为它建档案。角色名与正文一致，不要翻译、不要加头衔。
2. 以最后楼层为准：前文写过、后来换掉的衣服、发型或配饰，只写最新的那次。
3. 每条写成一句话的白描，按「发色发型，瞳色，体型，上身，下身，鞋，配饰」的顺序，用逗号分隔；没写到的项直接省略。
4. 聊天里没有明确写到的项不要凭想象补全，也不要写「未明确」「不详」这类占位词。
5. 只输出一个 JSON 对象：键是角色名，值是外形描述。不要输出解释、前言、注释、代码块标记或多余空行。
6. 每条不超过 80 字。没有任何可记录的角色时输出 {}。

输出示例：
{"莉娅":"银白色长发披散过腰，金色竖瞳，身形纤细，深蓝色酒保长裙配白色围裙，棕色短靴，左耳一枚铜环。"}`;

export const MEMORY_DIFF_SYSTEM = `你是酒馆聊天记录里的角色形象档案员。你手上已经有一份角色固定外形档案，现在只做一件事：拿最新一层回复和档案对比，找出固定外形发生变化的角色。

只有这些算变化：
- 换衣、脱衣、穿上或脱下外套、换鞋、摘下或戴上配饰（眼镜、耳环、项链等）。
- 长期性的身体变化：剪发、染发、新增永久疤痕或纹身、失去肢体、变装。

这些不算变化，即使最新回复里写了也不要输出：
- 临时的身体状态：淋湿、沾血、脏污、出汗、脸红、新伤口与包扎、妆容、表情、情绪、姿势、动作。
- 随身物品与手持道具、天气、环境、剧情与对白。
- 用户（{{user}}）的外形，哪怕用户换了衣服也不要输出。

规则：
1. 名字以正文为准，标签不算：最新回复开头的「[第 N 层 · XX]」是酒馆给楼层打的标签，用的是**角色卡的名字**，可能只是卡片标题而不是剧情里的角色名。新增条目要写正文里角色怎么自称、别人怎么称呼的那个名字；标签名在正文里从没被当作称呼用过，就不要用它建条目。
2. 只输出固定外形确实发生变化的角色，没有变化的角色不要出现在输出里。
3. 变化角色的值必须是替换整条档案的完整新描述（不是差异片段、不是「改成…」这类说明），按「发色发型，瞳色，体型，上身，下身，鞋，配饰」的顺序写成一句话，没有的项省略。
4. 档案为空时，把最新回复里明确写出的角色固定外形当作新增条目。
5. 所有角色都没有变化时，只输出一个词：${NO_UPDATE}。不带标点、不带解释、不带代码块、不要输出别的字。
6. 有变化时只输出 JSON 对象：键是角色名，值是完整的新描述。不要输出任何多余文字。
7. 每条不超过 80 字。

输出示例（无变化）：
${NO_UPDATE}

输出示例（有变化）：
{"莉娅":"银白色长发用蓝色发带扎起，金色竖瞳，身形纤细，换上海蓝色旅装外套与深色长裤，脚踏皮靴，左耳一枚铜环。"}`;

function fillMacros(text, context = {}) {
    return String(text).replace(/\{\{(user|char)\}\}/g, (_, key) => key === 'user' ? context.name1 || '用户' : context.name2 || '角色');
}

// 交给形象模型的身份事实。这里刻意不再把消息标签说成「真实出现的角色名」：
// 酒馆是用角色卡的名字给楼层打标签的，卡片名常常只是卡片标题（比如卡叫「租借女友」，
// 剧情里的角色其实叫「伊蕾娜」），照字面喂给模型会让它把卡片名也建进档案。
export function identityFacts(context = {}) {
    const card = String(context?.name2 ?? '').trim();
    return [
        `用户（不要记录其外形）：${userIdentities(context).join('、') || context.name1 || '用户'}`,
        card ? `酒馆里这张角色卡的名字：${card}（消息标签用的就是它，可能只是卡片标题，不等于剧情里的角色名）` : '',
        `消息标签里出现的名字：${speakerNames(context.chat).join('、') || '（无）'}（标签名不一定是剧情里的称呼，以正文为准）`,
    ].filter(Boolean);
}

/** 用户身份名，用于从模型返回里剔除用户自己。 */
export function userIdentities(context = {}) {
    const names = [context.name1, ...(context.chat ?? []).filter(message => message?.is_user).map(message => message.name)]
        .map(name => String(name ?? '').trim()).filter(Boolean);
    return [...new Set(names)];
}

/** 聊天中非用户的发言者名字（保持出现顺序）。 */
export function speakerNames(chat = []) {
    const names = [];
    for (const message of chat) {
        if (!message || message.is_user || message.is_system) continue;
        const name = String(message.name ?? '').trim();
        if (name && !names.includes(name)) names.push(name);
    }
    return names;
}

export function canonicalName(value, speakers = []) {
    const raw = String(value ?? '').trim().replace(/^["'「『\[（(]+|["'」』\]）)]+$/g, '').trim();
    const hit = speakers.find(speaker => speaker.toLowerCase() === raw.toLowerCase());
    return (hit || raw).slice(0, MEMORY_LIMITS.nameLength);
}

function pickName(row) {
    for (const key of ['name', 'character', 'char', '角色', '角色名', '名字']) {
        if (typeof row?.[key] === 'string') return row[key];
    }
    return '';
}

function pickDescription(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
        for (const key of ['appearance', 'description', 'value', 'profile', '形象', '外观', '描述']) {
            if (typeof value[key] === 'string') return value[key];
        }
    }
    return '';
}

function stripFence(text) {
    const raw = String(text ?? '').trim();
    // A fenced block, possibly with a language tag on its own line.
    const block = raw.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
    if (block && block[1].trim()) return block[1].trim();
    // A one-line fence (```NoUpdate```): only the backticks are decoration.
    return raw.replace(/^```+\s*/, '').replace(/\s*```+$/, '').trim();
}

/** 取第一段配平的 JSON（模型常在外层加解释或代码块）。 */
function firstJsonChunk(text) {
    const start = text.search(/[[{]/);
    if (start === -1) return null;
    const open = text[start], close = open === '{' ? '}' : ']';
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < text.length; i++) {
        const char = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === open) depth++;
        else if (char === close && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
}

function readAppearanceJson(text) {
    const chunk = firstJsonChunk(stripFence(text));
    if (!chunk) throw new Error('模型没有返回 JSON 形象档案。可重试一次，或换一个更听话的文字模型。');
    try { return JSON.parse(chunk); } catch (error) {
        throw new Error(`形象档案 JSON 解析失败：${String(error?.message || error).slice(0, 140)}`);
    }
}

function normalizeAppearance(data, { exclude = [], speakers = [] } = {}) {
    const rows = Array.isArray(data)
        ? data
        : (data && typeof data === 'object' ? Object.entries(data).map(([name, value]) => ({ name, appearance: value })) : []);
    const blocked = exclude.map(name => String(name).toLowerCase());
    const entries = {};
    for (const row of rows) {
        const name = canonicalName(pickName(row), speakers);
        const description = pickDescription(row?.appearance ?? row);
        if (!name || typeof description !== 'string') continue;
        if (blocked.includes(name.toLowerCase())) continue;
        const clean = cleanMessage(description).replace(/\s*\n+\s*/g, ' ').trim().slice(0, MEMORY_LIMITS.descriptionLength);
        if (!clean) continue;
        entries[name] = clean;
        if (Object.keys(entries).length >= MEMORY_LIMITS.entries) break;
    }
    return entries;
}

export function parseAppearance(text, options = {}) {
    const entries = normalizeAppearance(readAppearanceJson(text), options);
    if (!Object.keys(entries).length) throw new Error('模型返回的档案里没有可用的角色条目。请确认总结模型按 JSON 输出，或换一个文字模型。');
    return entries;
}

/** diff 请求的返回：{ updated, entries }。NoUpdate（含大小写/空白/句点差异）视为无变化。 */
export function parseMemoryDiff(text, options = {}) {
    const raw = stripFence(text).trim();
    if (!raw) throw new Error('模型返回了空内容。');
    if (!/[[{]/.test(raw)) {
        if (/no[\s_-]*updates?/i.test(raw)) return { updated: false, entries: {} };
        throw new Error(`模型既没有返回 JSON，也没有返回 ${NO_UPDATE}。原始返回：${raw.slice(0, 120)}`);
    }
    const entries = normalizeAppearance(readAppearanceJson(raw), options);
    return Object.keys(entries).length ? { updated: true, entries } : { updated: false, entries: {} };
}

export function mergeEntries(current = {}, entries = {}) {
    const merged = { ...current, ...entries };
    const names = Object.keys(merged);
    return names.length <= MEMORY_LIMITS.entries
        ? merged
        : Object.fromEntries(names.slice(-MEMORY_LIMITS.entries).map(name => [name, merged[name]]));
}

export function normalizeMemory(value) {
    const entries = normalizeAppearance({ ...(value?.entries ?? {}) }, {});
    return {
        entries,
        floor: Number(value?.floor) > 0 ? Number(value.floor) : 0,
        updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : '',
        model: String(value?.model ?? '').slice(0, 80),
        kind: ['diff', 'summary', 'inherit'].includes(value?.kind) ? value.kind : '',
    };
}

/**
 * 本地档案副本（按对话名保存，有上限）。酒馆的分支与检查点只把 {main_chat} 写进新对话的元数据，
 * 档案不会跟过去，这份副本用来让分支一键沿用母对话的档案。
 */
export function rememberArchive(cache = {}, chatName, memory, limit = 8) {
    const name = String(chatName ?? '').trim();
    if (!name) return { ...cache };
    const next = { ...cache, [name]: normalizeMemory(memory) };
    const names = Object.keys(next);
    if (names.length <= limit) return next;
    const oldestFirst = names.sort((a, b) => String(next[a].updatedAt).localeCompare(String(next[b].updatedAt)));
    return Object.fromEntries(oldestFirst.slice(-limit).map(key => [key, next[key]]));
}

/** 当前对话若是分支/检查点，返回母对话可用的档案副本。 */
export function parentArchive(cache = {}, chatMetadata = {}) {
    const parent = String(chatMetadata?.main_chat ?? '').trim();
    if (!parent) return null;
    const memory = normalizeMemory(cache[parent]);
    return Object.keys(memory.entries).length ? { name: parent, memory } : null;
}

/** 注入生图提示词的保底形象块：明确告诉生图模型这是上一次的存档。 */
export function formatAppearanceBlock(memory, { user = '' } = {}) {
    const entries = Object.entries(normalizeMemory(memory).entries);
    if (!entries.length) return '';
    const floor = normalizeMemory(memory).floor;
    const lines = [
        '【角色形象档案 · 上一次的存档，可能不是最新】',
        `以下是${floor ? `截至第 ${floor} 层` : '上一次更新'}记录的固定外形与常穿衣物，只作为保底参考：如果上面的聊天内容里写出了更新的穿着或外形变化，一律以聊天内容为准；档案里的临时伤势、污渍、情绪和随身物品不要照搬${user ? `，且不要把它套用到用户（${user}）身上` : ''}。`,
        ...entries.map(([name, description]) => `- ${name}：${description}`),
    ];
    return lines.join('\n');
}

/** 组装生图提示词。appearance 为空或关闭注入时不带档案块。 */
export function buildPrompt(context, settings, targetIndex, memory = null) {
    const rows = eligibleMessages(context.chat, targetIndex).slice(-Number(settings.recentCount));
    const chat = rows.map(({ message, index, text }) => `[第 ${index + 1} 层 · ${message.name || (message.is_user ? context.name1 : context.name2) || '角色'}]\n${text}`).join('\n\n');
    const appearance = settings.memoryInject === false ? '' : formatAppearanceBlock(memory, { user: context.name1 || '' });
    const values = { chat, char: context.name2 || '角色', user: context.name1 || '用户', appearance };
    const preset = String(settings.preset ?? '').trim();
    let prompt = preset.replace(/\{\{(chat|char|user|appearance)\}\}/g, (_, key) => values[key]);
    if (!preset.includes('{{chat}}')) prompt += `\n\n【聊天情节】\n${chat}`;
    if (appearance && !preset.includes('{{appearance}}')) prompt += `\n\n${appearance}`;
    prompt = prompt.trim();
    if (prompt.length > 32000) throw new Error(`发送内容共 ${prompt.length} 字符，超过 32000 字符；请减少聊天层数或缩短预设。`);
    return { prompt, count: rows.length, indices: rows.map(row => row.index) };
}

export function memoryConnection(settings = {}) {
    const baseUrl = String(settings.memoryBaseUrl ?? '').trim();
    const apiKey = String(settings.memoryApiKey ?? '').trim();
    return { ...settings, baseUrl: baseUrl || settings.baseUrl, apiKey: apiKey || settings.apiKey, model: String(settings.memoryModel ?? '').trim(), transport: settings.transport ?? DEFAULTS.transport };
}

export function validateMemorySettings(settings = {}) {
    const connection = memoryConnection(settings);
    if (!connection.model) throw new Error('请先填写形象记忆使用的文字模型名称。');
    if (!['server', 'direct'].includes(connection.transport)) throw new Error('请选择酒馆后台转发或浏览器直连。');
    endpoints(connection.baseUrl);
    const floors = Number(settings.memoryFloors);
    if (!Number.isInteger(floors) || floors < 1 || floors > MEMORY_LIMITS.floors) throw new Error(`总结楼层数必须是 1–${MEMORY_LIMITS.floors} 的整数。`);
    const seconds = Number(settings.memoryTimeoutSeconds);
    if (!Number.isFinite(seconds) || seconds < 30 || seconds > 900) throw new Error('形象请求的等待时间必须是 30–900 秒。');
    return connection;
}

export function buildMemorySummaryMessages(context, settings) {
    const floors = Math.min(Number(settings.memoryFloors) || DEFAULTS.memoryFloors, MEMORY_LIMITS.floors);
    const rows = eligibleMessages(context.chat).slice(-floors);
    if (!rows.length) throw new Error('当前没有可总结的聊天内容。');
    const transcript = rows.map(({ message, index, text }) => `[第 ${index + 1} 层 · ${message.name || '未知'}]${message.is_user ? '（用户）' : ''}\n${text}`).join('\n\n');
    const user = [
        ...identityFacts(context),
        '', '【聊天内容】', transcript,
    ].join('\n');
    if (user.length > MEMORY_LIMITS.promptChars) throw new Error(`总结内容共 ${user.length} 字符，超过 ${MEMORY_LIMITS.promptChars}；请减少总结楼层数。`);
    const index = rows.at(-1).index;
    return { messages: [{ role: 'system', content: fillMacros(MEMORY_SUMMARY_SYSTEM, context) }, { role: 'user', content: user }], index, count: rows.length };
}

export function buildMemoryDiffMessages(context, settings, memory = {}) {
    const row = eligibleMessages(context.chat).at(-1);
    if (!row) throw new Error('当前没有可对比的聊天内容。');
    if (row.message.is_user) throw new Error('最新一层是用户消息，先把模型回复生成出来再对比。');
    const archive = normalizeMemory(memory).entries;
    const user = [
        ...identityFacts(context),
        '', '【已保存的形象档案】',
        Object.keys(archive).length ? JSON.stringify(archive, null, 1) : '（空）',
        '', `【最新一层回复 · 第 ${row.index + 1} 层 · ${row.message.name || '角色'}】`, row.text,
    ].join('\n');
    if (user.length > MEMORY_LIMITS.promptChars) throw new Error(`对比内容共 ${user.length} 字符，超过 ${MEMORY_LIMITS.promptChars}；请清空档案后改用总结。`);
    return { messages: [{ role: 'system', content: fillMacros(MEMORY_DIFF_SYSTEM, context) }, { role: 'user', content: user }], index: row.index, text: row.text };
}

export function makeChatPayload(settings, messages) {
    return { model: memoryConnection(settings).model, messages, stream: false };
}

export function extractChatText(body) {
    const choice = body?.choices?.[0];
    const content = choice?.message?.content ?? choice?.text ?? body?.content ?? '';
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) {
        const joined = content.map(part => typeof part === 'string' ? part : part?.text ?? '').join('');
        if (joined.trim()) return joined;
    }
    const reasoning = choice?.message?.reasoning_content;
    return typeof reasoning === 'string' ? reasoning : (typeof content === 'string' ? content : '');
}

export async function memoryRequest(settings, { messages, signal, fetchImpl = fetch, requestHeaders = {} } = {}) {
    const connection = validateMemorySettings(settings);
    const { url, options } = routeRequest(connection, endpoints(connection.baseUrl).chat, {
        signal, requestHeaders, method: 'POST', body: JSON.stringify(makeChatPayload(connection, messages)),
    });
    let response;
    try { response = await fetchImpl(url, options); } catch (error) {
        if (signal?.aborted) throw error;
        if (connection.transport === 'server') throw new Error('无法连接酒馆后台代理（形象请求）。请检查酒馆登录与 /proxy/ 转发配置；不会自动切换到浏览器直连。');
        throw new Error('无法连接形象总结 API。请检查地址、CORS，以及 HTTPS 页面是否拦截了 HTTP 请求；手机上的 127.0.0.1 指向手机本身。');
    }
    return readJson(response, { transport: connection.transport });
}

/** 模型回复结束后是否发送 diff 请求。 */
export function planMemoryDiff(settings, { chat = [], running = false, stopped = false, last = null } = {}) {
    if (!settings?.memoryAuto) return { run: false, reason: '自动形象更新未开启' };
    if (!String(settings?.memoryModel ?? '').trim()) return { run: false, reason: '尚未填写总结模型' };
    if (running) return { run: false, reason: '形象请求正在进行' };
    if (stopped) return { run: false, reason: '本次生成已停止' };
    const row = eligibleMessages(chat).at(-1);
    if (!row) return { run: false, reason: '没有可用的聊天楼层' };
    if (row.message.is_user) return { run: false, reason: '最新楼层不是模型回复' };
    if (last && last.index === row.index && last.text === row.text) return { run: false, reason: '这一层已经对比过' };
    return { run: true, index: row.index, text: row.text };
}

export function describeMemory(memory) {
    const data = normalizeMemory(memory);
    const names = Object.keys(data.entries);
    if (!names.length) return '还没有形象档案。点「总结当前形象」建一份，之后生图会自动带上它。';
    const when = data.updatedAt ? new Date(data.updatedAt).toLocaleString() : '时间未知';
    const source = data.kind === 'diff' ? '对比更新' : (data.kind === 'summary' ? '总结' : (data.kind === 'inherit' ? '继承自母对话' : '手动'));
    return `${names.length} 个角色 · 上次更新 ${when}${data.floor ? ` · 截至第 ${data.floor} 层` : ''}${data.model ? ` · ${data.model}` : ''} · ${source}`;
}
