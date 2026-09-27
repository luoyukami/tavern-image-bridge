import { KEY, apiRequest, captureTarget, chatIdentity, eligibleMessages, loadSettings, planAutoGeneration, resolveTargetIndex, safeError } from './core.js';
import { MEMORY_KEY, buildPrompt, describeMemory, formatAppearanceBlock, memoryConnection, mergeEntries, normalizeMemory, planMemoryDiff } from './memory.js';
import { createService, TargetChangedError } from './service.js';

let mounted;
const getContext = () => globalThis.SillyTavern.getContext();

function mount() {
    if (mounted || !globalThis.SillyTavern?.getContext) return;
    const context = getContext();
    const stored = context.extensionSettings[KEY] || {};
    const settings = loadSettings(stored);
    const lifetime = new AbortController();
    const service = createService(getContext);
    let job = null, pending = null, previewUrl = null, hideTimer = null, clockTimer = null, selectedIndex = -1;
    let opened = false, lastFocus = null, startedAt = 0, stoppedAt = 0, placeholder = null;
    let drag = null, swallowClick = false, swallowClickUntil = 0;
    let memoryJob = null, lastDiff = null, memory = readMemory();

    const root = document.createElement('div');
    root.id = 'tib-root';
    root.innerHTML = `
      <button type="button" class="tib-launcher" aria-label="打开酒馆生图面板，可上下拖动" aria-expanded="false" aria-controls="tib-panel" title="酒馆生图 · 可上下拖动">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="4"/><circle cx="8" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 3-3 4 4"/></svg><span class="tib-busy-dot" hidden></span>
      </button>
      <section id="tib-panel" class="tib-panel" role="dialog" aria-modal="false" aria-labelledby="tib-title" hidden>
        <header class="tib-header"><div><span class="tib-eyebrow">CLI PROXY API</span><h2 id="tib-title">酒馆生图</h2></div><button type="button" data-action="close" class="tib-icon" aria-label="收起面板">×</button></header>
        <div class="tib-tabs" role="tablist" aria-label="面板分区">
          <button type="button" class="tib-tab" role="tab" id="tib-tab-image" data-tab="image" aria-selected="true" aria-controls="tib-pane-image">生图</button>
          <button type="button" class="tib-tab" role="tab" id="tib-tab-memory" data-tab="memory" aria-selected="false" aria-controls="tib-pane-memory">形象记忆</button>
        </div>
        <div class="tib-body">
          <section id="tib-pane-image" class="tib-pane" role="tabpanel" aria-labelledby="tib-tab-image">
          <p class="tib-intro">把此刻的故事，变成一幅画。</p>
          <div class="tib-section-label">连接</div>
          <label for="tib-transport">连接方式</label><select id="tib-transport" data-setting="transport"><option value="server">酒馆后台转发（推荐）</option><option value="direct">浏览器直连</option></select>
          <p id="tib-transport-hint" class="tib-hint" aria-live="polite"></p>
          <label for="tib-url">API 地址</label><input id="tib-url" data-setting="baseUrl" type="url" placeholder="http://127.0.0.1:8317/v1" spellcheck="false" autocomplete="off">
          <label for="tib-key">API Key</label><input id="tib-key" data-setting="apiKey" type="password" placeholder="CLIProxyAPI 客户端密钥" autocomplete="off" spellcheck="false">
          <label class="tib-check"><input data-setting="rememberKey" type="checkbox">记住密钥<span>保存到酒馆设置</span></label>
          <div class="tib-model-row"><div><label for="tib-model">图片模型</label><input id="tib-model" data-setting="model" list="tib-models" autocomplete="off" spellcheck="false"></div></div>
          <div class="tib-model-actions"><button type="button" data-action="model-list" class="tib-secondary" aria-expanded="false" aria-controls="tib-model-list">选择模型</button><button type="button" data-action="models" class="tib-secondary">读取模型</button></div>
          <p id="tib-model-hint" class="tib-hint">可直接输入模型名，或点「选择模型」从列表中挑选。</p>
          <div id="tib-model-list" class="tib-model-list" role="group" aria-label="可用模型" hidden></div>
          <datalist id="tib-models"><option value="gpt-image-2.5"></option><option value="gpt-image-2.5-flare"></option><option value="gpt-image-2.5-sunburst"></option><option value="gpt-image-2"></option></datalist>
          <div class="tib-section-label">场景</div>
          <div class="tib-columns"><div><label for="tib-count">最近聊天层数</label><input id="tib-count" data-setting="recentCount" type="number" min="1" max="100" step="1"></div><div><label for="tib-target">图片插入楼层</label><select id="tib-target" aria-describedby="tib-context-info"></select></div></div>
          <p id="tib-context-info" class="tib-hint"></p>
          <label class="tib-check"><input data-setting="autoTrigger" type="checkbox">模型回复结束后自动生图<span>插入刚生成的楼层；该层已有插画、正在生成或上次结果未插入时自动跳过</span></label>
          <label for="tib-preset">生图预设</label><textarea id="tib-preset" data-setting="preset" rows="7" spellcheck="false"></textarea>
          <p class="tib-hint">可用 {{chat}}、{{char}}、{{user}}、{{appearance}}。不写 {{chat}} 时聊天会自动追加到预设末尾；不写 {{appearance}} 时形象档案（若已开启）也追加在末尾。</p>
          <details class="tib-details"><summary>图片与悬浮设置</summary><div class="tib-columns">
            <div><label for="tib-size">图片比例</label><select id="tib-size" data-setting="size"><option value="1024x1024">方形 · 1024 × 1024</option><option value="1536x1024">横向 · 1536 × 1024</option><option value="1024x1536">纵向 · 1024 × 1536</option><option value="auto">自动</option></select></div>
            <div><label for="tib-quality">图片质量</label><select id="tib-quality" data-setting="quality"><option value="auto">自动</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高 · 2.5</option><option value="max">最高 · 2.5</option></select></div></div>
            <label for="tib-timeout">最长等待（秒）</label><input id="tib-timeout" data-setting="timeoutSeconds" type="number" min="30" max="1800" step="30">
            <label class="tib-check"><input data-setting="autoHide" type="checkbox">悬浮按钮闲置时自动贴边隐藏</label>
          </details>
          <details class="tib-details" id="tib-preview"><summary>预览发送内容</summary><pre id="tib-prompt"></pre></details>
          <div id="tib-result" class="tib-result" hidden><a id="tib-image-link" target="_blank" rel="noopener"><img id="tib-image" alt="本次生成的场景插画"></a><div class="tib-result-actions"><a id="tib-download" class="tib-secondary" download>下载图片</a><button type="button" data-action="retry" class="tib-secondary" hidden>重试保存并插入</button><button type="button" data-action="discard" class="tib-secondary" title="清除内存中的结果；不删除已保存的图片">清除预览</button></div></div>
          </section>
          <section id="tib-pane-memory" class="tib-pane" role="tabpanel" aria-labelledby="tib-tab-memory" hidden>
            <p class="tib-intro">用一个文字模型把角色此刻的外形记成档案。生图时把它作为保底一起发送，最近几层没写穿着也不会跑偏。</p>
            <div class="tib-section-label">总结模型</div>
            <label for="tib-memory-url">API 地址</label><input id="tib-memory-url" data-setting="memoryBaseUrl" type="url" placeholder="留空 = 沿用生图的地址" spellcheck="false" autocomplete="off">
            <label for="tib-memory-key">API Key</label><input id="tib-memory-key" data-setting="memoryApiKey" type="password" placeholder="留空 = 沿用生图的密钥" autocomplete="off" spellcheck="false">
            <label class="tib-check"><input data-setting="memoryRememberKey" type="checkbox">记住密钥<span>保存到酒馆设置</span></label>
            <label for="tib-memory-model">文字模型</label><input id="tib-memory-model" data-setting="memoryModel" list="tib-memory-models" placeholder="例如 deepseek-v4-flash（文字模型，不是生图模型）" spellcheck="false" autocomplete="off">
            <div class="tib-model-actions"><button type="button" data-action="memory-model-list" class="tib-secondary" aria-expanded="false" aria-controls="tib-memory-model-list">选择模型</button><button type="button" data-action="memory-models" class="tib-secondary">读取模型</button></div>
            <p id="tib-memory-model-hint" class="tib-hint">文字模型走这个连接的 /v1/models 与 /chat/completions；地址和密钥留空就沿用生图那份。</p>
            <div id="tib-memory-model-list" class="tib-model-list" role="group" aria-label="可选文字模型" hidden></div>
            <datalist id="tib-memory-models"></datalist>
            <div class="tib-columns"><div><label for="tib-memory-floors">总结楼层数</label><input id="tib-memory-floors" data-setting="memoryFloors" type="number" min="1" max="200" step="1"></div><div><label for="tib-memory-timeout">最长等待（秒）</label><input id="tib-memory-timeout" data-setting="memoryTimeoutSeconds" type="number" min="30" max="900" step="30"></div></div>
            <p class="tib-hint">总结请求把最近这么多层一次性交给模型，产出完整档案；对比请求只发送最新一层回复，返回 NoUpdate 时档案一点不动。两者与生图异步，互不等待。</p>
            <label class="tib-check"><input data-setting="memoryAuto" type="checkbox">模型回复结束后自动对比更新<span>只发最新一层</span></label>
            <p id="tib-memory-warning" class="tib-hint" hidden></p>
            <label class="tib-check"><input data-setting="memoryInject" type="checkbox">生图时把档案作为保底发送<span>预设里写 {{appearance}} 可自选位置</span></label>
            <div class="tib-section-label">当前档案</div>
            <p id="tib-memory-status" class="tib-hint"></p>
            <p id="tib-memory-progress" class="tib-hint" role="status" aria-live="polite"></p>
            <div id="tib-memory-entries" class="tib-memory-entries"></div>
            <details class="tib-details" id="tib-memory-details"><summary>查看会发给生图模型的形象文本</summary><pre id="tib-memory-preview"></pre></details>
            <div class="tib-memory-actions"><button type="button" data-action="memory-summary" class="tib-primary">总结当前形象</button><button type="button" data-action="memory-diff" class="tib-secondary">对比最新回复</button><button type="button" data-action="memory-clear" class="tib-secondary">清空档案</button><button type="button" data-action="memory-cancel" class="tib-secondary" hidden>取消</button></div>
          </section>
        </div>
        <footer class="tib-footer"><p id="tib-status" role="status" aria-live="polite">配置会自动保存；密钥默认仅保留在本次页面会话。</p><div class="tib-actions"><button type="button" data-action="generate" class="tib-primary">生成并插入楼层 <span aria-hidden="true">↗</span></button><button type="button" data-action="cancel" class="tib-secondary" hidden>取消</button></div></footer>
      </section>`;
    document.body.append(root);
    const $ = selector => root.querySelector(selector);
    const panel = $('#tib-panel'), launcher = $('.tib-launcher');
    const listen = (element, event, fn) => element.addEventListener(event, fn, { signal: lifetime.signal });

    function persistSettings() {
        const next = { ...settings, apiKey: settings.rememberKey ? settings.apiKey : '', memoryApiKey: settings.memoryRememberKey ? settings.memoryApiKey : '' };
        getContext().extensionSettings[KEY] = next;
        getContext().saveSettingsDebounced();
    }
    function status(text, type = '') { $('#tib-status').textContent = text; $('#tib-status').dataset.type = type; }
    function refreshTransportHint() {
        $('#tib-transport-hint').textContent = settings.transport === 'server'
            ? '由酒馆服务器访问 API。需在酒馆 config.yaml 中启用 enableCorsProxy: true 并重启。127.0.0.1 指酒馆服务器；Docker 部署时指酒馆容器。'
            : '由当前设备访问 API，需要 API 允许跨域。127.0.0.1 指当前设备。远程部署酒馆时，建议切换为后台转发。';
    }
    // <datalist> never opens on iOS Safari (and is flaky in in-app browsers), so the model picker is
    // our own tappable list; typing in the field keeps working as before on every platform.
    // The image connection and the appearance-memory connection share this picker.
    const MODEL_PICKERS = {
        image: { input: '#tib-model', list: '#tib-model-list', toggle: '[data-action="model-list"]', hint: '#tib-model-hint', setting: 'model', clear: '选择模型' },
        memory: { input: '#tib-memory-model', list: '#tib-memory-model-list', toggle: '[data-action="memory-model-list"]', hint: '#tib-memory-model-hint', setting: 'memoryModel', clear: '选择模型' },
    };
    function syncModelSelection(picker = 'image') {
        const { list, setting } = MODEL_PICKERS[picker];
        for (const item of $(list).children) item.setAttribute('aria-pressed', String(item.dataset.model === settings[setting]));
    }
    function renderModelList(names, picker = 'image') {
        const spec = MODEL_PICKERS[picker];
        $(spec.list).replaceChildren(...names.map(name => {
            const item = document.createElement('button');
            item.type = 'button'; item.className = 'tib-model-item';
            item.setAttribute('aria-pressed', 'false'); item.dataset.model = name; item.textContent = name;
            return item;
        }));
        $(spec.toggle).textContent = names.length ? `${spec.clear} · ${names.length}` : spec.clear;
        $(spec.hint).textContent = names.length
            ? '点一个模型即可选用；也可以直接在输入框里改写。'
            : '可直接输入模型名，或点「读取模型」获取列表。';
        syncModelSelection(picker);
    }
    function toggleModelList(force, picker = 'image') {
        const spec = MODEL_PICKERS[picker];
        const list = $(spec.list);
        const show = typeof force === 'boolean' ? force : list.hidden;
        if (show && !list.childElementCount) {
            const message = '还没有模型列表，先点「读取模型」。';
            if (picker === 'memory') memoryProgress(message, 'warning'); else status(message, 'warning');
            return;
        }
        list.hidden = !show;
        $(spec.toggle).setAttribute('aria-expanded', String(show));
        if (show) list.querySelector('[aria-pressed="true"]')?.scrollIntoView?.({ block: 'nearest' });
    }
    function applyModel(name, picker = 'image') {
        const spec = MODEL_PICKERS[picker];
        $(spec.input).value = name;
        settings[spec.setting] = name; persistSettings();
        syncModelSelection(picker); toggleModelList(false, picker);
        const message = `已选用模型 ${name}。`;
        if (picker === 'memory') { memoryProgress(message, 'success'); renderMemory(); }
        else status(message, 'success');
    }
    // ---- 形象记忆 ----
    // 档案按聊天保存：优先写进酒馆的 chat_metadata（跟着这个聊天文件走），旧版本退回到扩展设置里按聊天分区存。
    function readMemory() {
        const current = getContext();
        const stored = current.chatMetadata?.[MEMORY_KEY];
        if (stored && typeof stored === 'object') return normalizeMemory(stored);
        return normalizeMemory(settings.memoryByChat?.[chatIdentity(current)]);
    }
    function writeMemory(next) {
        const current = getContext();
        const payload = normalizeMemory({ ...next, updatedAt: new Date().toISOString() });
        if (typeof current.updateChatMetadata === 'function') {
            current.updateChatMetadata({ [MEMORY_KEY]: payload }, false);
            current.saveMetadataDebounced?.();
        } else {
            const map = { ...(settings.memoryByChat ?? {}), [chatIdentity(current)]: payload };
            const keys = Object.keys(map);
            if (keys.length > 20) delete map[keys[0]];
            settings.memoryByChat = map;
            persistSettings();
        }
        memory = payload;
        renderMemory();
        return payload;
    }
    function memoryProgress(text, type = '') {
        const node = $('#tib-memory-progress');
        node.textContent = text;
        node.dataset.type = type;
    }
    function renderMemory() {
        $('#tib-memory-status').textContent = describeMemory(memory);
        const warning = $('#tib-memory-warning');
        if (settings.memoryAuto && !String(settings.memoryModel ?? '').trim()) {
            warning.textContent = '自动更新已开启，但还没填文字模型，所以不会发出请求。';
            warning.dataset.type = 'warning';
            warning.hidden = false;
        } else {
            warning.hidden = true;
        }
        const rows = Object.entries(memory.entries);
        const container = $('#tib-memory-entries');
        if (!rows.length) {
            const empty = document.createElement('p');
            empty.className = 'tib-hint';
            empty.textContent = '档案是空的。点下面的「总结当前形象」建一份。';
            container.replaceChildren(empty);
        } else {
            container.replaceChildren(...rows.map(([name, description]) => {
                const item = document.createElement('div');
                item.className = 'tib-memory-entry';
                const head = document.createElement('div');
                head.className = 'tib-memory-head';
                const title = document.createElement('strong');
                title.textContent = name;
                const remove = document.createElement('button');
                remove.type = 'button'; remove.className = 'tib-memory-remove'; remove.dataset.memoryRemove = name;
                remove.setAttribute('aria-label', `从形象档案里删除 ${name}`);
                remove.textContent = '×';
                head.append(title, remove);
                const text = document.createElement('p');
                text.className = 'tib-memory-text';
                text.textContent = description;
                item.append(head, text);
                return item;
            }));
        }
        $('#tib-memory-preview').textContent = settings.memoryInject === false
            ? '（已关闭：生图时不会带上形象档案）'
            : (formatAppearanceBlock(memory, { user: getContext().name1 || '' }) || '（档案为空，暂时不会附加内容）');
    }
    function setTab(name) {
        const tab = name === 'memory' ? 'memory' : 'image';
        settings.activeTab = tab; persistSettings();
        for (const button of root.querySelectorAll('[data-tab]')) button.setAttribute('aria-selected', String(button.dataset.tab === tab));
        $('#tib-pane-image').hidden = tab !== 'image';
        $('#tib-pane-memory').hidden = tab !== 'memory';
        $('.tib-actions').hidden = tab !== 'image';
        if (tab === 'memory') renderMemory();
    }
    function setMemoryBusy(value) {
        for (const action of ['memory-summary', 'memory-diff', 'memory-clear', 'memory-models']) $(`[data-action="${action}"]`).disabled = value;
        $('[data-action="memory-cancel"]').hidden = !value;
        $('#tib-pane-memory').setAttribute('aria-busy', String(value));
    }
    function memoryFailure(error, controller, config) {
        if (controller.signal.aborted) {
            return controller.signal.reason === 'timeout'
                ? '等待超时。代理可能仍在处理，档案未改动。'
                : '已取消，档案未改动。';
        }
        return safeError(error, config.memoryApiKey);
    }
    async function runMemoryModels() {
        if (memoryJob) return;
        const config = { ...settings };
        const controller = new AbortController();
        memoryJob = controller; setMemoryBusy(true);
        memoryProgress('正在读取模型列表…');
        try {
            const connection = memoryConnection(config);
            const body = await apiRequest(connection, 'models', { signal: controller.signal, requestHeaders: getContext().getRequestHeaders() });
            if (!Array.isArray(body.data)) throw new Error('模型接口没有返回 data 数组。');
            const names = body.data.map(model => model.id).filter(name => typeof name === 'string').sort();
            $('#tib-memory-models').replaceChildren(...names.map(name => new Option(name, name)));
            renderModelList(names, 'memory');
            toggleModelList(true, 'memory');
            memoryProgress(`已读取 ${names.length} 个模型，点一个即可选用；列表不保证都能做总结。`, 'success');
        } catch (error) {
            memoryProgress(safeError(error, config.memoryApiKey), 'error');
        } finally {
            memoryJob = null; setMemoryBusy(false);
        }
    }
    async function runMemory(kind) {
        if (memoryJob) return;
        const config = { ...settings };
        const controller = new AbortController();
        memoryJob = controller; setMemoryBusy(true);
        const seconds = Number(config.memoryTimeoutSeconds);
        const timeout = setTimeout(() => controller.abort('timeout'), (Number.isFinite(seconds) && seconds >= 30 ? seconds : 180) * 1000);
        const startedAt = Date.now();
        const label = kind === 'summary' ? `正在总结最近 ${config.memoryFloors} 层聊天` : '正在对比最新一层回复';
        const progress = () => memoryProgress(`${label}… ${Math.floor((Date.now() - startedAt) / 1000)} 秒`);
        progress();
        const clock = setInterval(progress, 1000);
        try {
            if (kind === 'summary') {
                const result = await service.summarize(config, controller.signal);
                writeMemory({ entries: mergeEntries(memory.entries, result.entries), floor: result.index + 1, model: result.model, kind: 'summary' });
                memoryProgress(`已总结 ${Object.keys(result.entries).length} 个角色（读了 ${result.count} 层）。`, 'success');
            } else {
                const result = await service.diff(config, memory, controller.signal);
                lastDiff = { index: result.index, text: result.text };
                if (!result.updated) {
                    memoryProgress('最新一层没有外形变化，档案未改动（NoUpdate）。', 'success');
                } else {
                    writeMemory({ entries: result.entries, floor: result.index + 1, model: result.model, kind: 'diff' });
                    memoryProgress(`已更新 ${result.changed.join('、')} 的形象。`, 'success');
                }
            }
            renderMemory();
        } catch (error) {
            memoryProgress(memoryFailure(error, controller, config), controller.signal.aborted ? 'warning' : 'error');
        } finally {
            clearInterval(clock); clearTimeout(timeout); memoryJob = null; setMemoryBusy(false);
        }
    }
    async function autoMemory() {
        if (!mounted) return;
        const plan = planMemoryDiff(settings, {
            chat: getContext().chat, running: Boolean(memoryJob),
            stopped: Date.now() - stoppedAt < 1500, last: lastDiff,
        });
        if (!plan.run) return;
        await runMemory('diff');
    }
    function dropMemoryEntry(name) {
        const entries = { ...memory.entries };
        delete entries[name];
        writeMemory({ ...memory, entries });
        memoryProgress(`已从档案里删除 ${name}。`);
    }
    function position() {
        const max = Math.max(12, innerHeight - 64);
        const fraction = Number.isFinite(settings.floatTop) ? settings.floatTop : 0.7;
        root.style.top = `${Math.max(12, Math.min(max, fraction * innerHeight))}px`;
    }
    // SillyTavern's mobile CSS pins <body> with position:fixed (css/mobile-styles.css), which collapses
    // <html> to zero height — and <html> stays the containing block for fixed elements because it carries
    // a transform/perspective (public/style.css). A panel anchored with `bottom` is therefore laid out
    // entirely above the viewport on phones (the launcher survives because it is anchored with `top`).
    // So pin the panel from the top, using the live viewport height.
    function placePanel() {
        if (panel.hidden) return;
        const gap = parseFloat(getComputedStyle(root).getPropertyValue('--tib-panel-gap')) || 24;
        const viewport = Number.isFinite(globalThis.visualViewport?.height) && globalThis.visualViewport.height > 0
            ? Math.min(innerHeight, globalThis.visualViewport.height)
            : innerHeight;
        panel.style.top = `${Math.max(8, viewport - gap - panel.offsetHeight)}px`;
    }
    function wake() { clearTimeout(hideTimer); root.classList.remove('tib-docked'); }
    function scheduleHide() {
        clearTimeout(hideTimer);
        if (settings.autoHide && !opened && !root.contains(document.activeElement)) hideTimer = setTimeout(() => root.classList.add('tib-docked'), 2200);
    }
    function open() {
        opened = true; lastFocus = document.activeElement; panel.hidden = false;
        placePanel();
        memory = readMemory(); setTab(settings.activeTab);
        launcher.setAttribute('aria-expanded', 'true'); wake(); refreshTargets();
        $('[data-action="close"]').focus();
    }
    function close() {
        opened = false; panel.hidden = true; launcher.setAttribute('aria-expanded', 'false');
        toggleModelList(false);
        if (root.contains(document.activeElement)) (lastFocus?.isConnected ? lastFocus : launcher).focus();
        scheduleHide();
    }
    function refreshPrompt() {
        try {
            const ctx = getContext(), target = resolveTargetIndex(ctx.chat, selectedIndex);
            const info = buildPrompt(ctx, settings, target, memory);
            $('#tib-context-info').textContent = `读取截至第 ${target + 1} 层的 ${info.count} 层有效聊天；图片附在第 ${target + 1} 层。`;
            $('#tib-prompt').textContent = info.prompt;
        } catch (error) {
            $('#tib-context-info').textContent = safeError(error);
            $('#tib-prompt').textContent = '当前没有可发送的内容。';
        }
    }
    function refreshTargets() {
        const select = $('#tib-target');
        select.replaceChildren(new Option('最新有效楼层', '-1'));
        const rows = eligibleMessages(getContext().chat);
        for (const { message, index } of rows.slice(-100).reverse()) select.add(new Option(`第 ${index + 1} 层 · ${message.name || (message.is_user ? '用户' : '角色')}`, String(index)));
        if (selectedIndex !== -1 && ![...select.options].some(option => Number(option.value) === selectedIndex)) selectedIndex = -1;
        select.value = String(selectedIndex); refreshPrompt(); updateRetryLabel();
    }
    function setBusy(value) {
        for (const action of ['generate', 'models', 'retry', 'discard']) $(`[data-action="${action}"]`).disabled = value;
        $('[data-action="cancel"]').hidden = !value;
        $('.tib-busy-dot').hidden = !value;
        root.classList.toggle('tib-busy', value);
        panel.setAttribute('aria-busy', String(value));
        if (!value) clearInterval(clockTimer);
    }
    // 等待期间只在正文里插一个纯展示的占位：不写聊天数据，图片就位前先占好位置。
    function clearPlaceholder() {
        clearInterval(placeholder?.timer);
        placeholder?.node.remove();
        placeholder = null;
    }
    function setPlaceholderLabel(text) {
        if (placeholder) placeholder.text.data = text;
    }
    function showPlaceholder(index, text) {
        clearPlaceholder();
        const block = document.querySelector(`#chat .mes[mesid="${index}"]`)?.querySelector('.mes_block');
        if (!block) return;
        const node = document.createElement('div');
        node.className = 'tib-placeholder';
        node.setAttribute('role', 'status');
        node.setAttribute('aria-live', 'polite');
        const frame = document.createElement('div');
        frame.className = 'tib-placeholder-frame';
        // Reserve the final aspect ratio so the reply does not jump when the image lands.
        frame.style.aspectRatio = String(settings.size).includes('x') ? settings.size.replace('x', ' / ') : '1 / 1';
        const shimmer = document.createElement('span');
        shimmer.className = 'tib-placeholder-shimmer';
        const dots = document.createElement('span');
        dots.className = 'tib-placeholder-dots';
        dots.append(...Array.from({ length: 3 }, () => document.createElement('i')));
        frame.append(shimmer, dots);
        const label = document.createElement('div');
        label.className = 'tib-placeholder-label';
        const dot = document.createElement('i');
        const textNode = document.createTextNode(text);
        label.append(dot, textNode);
        node.append(frame, label);
        block.append(node);
        const queuedAt = Date.now();
        const timer = setInterval(() => setPlaceholderLabel(`${text} · ${Math.floor((Date.now() - queuedAt) / 1000)} 秒`), 1000);
        placeholder = { node, text: textNode, timer };
    }
    function showResult(result) {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        const bytes = Uint8Array.from(atob(result.image.base64), char => char.charCodeAt(0));
        previewUrl = URL.createObjectURL(new Blob([bytes], { type: result.image.mime }));
        $('#tib-image').src = previewUrl;
        $('#tib-image-link').href = previewUrl;
        $('#tib-download').href = previewUrl;
        $('#tib-download').download = `tavern-image-${result.id}.${result.image.format}`;
        $('#tib-result').hidden = false;
        updateRetryLabel();
    }
    function updateRetryLabel() {
        const button = $('[data-action="retry"]');
        button.hidden = !pending || pending.saved;
        if (!pending) return;
        button.textContent = pending.detached && !pending.boundTarget ? '插入当前所选楼层' : '重试保存并插入';
    }
    async function saveAndAttach(result, signal, manual = false) {
        status('图片已生成，正在保存到酒馆…');
        setPlaceholderLabel('正在把插画保存到酒馆…');
        await service.persist(result, signal);
        signal?.throwIfAborted();
        let target = result.boundTarget || result.target;
        if (manual && result.detached && !result.boundTarget) {
            const ctx = getContext(); target = captureTarget(ctx, resolveTargetIndex(ctx.chat, selectedIndex));
        }
        const index = await service.attach(result, target);
        status(`已保存，图片已插入第 ${index + 1} 层。`, 'success');
        updateRetryLabel();
    }
    function showFailure(error, config, controller) {
        if (error instanceof TargetChangedError) {
            if (pending) pending.detached = true;
            status(error.message, 'warning');
        } else if (controller.signal.aborted) {
            const reason = controller.signal.reason;
            status(reason === 'timeout' ? '等待超时。代理可能仍在处理，请检查代理日志后再决定是否重新生成。' : '已停止等待。代理是否终止生成取决于服务端；已返回的图片仍可保存。', 'warning');
        } else status(safeError(error, config.apiKey), 'error');
        updateRetryLabel();
    }
    async function run(action, targetIndex = selectedIndex, automatic = false) {
        if (job) return;
        const config = { ...settings };
        const controller = new AbortController(); job = controller; setBusy(true);
        const seconds = Number(config.timeoutSeconds);
        const timeout = setTimeout(() => controller.abort('timeout'), (Number.isFinite(seconds) && seconds >= 30 ? seconds : 600) * 1000);
        try {
            if (action === 'models') {
                status('正在读取模型列表…');
                const body = await apiRequest(config, 'models', { signal: controller.signal, requestHeaders: getContext().getRequestHeaders() });
                if (!Array.isArray(body.data)) throw new Error('模型接口没有返回 data 数组。');
                const names = body.data.map(model => model.id).filter(name => typeof name === 'string').sort();
                $('#tib-models').replaceChildren(...names.map(name => new Option(name, name)));
                renderModelList(names);
                toggleModelList(true);
                status(`已读取 ${names.length} 个模型。可输入或选择图片模型；列表不保证该模型有生图权限。`, 'success');
            } else if (action === 'retry' && pending) {
                await saveAndAttach(pending, controller.signal, true);
            } else if (action === 'generate') {
                if (pending && !pending.saved) throw new Error('上一张图片还未插入。请先使用“重试保存并插入”或“插入当前所选楼层”，以免丢失结果。');
                persistSettings(); refreshPrompt(); startedAt = Date.now();
                const floor = resolveTargetIndex(getContext().chat, targetIndex);
                showPlaceholder(floor, `正在绘制插画 · ${config.model}`);
                const showProgress = () => status(`${automatic ? '模型回复已结束，自动生成插画' : '正在生成场景插画'}… ${Math.floor((Date.now() - startedAt) / 1000)} 秒`);
                showProgress(); clockTimer = setInterval(showProgress, 1000);
                const result = await service.generate(config, floor, controller.signal, memory);
                pending = result; clearInterval(clockTimer); showResult(result);
                await saveAndAttach(result, controller.signal);
            }
        } catch (error) { showFailure(error, config, controller); }
        finally { clearPlaceholder(); clearTimeout(timeout); job = null; setBusy(false); }
    }

    async function autoRun() {
        if (!mounted) return;
        const plan = planAutoGeneration(settings, {
            chat: getContext().chat, running: Boolean(job),
            pending: Boolean(pending && !pending.saved), stopped: Date.now() - stoppedAt < 1500,
        });
        if (!plan.run) return;
        await run('generate', plan.index, true);
    }

    for (const input of root.querySelectorAll('[data-setting]')) {
        const key = input.dataset.setting;
        if (input.type === 'checkbox') input.checked = Boolean(settings[key]); else input.value = settings[key];
        listen(input, 'input', () => {
            settings[key] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
            persistSettings(); refreshPrompt(); refreshTransportHint(); wake(); scheduleHide();
            if (key === 'model') { syncModelSelection('image'); toggleModelList(false, 'image'); }
            if (key === 'memoryModel') { syncModelSelection('memory'); toggleModelList(false, 'memory'); }
            if (key.startsWith('memory')) renderMemory();
        });
    }
    listen($('#tib-target'), 'change', event => { selectedIndex = Number(event.target.value); refreshPrompt(); });
    listen($('#tib-preview'), 'toggle', refreshPrompt);
    listen($('#tib-memory-details'), 'toggle', renderMemory);
    listen(root, 'click', event => {
        const tab = event.target.closest('[data-tab]')?.dataset.tab;
        if (tab) { setTab(tab); return; }
        const item = event.target.closest('.tib-model-item');
        if (item) { applyModel(item.dataset.model, item.closest('#tib-memory-model-list') ? 'memory' : 'image'); return; }
        const removeName = event.target.closest('[data-memory-remove]')?.dataset.memoryRemove;
        if (removeName) { dropMemoryEntry(removeName); return; }
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'model-list' || action === 'memory-model-list') { toggleModelList(undefined, action === 'memory-model-list' ? 'memory' : 'image'); return; }
        if (action === 'memory-models') { void runMemoryModels(); return; }
        if (action === 'memory-summary' || action === 'memory-diff') { void runMemory(action === 'memory-summary' ? 'summary' : 'diff'); return; }
        if (action === 'memory-cancel') { memoryJob?.abort('user'); return; }
        if (action === 'memory-clear') {
            const button = $('[data-action="memory-clear"]');
            if (button.dataset.armed === 'true') {
                button.dataset.armed = 'false'; button.textContent = '清空档案';
                writeMemory({ entries: {}, floor: 0, model: memory.model, kind: '' });
                memoryProgress('已清空这个聊天的形象档案。');
            } else {
                button.dataset.armed = 'true'; button.textContent = '再点一次确认清空';
                memoryProgress('再点一次就会删掉当前聊天的形象档案（只影响档案，不动聊天和图片）。', 'warning');
                setTimeout(() => { button.dataset.armed = 'false'; button.textContent = '清空档案'; }, 4000);
            }
            return;
        }
        if (action === 'close') close();
        if (action === 'cancel') job?.abort('user');
        if (action === 'discard' && !job) {
            pending = null;
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            previewUrl = null; $('#tib-result').hidden = true; $('#tib-image').removeAttribute('src');
            updateRetryLabel(); status('已清除预览。已插入楼层的图片不受影响。');
        }
        if (['generate', 'models', 'retry'].includes(action)) void run(action);
    });
    listen(launcher, 'click', () => {
        const swallowed = swallowClick && Date.now() < swallowClickUntil;
        swallowClick = false;
        if (!swallowed) opened ? close() : open();
    });
    listen(root, 'pointerenter', wake); listen(root, 'pointerleave', scheduleHide);
    listen(root, 'focusin', wake); listen(root, 'focusout', () => setTimeout(scheduleHide, 0));
    listen(document, 'keydown', event => { if (event.key === 'Escape' && opened) { close(); event.stopPropagation(); } });
    listen(document, 'pointerdown', event => { if (opened && !root.contains(event.target)) close(); });
    listen(window, 'resize', () => { position(); placePanel(); });
    const panelObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(placePanel) : null;
    panelObserver?.observe(panel);
    // The launcher is toggled on pointerup, not on click: a finger that drifts a few pixels
    // must not lose the tap to the browser's compatibility click, and a real drag must not
    // swallow the next tap. Touch pointers get the browser-grade slop (~10px), a mouse does not.
    const DRAG_SLOP = { touch: 14, pen: 12, mouse: 4 };
    listen(root, 'pointerdown', event => {
        if (event.button !== 0) return;
        const onLauncher = launcher.contains(event.target);
        if (!onLauncher && event.target !== root) return;
        drag = { y: event.clientY, top: root.getBoundingClientRect().top, slop: DRAG_SLOP[event.pointerType] || DRAG_SLOP.mouse, moved: false, onLauncher };
        if (onLauncher) { try { launcher.setPointerCapture(event.pointerId); } catch { /* capture is optional: retargeting only helps the drag */ } }
        wake();
    });
    listen(root, 'pointermove', event => {
        if (!drag?.onLauncher) return;
        const delta = event.clientY - drag.y;
        if (Math.abs(delta) > drag.slop) drag.moved = true;
        if (drag.moved) { settings.floatTop = Math.max(12, Math.min(innerHeight - 64, drag.top + delta)) / innerHeight; position(); }
    });
    listen(root, 'pointerup', () => {
        if (!drag) return;
        const moved = drag.moved; drag = null;
        swallowClick = true; swallowClickUntil = Date.now() + 700; // this gesture is handled here; the click it also emits must not toggle twice
        if (moved) { persistSettings(); scheduleHide(); return; }
        opened ? close() : open();
    });
    listen(root, 'pointercancel', () => { drag = null; });

    const listeners = [];
    for (const name of ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_DELETED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'GENERATION_ENDED', 'GENERATION_STOPPED']) {
        const type = context.eventTypes?.[name];
        if (!type) continue;
        const handler = () => {
            if (name === 'CHAT_CHANGED') { selectedIndex = -1; clearPlaceholder(); memory = readMemory(); lastDiff = null; renderMemory(); }
            if (name === 'GENERATION_STOPPED') stoppedAt = Date.now();
            // ST emits GENERATION_ENDED from hideStopButton(), which stopGeneration() also calls,
            // and GENERATION_STOPPED follows in the same tick: defer so a manual stop wins.
            if (name === 'GENERATION_ENDED') setTimeout(() => { void autoRun(); void autoMemory(); }, 0);
            if (opened) refreshTargets();
        };
        context.eventSource.on(type, handler); listeners.push([type, handler]);
    }
    const entry = document.createElement('button');
    entry.type = 'button'; entry.className = 'menu_button'; entry.textContent = '打开酒馆生图';
    entry.title = 'CLIProxyAPI 图片生成设置';
    document.querySelector('#extensions_settings2, #extensions_settings')?.append(entry);
    listen(entry, 'click', open);
    position(); refreshTargets(); refreshTransportHint(); setTab(settings.activeTab); scheduleHide();
    mounted = { destroy() {
        job?.abort('disabled'); memoryJob?.abort('disabled'); lifetime.abort(); clearTimeout(hideTimer); clearInterval(clockTimer); clearPlaceholder();
        panelObserver?.disconnect();
        for (const [type, handler] of listeners) context.eventSource.removeListener?.(type, handler);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        root.remove(); entry.remove(); mounted = null;
    } };
}

export function onDisable() { mounted?.destroy(); }
export function onEnable() { mount(); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
