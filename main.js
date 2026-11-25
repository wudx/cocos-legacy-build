'use strict';

/**
 * cocos-legacy-build  （已合并 build-progress-inject，单扩展一体）
 *
 * 作用一：在「项目」菜单加「打开旧版构建发布」，打开编辑器内置的 builder.old 面板。
 * 作用二：把构建进度直接显示在这个经典面板里，不新开窗口。
 *
 * 关键点（3.8.x 的分栏结构）：
 *   面板 UI 不在 document 上，而在
 *     #dock 的 shadowRoot → <panel-frame name="builder.old"> 的 shadowRoot
 *   里，所以所有查询都必须穿透 shadow DOM。
 *
 * 显示策略（从「最像原生」到「兜底」）：
 *   1. 面板卡片里已经有 ui-progress（构建中才渲染）→ 把真实百分比写进它的 value；
 *   2. 有 ui-progress 元素但组件被 repack 弄丢（未知元素、量不到尺寸）
 *      → 就在该元素内部自绘一根（不注册全局自定义元素，避免抢注册）；
 *   3. 连卡片进度条都没有 → 才在面板底部补一条 30px 的条，构建结束自动消失。
 *
 * 删掉本文件夹即完全还原（既不注入进度，也不多出菜单项）。
 */

const fs = require('fs');
const path = require('path');

const TAG = '[build-progress]';
const AGENT_VERSION = 15;

let logStream = null;
let logInit = false;
let timer = null;
let ticking = false;
let queryBrokenUntil = 0;
let dumpCount = 0;
let nextDumpAt = 0;
let pushProbe = 0;

const liveTasks = new Map();
const loggedStage = new Map();

/* 任务列表刷新：面板只在打开时查询一次任务，之后新建的任务不会出现在列表里。
   这里记下见过的任务 id，一旦有新增就重载一次面板窗口让它自己重新查询。 */
const knownTaskIds = new Set();
const taskNames = new Map();
let taskIdsSeeded = false;
let lastListReloadAt = 0;
let lastTaskSig = '';
let lastRemovedIds = [];

/* ------------------------------------------------------------------ 日志 */

function safeJson(value) {
    try {
        return JSON.stringify(value);
    } catch (e) {
        return String(value);
    }
}

function logFilePath() {
    try {
        const base = (Editor && Editor.Project && Editor.Project.path) || process.cwd();
        return path.join(base, 'temp', 'build-progress-inject.log');
    } catch (e) {
        return '';
    }
}

function initLog() {
    if (logInit) return;
    logInit = true;
    try {
        const file = logFilePath();
        if (!file) return;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try {
            if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.1');
        } catch (e) { /* 首次运行 */ }
        logStream = fs.createWriteStream(file, { flags: 'a' });
    } catch (e) {
        logStream = null;
    }
}

function log() {
    const args = Array.prototype.slice.call(arguments);
    const line = new Date().toISOString() + ' ' + args.map(function (a) {
        return typeof a === 'string' ? a : safeJson(a);
    }).join(' ');
    try { console.log(TAG, line); } catch (e) { /* ignore */ }
    initLog();
    try { if (logStream) logStream.write(line + '\n'); } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------- electron */

function getElectron() {
    const attempts = [
        function () { return require('electron'); },
        function () { return process.mainModule && process.mainModule.require('electron'); },
        function () { return require('module').createRequire(process.execPath)('electron'); }
    ];
    for (let i = 0; i < attempts.length; i++) {
        try {
            const mod = attempts[i]();
            if (mod && mod.BrowserWindow) return mod;
        } catch (e) { /* 换下一种 */ }
    }
    return null;
}

/* --------------------------------------------------- 面板列表即时刷新 */

/* 任务增删后把构建面板窗口整个重载，让它自己重新查询任务列表 */
function reloadBuilderPanelsNow(reason) {
    if (Date.now() - lastListReloadAt < 5000) return;
    const electron = getElectron();
    if (!electron) return;
    try {
        const wins = electron.BrowserWindow.getAllWindows();
        let reloaded = 0;
        for (let i = 0; i < wins.length; i++) {
            const win = wins[i];
            if (!win || win.isDestroyed()) continue;
            const info = windowInfo(win);
            if (!info.url && !info.title) continue;
            if (!isBuilderPanel(info)) continue;
            const wc = win.webContents;
            if (!wc || wc.isDestroyed() || wc.isLoading()) continue;
            wc.reload();
            reloaded++;
        }
        if (reloaded) {
            lastListReloadAt = Date.now();
            log(reason, '已重载经典面板以刷新任务列表');
            setTimeout(function () { tick(); }, 1500);
        }
    } catch (e) {
        log('重载面板失败:', String((e && e.message) || e));
    }
}

/* ------------------------------------------------------------ 任务数据 */

function pickList(raw) {
    if (!raw) return null;
    if (Array.isArray(raw)) return raw;
    const keys = ['list', 'tasks', 'taskMap', 'data'];
    for (let i = 0; i < keys.length; i++) {
        const cand = raw[keys[i]];
        if (Array.isArray(cand)) return cand;
        if (cand && typeof cand === 'object') {
            const values = [];
            Object.keys(cand).forEach(function (k) {
                const v = cand[k];
                if (v && typeof v === 'object' && ('state' in v)) values.push(v);
            });
            if (values.length) return values;
        }
    }
    return null;
}

function fromProfile() {
    try {
        const base = (Editor && Editor.Project && Editor.Project.path) || '';
        if (!base) return null;
        const file = path.join(base, 'profiles', 'v2', 'packages', 'builder.json');
        const json = JSON.parse(fs.readFileSync(file, 'utf8'));
        const map = (json.BuildTaskManager && json.BuildTaskManager.taskMap) || json.taskMap || null;
        return map ? Object.keys(map).map(function (k) { return map[k]; }) : null;
    } catch (e) {
        return null;
    }
}

async function queryTasks() {
    if (Date.now() < queryBrokenUntil) return null;
    try {
        const raw = await Editor.Message.request('builder', 'query-tasks-info');
        const list = pickList(raw);
        if (!list) {
            queryBrokenUntil = Date.now() + 5000;
            log('query-tasks-info 结构未识别:', safeJson(raw).slice(0, 200));
        }
        return list;
    } catch (e) {
        queryBrokenUntil = Date.now() + 5000;
        log('query-tasks-info 调用失败:', String((e && e.message) || e));
        return null;
    }
}

function toItem(task) {
    const options = (task && task.options) || {};
    return {
        id: String((task && task.id) || ''),
        name: options.taskName || options.outputName || options.name || String((task && task.id) || ''),
        platform: options.platform || '',
        state: (task && task.state) || '',
        progress: typeof (task && task.progress) === 'number' ? task.progress : 0,
        message: (task && task.message) || '',
        stage: (task && task.stage) || ''
    };
}

async function collect() {
    const base = (await queryTasks()) || fromProfile() || [];
    const merged = new Map();
    base.forEach(function (t) { if (t && t.id) merged.set(t.id, t); });
    liveTasks.forEach(function (t, id) { merged.set(id, t); });
    const list = [];
    merged.forEach(function (t) { list.push(toItem(t)); });
    return list;
}

/* ------------------------------------------------------ 实时任务广播 */

function registerBroadcasts() {
    ['builder:task-changed', 'builder:task-delete'].forEach(function (name) {
        try {
            Editor.Message.addBroadcastListener(name, function (payload) {
                try {
                    if (name === 'builder:task-delete') {
                        if (payload && payload.id) liveTasks.delete(payload.id);
                        log('广播', name, payload && payload.id);
                        /* 删除广播是即时的（payload 可能为空），直接借此刷新面板列表 */
                        try { reloadBuilderPanelsNow('收到任务删除广播，'); } catch (e) { /* ignore */ }
                        return;
                    }
                    if (Array.isArray(payload)) {
                        payload.forEach(function (t) { if (t && t.id) acceptLive(t); });
                    } else if (payload && payload.id) {
                        acceptLive(payload);
                    }
                } catch (e) { /* ignore */ }
            });
        } catch (e) {
            log('监听广播失败', name, String((e && e.message) || e));
        }
    });
}

function acceptLive(task) {
    liveTasks.set(task.id, task);
    const step = Math.floor((task.progress || 0) * 20);
    const key = task.state + '/' + step;
    if (loggedStage.get(task.id) !== key) {
        loggedStage.set(task.id, key);
        log('广播任务', task.id, task.state, Math.round((task.progress || 0) * 100) + '%', (task.message || '').slice(0, 60));
    }
}

/* --------------------------------------------------------- 注入脚本 */

const BOOTSTRAP = '(' + rendererAgent.toString() + ')()';

function rendererAgent() {
    const V = 15;
    if (window.__buildProgress && window.__buildProgress.version >= V) return 'already';

    const STRIP_ID = 'build-progress-inject-strip';

    /* 重复注入时先清掉旧的那套 */
    try {
        const oldStrip = document.getElementById(STRIP_ID);
        if (oldStrip && oldStrip.parentNode) oldStrip.parentNode.removeChild(oldStrip);
        const oldStyle = document.getElementById(STRIP_ID + '-style');
        if (oldStyle && oldStyle.parentNode) oldStyle.parentNode.removeChild(oldStyle);
    } catch (e) { /* ignore */ }

    let stripEl = null;
    let elName = null;
    let elMsg = null;
    let elPct = null;
    let elFill = null;

    const styledRoots = new WeakSet();
    let lastPush = Date.now();
    let hideTimer = null;
    let usedStrip = false;
    let selfBrokenUntil = 0;

    /* 面板内容藏在 #dock → panel-frame 的两层 shadow DOM 里，必须穿进去 */
    function locateRoot() {
        try {
            if (document.querySelector('.builder')) return document;
            const dock = document.getElementById('dock');
            if (dock && dock.shadowRoot) {
                const frames = dock.shadowRoot.querySelectorAll('panel-frame');
                for (let i = 0; i < frames.length; i++) {
                    const shadow = frames[i].shadowRoot;
                    if (shadow && shadow.querySelector('.builder')) return shadow;
                }
                if (dock.shadowRoot.querySelector('.builder')) return dock.shadowRoot;
            }
            const all = document.querySelectorAll('*');
            for (let i = 0; i < all.length; i++) {
                const shadow = all[i].shadowRoot;
                if (shadow && shadow.querySelector && shadow.querySelector('.builder')) return shadow;
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    /* 底部兜底条（挂最外层 document，覆盖整个面板窗口底部） */
    function ensureStrip() {
        if (stripEl && stripEl.parentNode) return;
        let styleEl = document.getElementById(STRIP_ID + '-style');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = STRIP_ID + '-style';
            styleEl.textContent =
                '#' + STRIP_ID + '{position:fixed;left:0;right:0;bottom:0;height:30px;display:none;align-items:center;gap:8px;' +
                'padding:0 10px;z-index:2147483000;box-sizing:border-box;' +
                'background:rgba(32,32,34,.97);border-top:1px solid rgba(255,255,255,.12);display:none;' +
                'font:12px/1 -apple-system,"Segoe UI",Arial,sans-serif;color:#cfcfcf;pointer-events:none;}' +
                '#' + STRIP_ID + '.on{display:flex;}' +
                '#' + STRIP_ID + ' .bp-name{font-weight:600;color:#fff;max-width:38%;margin-right:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
                '#' + STRIP_ID + ' .bp-msg{flex:1;margin-right:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.72;}' +
                '#' + STRIP_ID + ' .bp-pct{min-width:38px;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}' +
                '#' + STRIP_ID + ' .bp-bar{position:absolute;left:0;bottom:0;height:3px;width:100%;background:rgba(255,255,255,.09);}' +
                '#' + STRIP_ID + ' .bp-bar i{display:block;height:100%;width:0;background:#2f6feb;transition:width .2s linear;}' +
                '#' + STRIP_ID + '.ok .bp-bar i{background:#2fa84f;}' +
                '#' + STRIP_ID + '.err .bp-bar i{background:#d24b45;}';
            document.head.appendChild(styleEl);
        }
        try {
            const dup = document.querySelectorAll('#' + STRIP_ID);
            for (let i = dup.length - 1; i >= 0; i--) {
                if (dup[i].parentNode) dup[i].parentNode.removeChild(dup[i]);
            }
        } catch (e) { /* ignore */ }
        stripEl = document.createElement('div');
        stripEl.id = STRIP_ID;
        stripEl.innerHTML = '<span class="bp-name"></span><span class="bp-msg"></span><span class="bp-pct"></span><span class="bp-bar"><i></i></span>';
        document.body.appendChild(stripEl);
        elName = stripEl.querySelector('.bp-name');
        elMsg = stripEl.querySelector('.bp-msg');
        elPct = stripEl.querySelector('.bp-pct');
        elFill = stripEl.querySelector('.bp-bar i');
    }

    /* ui-progress 没被注册时，在面板根里加一套「就地绘制」用样式 */
    function ensureRootStyle(root) {
        if (styledRoots.has(root)) return;
        styledRoots.add(root);
        try {
            if (root.querySelector && root.querySelector('style[data-bp-style]')) return;
            const s = document.createElement('style');
            s.setAttribute('data-bp-style', '1');
            s.textContent =
                'ui-progress[data-bp]{display:block;height:100%;min-height:18px;position:relative;overflow:hidden;' +
                'border-radius:4px;background:rgba(128,128,128,.22);}' +
                '.bp-inline{display:flex;flex-direction:column;gap:6px;padding:4px 0;}' +
                '.bp-inline-bar{height:8px;border-radius:4px;background:rgba(128,128,128,.25);overflow:hidden;}' +
                '.bp-inline-bar i{display:block;height:100%;width:0;background:#2f6feb;transition:width .2s linear;}' +
                '.bp-inline-msg{font-size:12px;line-height:16px;color:#b9b9b9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
                '.bp-inline.ok .bp-inline-bar i{background:#2fa84f;}' +
                '.bp-inline.err .bp-inline-bar i{background:#d24b45;}' +
                'ui-progress[data-bp] .bp-fill{position:absolute;left:0;top:0;bottom:0;width:0;background:#2f6feb;' +
                'transition:width .2s linear;}' +
                'ui-progress[data-bp] .bp-txt{position:absolute;left:0;right:0;top:0;bottom:0;display:flex;' +
                'align-items:center;justify-content:center;font:12px/1 -apple-system,"Segoe UI",Arial,sans-serif;color:#fff;}';
            root.appendChild(s);
        } catch (e) { /* ignore */ }
    }

    let markedSection = null;

    /* 底部条出现时，把面板列表的滚动区往上顶 36px，避免压住最后一张卡的按钮 */
    function markStrip(root, on) {
        try {
            const builderEl = root.querySelector ? root.querySelector('.builder') : null;
            const section = builderEl && builderEl.querySelector('section');
            if (!section) return;
            if (on) {
                if (section.getAttribute('data-bp-pad') === null) {
                    section.setAttribute('data-bp-pad', section.style.paddingBottom || '');
                }
                section.style.paddingBottom = '36px';
                markedSection = section;
            } else {
                const target = markedSection || section;
                const prev = target.getAttribute('data-bp-pad');
                if (prev !== null) {
                    target.style.paddingBottom = prev;
                    target.removeAttribute('data-bp-pad');
                }
                if (markedSection === target) markedSection = null;
            }
        } catch (e) { /* ignore */ }
    }

    /* --- 在任务卡里画进度：优先用面板自带 ui-progress，没有就自己补一块 --- */
    let inline = null;

    /* 结束态处理：见过「有任务在跑」之后才认「全部结束」这个转折，
       转折后写满进度条、稍停一瞬就重载面板，让面板按当前数据渲染出
       干净的原生完成态卡片（不然原生卡的转圈、构建日志没人收，会一直残留）。 */
    let hadActiveTask = false;
    let resultReloadTimer = null;

    function findCard(root, name) {
        const cards = root.querySelectorAll('.task');
        if (!cards || !cards.length || !name) return null;
        for (let i = 0; i < cards.length; i++) {
            const nameEl = cards[i].querySelector('.name');
            if (nameEl && (nameEl.textContent || '').trim() === name) return cards[i];
        }
        return null;
    }

    /* query-tasks-info 的 progress 跳得很稀疏（实测 12 秒只跳 4 次），
       这里做缓动补间：拿到新目标值后把条子匀速滚过去，真数据再来就原地改目标，
       永远不会超前于真实进度。 */
    let barAnim = null;

    function stopBarAnim() {
        if (barAnim && barAnim.raf) { try { cancelAnimationFrame(barAnim.raf); } catch (e) { /* ignore */ } }
        barAnim = null;
    }

    function setBarValue(bar, v) {
        const s = String(v);
        if (bar.getAttribute('value') !== s) {
            bar.setAttribute('value', s);
            bar.setAttribute('percent', '');
        }
    }

    function animateBarTo(bar, wanted) {
        const from = parseFloat(bar.getAttribute('value')) || 0;
        if (wanted <= from) { stopBarAnim(); setBarValue(bar, wanted); return; }
        stopBarAnim();
        barAnim = {
            bar: bar, from: from, to: wanted, t0: Date.now(),
            dur: Math.min(2500, Math.max(400, (wanted - from) * 45)), raf: 0
        };
        const step = function () {
            if (!barAnim) return;
            const k = Math.min(1, (Date.now() - barAnim.t0) / barAnim.dur);
            const eased = 1 - (1 - k) * (1 - k);
            setBarValue(barAnim.bar, Math.round((barAnim.from + (barAnim.to - barAnim.from) * eased) * 10) / 10);
            if (k < 1) barAnim.raf = requestAnimationFrame(step);
            else barAnim = null;
        };
        barAnim.raf = requestAnimationFrame(step);
    }

    function applyToBar(bar, pct) {
        if (!bar) return false;
        if (customElements.get('ui-progress')) {
            animateBarTo(bar, pct);
            return true;
        }
        if (bar.getAttribute('data-bp') !== '1') {
            bar.setAttribute('data-bp', '1');
            bar.innerHTML = '<i class="bp-fill"></i><span class="bp-txt"></span>';
        }
        const fill = bar.querySelector('.bp-fill');
        const txt = bar.querySelector('.bp-txt');
        if (fill) fill.style.width = pct + '%';
        if (txt) txt.textContent = pct > 0 ? pct + '%' : '';
        return true;
    }

    function clearInline() {
        if (!inline) return;
        try {
            if (inline.logEl) inline.logEl.style.display = inline.prevDisplay || '';
            if (inline.node && inline.node.parentNode) inline.node.parentNode.removeChild(inline.node);
        } catch (e) { /* ignore */ }
        inline = null;
    }

    /* 返回 true = 已经把进度画在这张任务卡里了 */
    function paintInCard(root, active) {
        const card = findCard(root, active.name);
        if (!card) return false;

        const pct = Math.round(Math.max(0, Math.min(1, active.progress || 0)) * 100);
        const nativeBar = card.querySelector('ui-progress');
        if (nativeBar) {
            clearInline();
            return applyToBar(nativeBar, pct);
        }

        const section = card.querySelector('section');
        if (!section) return false;

        if (!inline || inline.card !== card) {
            clearInline();
            try {
                const stray = card.querySelectorAll('.bp-inline');
                for (let i = 0; i < stray.length; i++) {
                    if (stray[i].parentNode) stray[i].parentNode.removeChild(stray[i]);
                }
            } catch (e) { /* ignore */ }
            const node = document.createElement('div');
            node.className = 'bp-inline';
            node.innerHTML = '<div class="bp-inline-bar"><i></i></div><span class="bp-inline-msg"></span>';
            const logEl = section.querySelector('.build-log');
            const prevDisplay = logEl ? logEl.style.display : '';
            if (logEl) logEl.style.display = 'none';
            section.insertBefore(node, section.firstChild);
            inline = {
                card: card,
                name: active.name,
                node: node,
                fill: node.querySelector('.bp-inline-bar i'),
                msg: node.querySelector('.bp-inline-msg'),
                logEl: logEl,
                prevDisplay: prevDisplay,
                done: false
            };
        }

        inline.done = false;
        if (inline.node) inline.node.classList.remove('ok', 'err');
        if (inline.fill) inline.fill.style.width = pct + '%';
        if (inline.msg) inline.msg.textContent = pct + '%  ' + ((active.message || active.stage || '').slice(0, 100));
        return true;
    }

    /* 结束时在卡片里收个尾，6 秒后把卡片交还给面板自己渲染 */
    function finishInline(list) {
        if (!inline || inline.done) return false;
        let result = null;
        for (let i = 0; i < list.length; i++) {
            if (list[i].name === inline.name && (list[i].state === 'success' || list[i].state === 'failure' || list[i].state === 'cancel')) {
                result = list[i];
                break;
            }
        }
        if (!result) return false;
        const ok = result.state === 'success';
        inline.done = true;
        if (inline.node) inline.node.classList.add(ok ? 'ok' : 'err');
        if (inline.fill) inline.fill.style.width = '100%';
        if (inline.msg) {
            const matched = /in\s+(\d+)\s*s/i.exec(result.message || '');
            const label = ok ? '构建成功' : (result.state === 'cancel' ? '已取消' : '构建失败');
            inline.msg.textContent = matched ? label + '，用时 ' + matched[1] + ' 秒' : label;
        }
        setTimeout(function () { clearInline(); }, 6000);
        return true;
    }

    /* 结束态：面板自己不会把卡片从「构建中」刷成结果，转圈/日志会一直残留。
       与其逐个元素清理，不如在「全部结束」转折后直接写满进度条、
       稍停一瞬就重载面板，让面板按当前数据渲染出干净的原生完成态卡片。 */
    function paintResultInCard(root, list) {
        if (!hadActiveTask) return;
        const result = pickResult(list);
        if (!result) return;

        /* 重载前把最终进度直接写满原生条（不走补间，马上就要重载了） */
        for (let i = 0; i < list.length; i++) {
            const t = list[i];
            if (t.state !== 'success' && t.state !== 'failure' && t.state !== 'cancel') continue;
            const card = findCard(root, t.name);
            const bar = card && card.querySelector('ui-progress');
            if (!bar) continue;
            const pct = t.state === 'success' ? 100 : Math.round(Math.max(0, Math.min(1, t.progress || 0)) * 100);
            stopBarAnim();
            if (customElements.get('ui-progress')) setBarValue(bar, pct);
            else applyToBar(bar, pct);
        }

        if (resultReloadTimer) return;
        resultReloadTimer = setTimeout(function () {
            resultReloadTimer = null;
            hadActiveTask = false;
            try { location.reload(); } catch (e) { /* ignore */ }
        }, 800);
    }

    function paint(task, pct, state) {
        if (!stripEl) return;
        const ratio = Math.max(0, Math.min(1, (task && task.progress) || 0));
        const percent = Math.max(0, Math.min(100, pct == null ? Math.round(ratio * 100) : pct));
        const running = state === 'processing' || state === 'waiting';
        if (elName) elName.textContent = task.name || task.id || '';
        if (elMsg) elMsg.textContent = (task.message || task.stage || '').slice(0, 120);
        if (!running && elMsg) {
            const matched = /in\s+(\d+)\s*s/i.exec(task.message || '');
            const label = state === 'success' ? '构建成功' : (state === 'cancel' ? '已取消' : '构建失败');
            elMsg.textContent = matched ? label + '，用时 ' + matched[1] + ' 秒' : label;
        }
        if (elPct) {
            if (running) elPct.textContent = percent + '%';
            else elPct.textContent = '';
        }
        if (elFill) elFill.style.width = percent + '%';
        stripEl.classList.remove('ok', 'err');
        if (state === 'success') stripEl.classList.add('ok');
        if (state === 'failure' || state === 'cancel') stripEl.classList.add('err');
    }

    function scheduleHide(delay) {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(function () {
            if (stripEl) stripEl.classList.remove('on', 'ok', 'err');
            if (markedSection) {
                const prev = markedSection.getAttribute('data-bp-pad');
                if (prev !== null) {
                    markedSection.style.paddingBottom = prev;
                    markedSection.removeAttribute('data-bp-pad');
                }
                markedSection = null;
            }
            usedStrip = false;
            hideTimer = null;
        }, delay || 4000);
    }

    function pickActive(list) {
        let processing = null;
        let waiting = null;
        for (let i = 0; i < list.length; i++) {
            if (list[i].state === 'processing') { processing = list[i]; break; }
            if (list[i].state === 'waiting' && !waiting) waiting = list[i];
        }
        return processing || waiting;
    }

    function pickResult(list) {
        for (let i = 0; i < list.length; i++) {
            if (list[i].state === 'success' || list[i].state === 'failure' || list[i].state === 'cancel') return list[i];
        }
        return null;
    }

    function push(data) {
        lastPush = Date.now();
        const ret = doPush(data);
        try { if (window.__buildProgress) window.__buildProgress.last = ret; } catch (e) { /* ignore */ }
        return ret;
    }

    function doPush(data) {
        const root = locateRoot();
        if (!root) return { skip: 'no-panel' };
        ensureRootStyle(root);

        const list = (data && data.list) || [];
        const active = pickActive(list);

        if (active) {
            hadActiveTask = true;
            if (resultReloadTimer) { clearTimeout(resultReloadTimer); resultReloadTimer = null; }
            if (paintInCard(root, active)) {
                if (stripEl) stripEl.classList.remove('on');
                markStrip(root, false);
                return { mode: 'card' };
            }
            usedStrip = true;
            ensureStrip();
            if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
            paint(active, Math.round((active.progress || 0) * 100), active.state);
            stripEl.classList.add('on');
            markStrip(root, true);
            const names = [];
            try {
                const cs = root.querySelectorAll('.task');
                for (let i = 0; i < cs.length; i++) {
                    const n = cs[i].querySelector('.name');
                    names.push(n ? (n.textContent || '').trim() : '');
                }
            } catch (e) { /* ignore */ }
            return { mode: 'strip', active: active.name, names: names };
        }

        if (inline) finishInline(list);
        paintResultInCard(root, list);

        if (usedStrip) {
            ensureStrip();
            const result = pickResult(list);
            if (result) {
                paint(result, result.state === 'success' ? 100 : Math.round((result.progress || 0) * 100), result.state);
                stripEl.classList.add('on');
            }
            /* 只有第一次进入结束态时才起计时，否则每 700ms 重置会导致永远不隐藏 */
            if (!hideTimer) scheduleHide(4500);
            return { mode: 'strip-done' };
        }
        if (stripEl) stripEl.classList.remove('on');
        markStrip(root, false);
        return { mode: 'idle' };
    }

    /* 主进程推不动时，自己从面板里取 */
    function pickListLoose(raw) {
        if (!raw) return null;
        if (Array.isArray(raw)) return raw;
        const keys = ['list', 'tasks', 'taskMap', 'data'];
        for (let i = 0; i < keys.length; i++) {
            const cand = raw[keys[i]];
            if (Array.isArray(cand)) return cand;
            if (cand && typeof cand === 'object') {
                const values = [];
                Object.keys(cand).forEach(function (k) {
                    const v = cand[k];
                    if (v && typeof v === 'object' && ('state' in v)) values.push(v);
                });
                if (values.length) return values;
            }
        }
        return null;
    }

    setInterval(function () {
        if (Date.now() - lastPush < 2500) return;
        if (Date.now() < selfBrokenUntil) return;
        if (typeof Editor === 'undefined' || !Editor.Message) return;
        Editor.Message.request('builder', 'query-tasks-info').then(function (raw) {
            const list = pickListLoose(raw);
            if (!list) return;
            push({
                list: list.map(function (t) {
                    const o = (t && t.options) || {};
                    return {
                        id: String((t && t.id) || ''),
                        name: o.taskName || o.outputName || String((t && t.id) || ''),
                        platform: o.platform || '',
                        state: (t && t.state) || '',
                        progress: typeof (t && t.progress) === 'number' ? t.progress : 0,
                        message: (t && t.message) || '',
                        stage: (t && t.stage) || ''
                    };
                })
            });
        }).catch(function () {
            selfBrokenUntil = Date.now() + 8000;
        });
    }, 1200);

    const ready = !!locateRoot();
    window.__buildProgress = { push: push, version: V, ready: ready };
    console.log('[build-progress] 已注入，找到经典面板: ' + ready);
    return ready ? 'ok' : 'waiting-panel';
}

/* --------------------------------------------------------- 窗口选择 */

function windowInfo(win) {
    const info = { url: '', title: '' };
    try { info.url = win.webContents.getURL() || ''; } catch (e) { /* ignore */ }
    try { info.title = win.getTitle() || ''; } catch (e) { /* ignore */ }
    return info;
}

function isBuilderPanel(info) {
    if (/构建发布/.test(info.title)) return true;
    return false;
}

async function tick() {
    if (ticking) return;
    ticking = true;
    try {
        const electron = getElectron();
        if (!electron) {
            if (dumpCount < 1) { dumpCount++; log('拿不到 electron 模块，无法注入面板'); }
            return;
        }

        const wins = electron.BrowserWindow.getAllWindows();
        const targets = [];
        const others = [];
        for (let i = 0; i < wins.length; i++) {
            const win = wins[i];
            if (!win || win.isDestroyed()) continue;
            const info = windowInfo(win);
            if (!info.url && !info.title) continue;
            if (isBuilderPanel(info)) targets.push(win);
            else others.push(info.title + ' | ' + info.url);
        }

        if (!targets.length) {
            const nearBy = others.filter(function (s) { return /build|构建|发布/i.test(s); });
            if (nearBy.length && Date.now() > nextDumpAt) {
                nextDumpAt = Date.now() + 15000;
                log('疑似构建窗口但未命中:', nearBy.join(' ;; ').slice(0, 700));
            } else if (!nearBy.length && dumpCount < 2) {
                dumpCount++;
                log('当前没有构建面板窗口，现有窗口:', others.join(' ;; ').slice(0, 700));
            }
            return;
        }

        const list = await collect();

        /* 诊断：任务状态/进度有变化才记一条日志，量化 query-tasks-info 的更新粒度 */
        let sig = '';
        for (let i = 0; i < list.length; i++) {
            sig += list[i].name + '#' + list[i].state + '#' + Math.round((list[i].progress || 0) * 100) + ' ';
        }
        if (sig !== lastTaskSig) {
            lastTaskSig = sig;
            log('任务状态', sig.trim());
        }

        /* 发现新任务 → 重载一次面板窗口，让面板自己重新查询任务列表。
           knownTaskIds 只增不减，首次 tick 只做播种；5 秒内不重复重载；
           窗口还在加载中时跳过，留到下一轮 tick 再处理。 */
        let taskAdded = false;
        for (let i = 0; i < list.length; i++) {
            const id = list[i].id;
            if (id && !knownTaskIds.has(id)) {
                knownTaskIds.add(id);
                taskNames.set(id, list[i].name);
                if (taskIdsSeeded) taskAdded = true;
            }
        }
        taskIdsSeeded = true;

        /* 任务在别处被删除 → 面板列表同样不会自己刷新，重载一次。
           query 偶发抖动可能返回不全，连续两轮都缺失才认定真删除。 */
        const currentIds = [];
        for (let i = 0; i < list.length; i++) if (list[i].id) currentIds.push(list[i].id);
        const removedIds = [];
        knownTaskIds.forEach(function (id) {
            if (currentIds.indexOf(id) < 0) removedIds.push(id);
        });
        let confirmedRemovals = [];
        if (removedIds.length && lastRemovedIds.length) {
            confirmedRemovals = removedIds.filter(function (id) { return lastRemovedIds.indexOf(id) >= 0; });
        }
        lastRemovedIds = removedIds;
        if (confirmedRemovals.length && Date.now() - lastListReloadAt > 5000) {
            /* 名字要先取出来，然后才把这些 id 从名册里清掉 */
            const names = confirmedRemovals.map(function (id) { return taskNames.get(id) || id; });
            confirmedRemovals.forEach(function (id) { knownTaskIds.delete(id); taskNames.delete(id); });
            let reloaded = 0;
            for (let i = 0; i < targets.length; i++) {
                const win = targets[i];
                if (!win || win.isDestroyed()) continue;
                const wc = win.webContents;
                if (!wc || wc.isDestroyed() || wc.isLoading()) continue;
                wc.reload();
                reloaded++;
            }
            if (reloaded) {
                lastListReloadAt = Date.now();
                log('任务被删除，已重载经典面板以刷新任务列表:', names.join(', '));
                setTimeout(function () { tick(); }, 1500);
                return;
            }
        }
        if (taskAdded && Date.now() - lastListReloadAt > 5000) {
            let reloaded = 0;
            for (let i = 0; i < targets.length; i++) {
                const win = targets[i];
                if (!win || win.isDestroyed()) continue;
                const wc = win.webContents;
                if (!wc || wc.isDestroyed() || wc.isLoading()) continue;
                wc.reload();
                reloaded++;
            }
            if (reloaded) {
                lastListReloadAt = Date.now();
                log('发现新任务，已重载经典面板以刷新任务列表');
                setTimeout(function () { tick(); }, 1500);
                return;
            }
        }

        const payload = JSON.stringify({ list: list, ts: Date.now() });

        for (let i = 0; i < targets.length; i++) {
            const win = targets[i];
            if (!win || win.isDestroyed()) continue;
            const wc = win.webContents;
            if (!wc || wc.isDestroyed()) continue;
            try {
                const alive = await wc.executeJavaScript('(window.__buildProgress && window.__buildProgress.version) || 0', true);
                if (!alive || alive < AGENT_VERSION) {
                    const ret = await wc.executeJavaScript(BOOTSTRAP, true);
                    log('注入面板:', windowInfo(win).title, '=>', ret);
                }
                const ret = await wc.executeJavaScript('window.__buildProgress ? window.__buildProgress.push(' + payload + ') : "no-agent"', true);
                if (pushProbe < 3 && ret && typeof ret === 'object') {
                    pushProbe++;
                    log('push 返回:', safeJson(ret));
                }
            } catch (e) {
                log('注入失败:', String((e && e.message) || e));
            }
        }
    } catch (e) {
        log('tick 异常:', String((e && e.stack) || e));
    } finally {
        ticking = false;
    }
}

/* ------------------------------------------------------------ 菜单入口 */

/**
 * 「项目 -> 打开旧版构建发布」
 * Cocos Creator 3.8.8 把默认入口换成了新版构建页（builder-ui），
 * 但安装包里仍保留经典面板，panel id = builder.old。
 */
async function openLegacyBuilder() {
    try {
        const ret = await Editor.Panel.open('builder.old');
        log('打开经典构建面板 builder.old');
        /* 面板刚打开时窗口标题/URL 还没就绪，连着追几次，尽快把进度条挂上 */
        [200, 600, 1200].forEach(function (delay) {
            setTimeout(function () { tick(); }, delay);
        });
        return ret;
    } catch (e) {
        log('打开经典构建面板失败:', String((e && e.message) || e));
        throw e;
    }
}

exports.methods = { openLegacyBuilder: openLegacyBuilder };

exports.load = function () {
    log('扩展已加载，开始监视构建面板');
    try { registerBroadcasts(); } catch (e) { /* ignore */ }
    tick();
    if (timer) clearInterval(timer);
    timer = setInterval(tick, 700);
};

exports.unload = function () {
    log('扩展已卸载');
    if (timer) { clearInterval(timer); timer = null; }
    try { if (logStream) { logStream.end(); logStream = null; } } catch (e) { /* ignore */ }
};

/* 调试用：允许通过调试桥取出注入脚本，直接 patch 到正在运行的编辑器里 */
exports.__BOOTSTRAP = BOOTSTRAP;
