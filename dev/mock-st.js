const handlers = new Map();
let chatMetadata = {};
const baseChat = [
    { name: '莉娅', mes: '雨水沿着酒馆的玻璃窗缓缓滑落。壁炉里跳动着暖橙色的火光，我放下手中的书，抬头看向被推开的木门。\n![上一张插画](/mock-image?floor=1)', extra: { media: [{ type: 'image', url: '/mock-image?floor=1' }] }, swipe_id: 0, swipe_info: [{ extra: {} }] },
    { name: '旅行者', mes: '我收起沾满雨水的深色斗篷，走到壁炉边。“今晚还有空房吗？”', is_user: true, extra: {} },
    { name: '莉娅', mes: '“当然。”我微笑着从柜台后走来，将一杯冒着热气的蜂蜜酒放在你面前。铜灯下，木桌上铺着一张泛黄的地图。', extra: { media: [{ type: 'image', url: '/mock-image?floor=3' }] }, swipe_id: 0, swipe_info: [{ extra: {} }] },
];
const context = {
    chat: structuredClone(baseChat), chatId: 'rainy-tavern', characterId: 0, groupId: null,
    characters: [{ name: '莉娅', avatar: 'lia.png' }], name1: '旅行者', name2: '莉娅',
    extensionSettings: JSON.parse(localStorage.getItem('mock-settings') || '{}'),
    // Mirrors SillyTavern: chat_metadata is replaced wholesale, never mutated in place.
    get chatMetadata() { return chatMetadata; },
    updateChatMetadata(values, reset) { chatMetadata = reset ? { ...values } : { ...chatMetadata, ...values }; },
    saveMetadataDebounced() { qa.metadataSaves++; },
    saveSettingsDebounced() { localStorage.setItem('mock-settings', JSON.stringify(this.extensionSettings)); },
    async saveChat() { qa.saves++; qa.savedChat = structuredClone(this.chat); },
    getRequestHeaders() { return { 'Content-Type': 'application/json', 'X-CSRF-Token': 'mock-csrf' }; },
    ensureMessageMediaIsArray(message) { message.extra.media ??= []; },
    updateMessageBlock() { render(); },
    eventSource: { on(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); }, removeListener(type, fn) { handlers.get(type)?.delete(fn); } },
    eventTypes: Object.fromEntries(['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_DELETED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'GENERATION_ENDED', 'GENERATION_STOPPED'].map(key => [key, key])),
};
context.extensionSettings.tavern_image_bridge ??= { baseUrl: location.origin + '/v1', transport: 'server' };
function emit(type, ...args) { for (const handler of handlers.get(type) || []) handler(...args); }
function render() {
    const chat = document.querySelector('#chat'); chat.replaceChildren();
    context.chat.forEach((message, index) => {
        const node = document.createElement('article'); node.className = 'mes'; node.setAttribute('mesid', index);
        const block = document.createElement('div'); block.className = 'mes_block';
        const name = document.createElement('b'); name.textContent = `${message.name} · 第 ${index + 1} 层`;
        const text = document.createElement('div'); text.className = 'mes_text'; text.textContent = message.mes;
        const images = document.createElement('div'); images.className = 'mock-images';
        for (const media of message.extra?.media || []) { const image = new Image(); image.src = media.url; image.alt = '生成图片'; images.append(image); }
        block.append(name, text, images); node.append(block); chat.append(node);
    });
}
window.qa = { context, saves: 0, savedChat: null, emit, render, metadataSaves: 0,
    // Mirrors SillyTavern: the reply lands in the chat first, then GENERATION_ENDED fires.
    reply(text = '雨声更密了。我把铜灯往你那边推了推，火光在杯沿上晃了一下。') {
        context.chat.push({ name: context.name2, mes: text, extra: {}, swipe_id: 0, swipe_info: [{ extra: {} }] });
        render(); emit('MESSAGE_RECEIVED', context.chat.length - 1, 'normal'); emit('GENERATION_ENDED', context.chat.length);
    },
    // Mirrors stopGeneration(): GENERATION_ENDED still fires, then GENERATION_STOPPED in the same tick.
    stopGeneration() { emit('GENERATION_ENDED', context.chat.length); emit('GENERATION_STOPPED'); },
    switchChat() { context.chatId = context.chatId === 'rainy-tavern' ? 'other-chat' : 'rainy-tavern'; context.chat = structuredClone(baseChat); chatMetadata = {}; emit('CHAT_CHANGED'); render(); },
    // Mirrors SillyTavern's createBranch/createNewBookmark: the new chat's metadata only carries main_chat,
    // so the appearance archive does not travel with the branch.
    branchChat() { const parent = context.chatId; context.chatId = `${parent}-branch`; context.chat = structuredClone(baseChat); chatMetadata = { main_chat: parent }; emit('CHAT_CHANGED'); render(); },
    // Mirrors the swipe arrow: MESSAGE_SWIPED first, then (when a new swipe is requested) GENERATION_ENDED.
    swipe(text, { generate = false } = {}) {
        const last = context.chat.at(-1);
        last.mes = text;
        last.swipe_id = (last.swipe_id ?? 0) + 1;
        emit('MESSAGE_SWIPED', context.chat.length - 1);
        if (generate) qa.reply('（重新生成的新内容。）');
    },
};
window.SillyTavern = { getContext: () => context };
render();
document.querySelector('#sim-reply')?.addEventListener('click', () => qa.reply());
document.querySelector('#sim-stop')?.addEventListener('click', () => qa.stopGeneration());
document.querySelector('#sim-swipe')?.addEventListener('click', () => qa.swipe('雨声更密了。我换了一件干燥的灰色斗篷，把湿透的长发拢到耳后。'));
document.querySelector('#sim-branch')?.addEventListener('click', () => qa.branchChat());
await import('../index.js');
