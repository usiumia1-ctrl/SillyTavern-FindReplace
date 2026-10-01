import { applyMatches, buildRegExp, findMatches, getContextSnippet } from './engine.js';

const MODULE = 'findReplace';
const POPUP_TEXT = 1;
const POPUP_CONFIRM = 2;
const POPUP_AFFIRMATIVE = 1;

const WI_FIELDS = [
    { id: 'content', label: '内容' },
    { id: 'comment', label: '标题/备注' },
    { id: 'key', label: '主关键词' },
    { id: 'keysecondary', label: '次关键词' },
];

// mirror：卡片顶层（V1）的同名字段，保存时一起写，避免两边内容不一致
const CHAR_FIELDS = [
    { id: 'description', label: '描述', mirror: 'description' },
    { id: 'personality', label: '性格', mirror: 'personality' },
    { id: 'scenario', label: '场景', mirror: 'scenario' },
    { id: 'first_mes', label: '开场白', mirror: 'first_mes' },
    { id: 'alternate_greetings', label: '备选开场白' },
    { id: 'mes_example', label: '对话示例', mirror: 'mes_example' },
    { id: 'system_prompt', label: '系统提示词' },
    { id: 'post_history_instructions', label: '历史后指令' },
    { id: 'creator_notes', label: '创作者备注', mirror: 'creatorcomment' },
    { id: 'character_book', label: '内嵌世界书' },
];

const BOOK_ENTRY_FIELDS = [
    { id: 'content', label: '内容' },
    { id: 'comment', label: '标题/备注' },
    { id: 'keys', label: '主关键词' },
    { id: 'secondary_keys', label: '次关键词' },
];

const DEFAULT_SETTINGS = {
    useRegex: false,
    caseSensitive: true,
    skipMacros: true,
    downloadBackup: true,
    wiFields: ['content', 'comment', 'key', 'keysecondary'],
    charFields: CHAR_FIELDS.map(f => f.id),
};

/** 上一次替换前的备份，用于撤销 */
let lastBackup = null;
/** 当前搜索结果 */
let results = [];
let searchedOptions = null;

const ctx = () => SillyTavern.getContext();

function getSettings() {
    const all = ctx().extensionSettings;
    all[MODULE] = Object.assign({}, structuredClone(DEFAULT_SETTINGS), all[MODULE]);
    return all[MODULE];
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ───────────── 文档加载：把世界书/角色卡拆成可查找的“格子”（slot） ─────────────

/**
 * 字符串字段或字符串数组字段 → slot 列表
 * @param {object} owner 字段所在对象
 * @param {string} field
 * @param {string} keyPrefix slot 的稳定标识前缀
 * @param {string} label
 * @param {() => void} onChange
 */
function makeSlots(owner, field, keyPrefix, label, onChange) {
    const value = owner?.[field];
    if (typeof value === 'string') {
        return [{
            key: keyPrefix,
            label,
            get: () => owner[field],
            set: (v) => { owner[field] = v; onChange(); },
        }];
    }
    if (Array.isArray(value)) {
        return value.map((item, i) => typeof item !== 'string' ? null : {
            key: `${keyPrefix}.${i}`,
            label: `${label} ${i + 1}`,
            get: () => owner[field][i],
            set: (v) => { owner[field][i] = v; onChange(); },
        }).filter(Boolean);
    }
    return [];
}

function entryTitle(entry, uid) {
    const name = entry.comment || entry.name || '';
    return `条目 #${uid}${name ? `「${name}」` : ''}`;
}

async function loadWorldDoc(name, fields) {
    const raw = await ctx().loadWorldInfo(name);
    if (!raw || typeof raw.entries !== 'object') {
        throw new Error(`无法读取世界书「${name}」`);
    }
    const data = structuredClone(raw);
    const doc = { id: `wi:${name}`, kind: 'wi', name, title: `📖 世界书「${name}」`, data, original: structuredClone(raw), changed: false, slots: [] };
    const markChanged = () => { doc.changed = true; };
    const entries = Object.values(data.entries).sort((a, b) => (a.displayIndex ?? a.uid) - (b.displayIndex ?? b.uid));
    for (const entry of entries) {
        for (const f of WI_FIELDS) {
            if (!fields.includes(f.id)) continue;
            doc.slots.push(...makeSlots(entry, f.id, `entries.${entry.uid}.${f.id}`, `${entryTitle(entry, entry.uid)} · ${f.label}`, markChanged));
        }
    }
    return doc;
}

function findCharIndex(avatar) {
    return ctx().characters.findIndex(c => c.avatar === avatar);
}

async function loadCharDoc(avatar, fields) {
    let chid = findCharIndex(avatar);
    if (chid === -1) throw new Error(`找不到角色 ${avatar}`);
    // 角色列表默认是“精简版”数据，先拉取完整卡片
    await ctx().unshallowCharacter?.(chid);
    chid = findCharIndex(avatar);
    const fresh = ctx().characters[chid];

    const data = structuredClone(fresh.data ?? {});
    // 统一以 data.* 为准，缺失时回退到顶层（V1）字段
    for (const f of CHAR_FIELDS) {
        if (f.mirror && typeof data[f.id] !== 'string' && typeof fresh[f.mirror] === 'string') {
            data[f.id] = fresh[f.mirror];
        }
    }

    const doc = { id: `char:${avatar}`, kind: 'char', avatar, name: fresh.name, title: `👤 角色「${fresh.name}」`, data, original: structuredClone(data), changedFields: new Set(), slots: [] };
    for (const f of CHAR_FIELDS) {
        if (!fields.includes(f.id)) continue;
        const markChanged = () => doc.changedFields.add(f.id);
        if (f.id === 'character_book') {
            const entries = data.character_book?.entries;
            if (!Array.isArray(entries)) continue;
            entries.forEach((entry, i) => {
                const uid = entry.id ?? i;
                for (const bf of BOOK_ENTRY_FIELDS) {
                    doc.slots.push(...makeSlots(entry, bf.id, `book.${i}.${bf.id}`, `内嵌世界书 · ${entryTitle(entry, uid)} · ${bf.label}`, markChanged));
                }
            });
        } else {
            doc.slots.push(...makeSlots(data, f.id, f.id, f.label, markChanged));
        }
    }
    return doc;
}

function loadDoc(ref, settings) {
    return ref.kind === 'wi'
        ? loadWorldDoc(ref.name, settings.wiFields)
        : loadCharDoc(ref.avatar, settings.charFields);
}

// ───────────── 保存 / 备份 / 恢复 ─────────────

/** 由 data 中指定字段构造 merge-attributes 请求体 */
function buildCharPayload(avatar, data, fieldIds) {
    const payload = { avatar, data: {} };
    for (const id of fieldIds) {
        const def = CHAR_FIELDS.find(f => f.id === id);
        payload.data[id] = structuredClone(data[id]);
        if (def?.mirror) payload[def.mirror] = data[id];
    }
    return payload;
}

async function saveCharPayload(payload) {
    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        let message = response.statusText;
        try { message = (await response.json()).message ?? message; } catch { /* 忽略 */ }
        throw new Error(`保存角色 ${payload.avatar} 失败：${message}`);
    }
    await ctx().getOneCharacter(payload.avatar);
    refreshCharacterEditor(payload.avatar);
}

/** 如果改的是当前打开的角色，同步编辑面板里的文本框，防止旧内容被自动保存回去 */
function refreshCharacterEditor(avatar) {
    const c = ctx();
    const chid = findCharIndex(avatar);
    if (chid === -1 || String(c.characterId) !== String(chid)) return;
    const ch = c.characters[chid];
    $('#description_textarea').val(ch.description);
    $('#personality_textarea').val(ch.personality);
    $('#scenario_pole').val(ch.scenario);
    $('#firstmessage_textarea').val(ch.first_mes);
    $('#mes_example_textarea').val(ch.mes_example);
    $('#creator_notes_textarea').val(ch.data?.creator_notes || ch.creatorcomment);
    $('#system_prompt_textarea').val(ch.data?.system_prompt || '');
    $('#post_history_instructions_textarea').val(ch.data?.post_history_instructions || '');
}

async function saveWorld(name, data) {
    const c = ctx();
    await c.saveWorldInfo(name, data, true);
    c.reloadWorldInfoEditor?.(name);
}

function downloadJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 恢复备份（撤销也走这里）
 * @param {{docs: Array}} backup
 */
async function restoreBackup(backup) {
    if (!backup || !Array.isArray(backup.docs)) throw new Error('备份文件格式不对');
    let ok = 0;
    const errors = [];
    for (const doc of backup.docs) {
        try {
            if (doc.kind === 'wi') {
                await saveWorld(doc.name, structuredClone(doc.data));
            } else if (doc.kind === 'char') {
                await saveCharPayload(doc.payload);
            }
            ok++;
        } catch (e) {
            errors.push(e.message);
        }
    }
    await ctx().updateWorldInfoList?.();
    return { ok, errors };
}

// ───────────── 界面 ─────────────

function buildPanel(settings) {
    const c = ctx();
    const worldNames = c.getWorldInfoNames?.() ?? [];
    const chars = c.characters.map((ch, i) => ({ avatar: ch.avatar, name: ch.name, current: String(i) === String(c.characterId) }));

    const fieldBoxes = (list, selected, group) => list.map(f =>
        `<label class="checkbox_label"><input type="checkbox" data-group="${group}" value="${f.id}" ${selected.includes(f.id) ? 'checked' : ''}>${f.label}</label>`).join('');

    const html = `
<div class="fr-root">
    <h3>世界书 / 角色卡 查找替换</h3>
    <div class="fr-inputs">
        <label>查找<textarea id="fr_find" class="text_pole" rows="1" placeholder="要查找的文字"></textarea></label>
        <label>替换为<textarea id="fr_replace" class="text_pole" rows="1" placeholder="留空即删除"></textarea></label>
    </div>
    <div class="fr-options">
        <label class="checkbox_label" title="开启后可使用 $1、$<name> 引用分组"><input type="checkbox" id="fr_regex" ${settings.useRegex ? 'checked' : ''}>正则表达式</label>
        <label class="checkbox_label"><input type="checkbox" id="fr_case" ${settings.caseSensitive ? 'checked' : ''}>区分大小写</label>
        <label class="checkbox_label" title="不改动 {{char}}、{{user}} 等宏里面的文字"><input type="checkbox" id="fr_macros" ${settings.skipMacros ? 'checked' : ''}>跳过 {{宏}}</label>
        <label class="checkbox_label"><input type="checkbox" id="fr_backup" ${settings.downloadBackup ? 'checked' : ''}>替换前下载备份文件</label>
    </div>
    <div class="fr-scopes">
        <fieldset class="fr-scope" data-kind="wi">
            <legend>世界书（${worldNames.length}）</legend>
            <div class="fr-scope-tools">
                <input type="search" class="text_pole fr-filter" placeholder="筛选名字">
                <div class="menu_button fr-all">全选</div><div class="menu_button fr-none">全不选</div>
            </div>
            <div class="fr-list">${worldNames.map(n => `<label class="checkbox_label" data-name="${escapeHtml(n)}"><input type="checkbox" value="${escapeHtml(n)}">${escapeHtml(n)}</label>`).join('') || '<i>没有世界书</i>'}</div>
            <div class="fr-fields">${fieldBoxes(WI_FIELDS, settings.wiFields, 'wiFields')}</div>
        </fieldset>
        <fieldset class="fr-scope" data-kind="char">
            <legend>角色卡（${chars.length}）</legend>
            <div class="fr-scope-tools">
                <input type="search" class="text_pole fr-filter" placeholder="筛选名字">
                <div class="menu_button fr-all">全选</div><div class="menu_button fr-none">全不选</div>
            </div>
            <div class="fr-list">${chars.map(ch => `<label class="checkbox_label" data-name="${escapeHtml(ch.name)}"><input type="checkbox" value="${escapeHtml(ch.avatar)}" ${ch.current ? 'checked' : ''}>${escapeHtml(ch.name)}${ch.current ? '（当前）' : ''}</label>`).join('') || '<i>没有角色</i>'}</div>
            <div class="fr-fields">${fieldBoxes(CHAR_FIELDS, settings.charFields, 'charFields')}</div>
        </fieldset>
    </div>
    <div class="fr-actions">
        <div class="menu_button" id="fr_search"><i class="fa-solid fa-magnifying-glass"></i> 搜索</div>
        <div class="menu_button" id="fr_check_all">全部勾选</div>
        <div class="menu_button" id="fr_check_none">全部取消</div>
        <div class="menu_button" id="fr_apply"><i class="fa-solid fa-right-left"></i> 替换勾选项</div>
        <div class="menu_button" id="fr_undo"><i class="fa-solid fa-rotate-left"></i> 撤销上次替换</div>
        <div class="menu_button" id="fr_restore"><i class="fa-solid fa-file-import"></i> 从备份文件恢复</div>
        <input type="file" id="fr_restore_file" accept=".json,application/json" hidden>
    </div>
    <div class="fr-status"></div>
    <div class="fr-results"></div>
</div>`;

    const $root = $(html);
    bindPanel($root, settings);
    return $root;
}

function setStatus($root, text, isError = false) {
    $root.find('.fr-status').text(text).toggleClass('fr-error', isError);
}

function readOptions($root) {
    return {
        find: String($root.find('#fr_find').val() ?? ''),
        replace: String($root.find('#fr_replace').val() ?? ''),
        useRegex: $root.find('#fr_regex').prop('checked'),
        caseSensitive: $root.find('#fr_case').prop('checked'),
        skipMacros: $root.find('#fr_macros').prop('checked'),
    };
}

function saveOptions($root, settings) {
    const o = readOptions($root);
    settings.useRegex = o.useRegex;
    settings.caseSensitive = o.caseSensitive;
    settings.skipMacros = o.skipMacros;
    settings.downloadBackup = $root.find('#fr_backup').prop('checked');
    settings.wiFields = $root.find('input[data-group="wiFields"]:checked').map((_, el) => el.value).get();
    settings.charFields = $root.find('input[data-group="charFields"]:checked').map((_, el) => el.value).get();
    ctx().saveSettingsDebounced();
}

function selectedRefs($root) {
    const refs = [];
    $root.find('.fr-scope[data-kind="wi"] .fr-list input:checked').each((_, el) => refs.push({ kind: 'wi', name: el.value }));
    $root.find('.fr-scope[data-kind="char"] .fr-list input:checked').each((_, el) => refs.push({ kind: 'char', avatar: el.value }));
    return refs;
}

function bindPanel($root, settings) {
    $root.on('input', '.fr-filter', function () {
        const q = String($(this).val()).toLowerCase();
        $(this).closest('.fr-scope').find('.fr-list > label').each((_, el) => {
            $(el).toggle(String(el.dataset.name).toLowerCase().includes(q));
        });
    });
    $root.on('click', '.fr-all, .fr-none', function () {
        const checked = $(this).hasClass('fr-all');
        $(this).closest('.fr-scope').find('.fr-list > label:visible input').prop('checked', checked);
    });
    $root.on('change', '.fr-options input, .fr-fields input', () => saveOptions($root, settings));

    $root.on('change', '.fr-doc-toggle', function () {
        $(this).closest('.fr-doc').find('.fr-match input').prop('checked', this.checked).trigger('change');
    });
    $root.on('change', '.fr-match input', function () {
        const [d, s, m] = String(this.dataset.ref).split(':').map(Number);
        results[d].slots[s].matches[m].checked = this.checked;
        updateCount($root);
    });
    $root.find('#fr_check_all, #fr_check_none').on('click', function () {
        $root.find('.fr-match input, .fr-doc-toggle').prop('checked', this.id === 'fr_check_all');
        results.forEach(r => r.slots.forEach(s => s.matches.forEach(m => { m.checked = this.id === 'fr_check_all'; })));
        updateCount($root);
    });

    $root.find('#fr_search').on('click', () => runSearch($root, settings));
    $root.find('#fr_apply').on('click', () => runApply($root, settings));
    $root.find('#fr_undo').on('click', () => runUndo($root));
    $root.find('#fr_restore').on('click', () => $root.find('#fr_restore_file').trigger('click'));
    $root.find('#fr_restore_file').on('change', async function () {
        const file = this.files?.[0];
        this.value = '';
        if (!file) return;
        try {
            const backup = JSON.parse(await file.text());
            const count = backup?.docs?.length ?? 0;
            const answer = await ctx().callGenericPopup(`要用备份文件「${escapeHtml(file.name)}」恢复 ${count} 个世界书/角色吗？当前内容会被覆盖。`, POPUP_CONFIRM);
            if (answer !== POPUP_AFFIRMATIVE) return;
            const { ok, errors } = await restoreBackup(backup);
            reportRestore($root, ok, errors, '已从备份恢复');
        } catch (e) {
            setStatus($root, `恢复失败：${e.message}`, true);
        }
    });
}

function updateCount($root) {
    const total = results.reduce((n, r) => n + r.slots.reduce((k, s) => k + s.matches.length, 0), 0);
    const checked = results.reduce((n, r) => n + r.slots.reduce((k, s) => k + s.matches.filter(m => m.checked).length, 0), 0);
    setStatus($root, `共找到 ${total} 处，已勾选 ${checked} 处。`);
}

async function runSearch($root, settings) {
    saveOptions($root, settings);
    const options = readOptions($root);
    results = [];
    searchedOptions = null;
    $root.find('.fr-results').empty();

    if (!options.find) return setStatus($root, '请先输入要查找的内容。', true);
    let re;
    try {
        re = buildRegExp(options);
    } catch (e) {
        return setStatus($root, `正则表达式有误：${e.message}`, true);
    }
    const refs = selectedRefs($root);
    if (refs.length === 0) return setStatus($root, '请至少勾选一个世界书或角色。', true);

    const errors = [];
    for (let i = 0; i < refs.length; i++) {
        setStatus($root, `正在搜索 ${i + 1}/${refs.length}…`);
        try {
            const doc = await loadDoc(refs[i], settings);
            const slots = doc.slots
                .map(slot => {
                    const text = slot.get();
                    return { key: slot.key, label: slot.label, text, matches: findMatches(text, re, options).map(m => ({ ...m, checked: true })) };
                })
                .filter(s => s.matches.length > 0);
            if (slots.length > 0) results.push({ ref: refs[i], title: doc.title, slots });
        } catch (e) {
            errors.push(e.message);
        }
    }
    searchedOptions = { ...options };
    renderResults($root);
    updateCount($root);
    if (errors.length) setStatus($root, `${$root.find('.fr-status').text()} 有 ${errors.length} 个读取失败：${errors.join('；')}`, true);
}

function renderResults($root) {
    const parts = results.map((r, d) => {
        const total = r.slots.reduce((n, s) => n + s.matches.length, 0);
        const slotsHtml = r.slots.map((s, si) => {
            const rows = s.matches.map((m, mi) => {
                const { before, after } = getContextSnippet(s.text, m);
                return `<label class="fr-match"><input type="checkbox" data-ref="${d}:${si}:${mi}" ${m.checked ? 'checked' : ''}>`
                    + `<span class="fr-snippet">${escapeHtml(before)}<del>${escapeHtml(m.text)}</del><ins>${escapeHtml(m.replacement)}</ins>${escapeHtml(after)}</span></label>`;
            }).join('');
            return `<div class="fr-slot"><div class="fr-slot-label">${escapeHtml(s.label)}</div>${rows}</div>`;
        }).join('');
        return `<details class="fr-doc" open><summary><input type="checkbox" class="fr-doc-toggle" checked> ${escapeHtml(r.title)} — ${total} 处</summary>${slotsHtml}</details>`;
    });
    $root.find('.fr-results').html(parts.join('') || '<i>没有找到匹配。</i>');
}

async function runApply($root, settings) {
    const picked = results
        .map(r => ({ ...r, slots: r.slots.map(s => ({ ...s, matches: s.matches.filter(m => m.checked) })).filter(s => s.matches.length) }))
        .filter(r => r.slots.length);
    const count = picked.reduce((n, r) => n + r.slots.reduce((k, s) => k + s.matches.length, 0), 0);
    if (count === 0) return setStatus($root, '没有勾选任何匹配，请先搜索。', true);

    const current = readOptions($root);
    if (searchedOptions && (current.find !== searchedOptions.find || current.replace !== searchedOptions.replace)) {
        return setStatus($root, '查找或替换内容在搜索后被修改过，请重新搜索再替换。', true);
    }

    const answer = await ctx().callGenericPopup(`确定替换 ${count} 处吗？涉及 ${picked.length} 个世界书/角色。`, POPUP_CONFIRM);
    if (answer !== POPUP_AFFIRMATIVE) return;

    // 重新读取最新数据，确认文字没有在搜索之后被别处改动
    const backup = { type: 'st-find-replace-backup', version: 1, createdAt: new Date().toISOString(), find: searchedOptions?.find, replace: searchedOptions?.replace, docs: [] };
    const toSave = [];
    let stale = 0;
    const errors = [];
    for (const r of picked) {
        try {
            const doc = await loadDoc(r.ref, settings);
            const byKey = new Map(doc.slots.map(s => [s.key, s]));
            for (const s of r.slots) {
                const slot = byKey.get(s.key);
                if (!slot || slot.get() !== s.text) {
                    stale += s.matches.length;
                    continue;
                }
                slot.set(applyMatches(s.text, s.matches));
            }
            if (doc.kind === 'wi' && doc.changed) {
                backup.docs.push({ kind: 'wi', name: doc.name, data: doc.original });
                toSave.push(doc);
            } else if (doc.kind === 'char' && doc.changedFields.size) {
                backup.docs.push({ kind: 'char', avatar: doc.avatar, name: doc.name, payload: buildCharPayload(doc.avatar, doc.original, [...doc.changedFields]) });
                toSave.push(doc);
            }
        } catch (e) {
            errors.push(e.message);
        }
    }

    if (toSave.length === 0) {
        return setStatus($root, `没有可以替换的内容。${stale ? `有 ${stale} 处在搜索后被改动过，已跳过，请重新搜索。` : ''}${errors.join('；')}`, true);
    }

    if ($root.find('#fr_backup').prop('checked')) {
        const stamp = backup.createdAt.replace(/[:.]/g, '-');
        downloadJson(backup, `find-replace-backup-${stamp}.json`);
    }
    lastBackup = backup;

    let saved = 0;
    for (const doc of toSave) {
        try {
            if (doc.kind === 'wi') {
                await saveWorld(doc.name, doc.data);
            } else {
                await saveCharPayload(buildCharPayload(doc.avatar, doc.data, [...doc.changedFields]));
            }
            saved++;
        } catch (e) {
            errors.push(e.message);
        }
    }

    results = [];
    $root.find('.fr-results').empty();
    let msg = `已替换并保存 ${saved} 个世界书/角色。`;
    if (stale) msg += ` 有 ${stale} 处在搜索后被改动过，已跳过。`;
    if (errors.length) msg += ` 出错：${errors.join('；')}`;
    setStatus($root, msg, errors.length > 0);
    toastr.success(`查找替换：已保存 ${saved} 个文件`);
}

async function runUndo($root) {
    if (!lastBackup) return setStatus($root, '本次会话中还没有可以撤销的替换。', true);
    const answer = await ctx().callGenericPopup(`撤销上次替换，恢复 ${lastBackup.docs.length} 个世界书/角色到替换前的状态？`, POPUP_CONFIRM);
    if (answer !== POPUP_AFFIRMATIVE) return;
    const { ok, errors } = await restoreBackup(lastBackup);
    if (errors.length === 0) lastBackup = null;
    results = [];
    $root.find('.fr-results').empty();
    reportRestore($root, ok, errors, '已撤销');
}

function reportRestore($root, ok, errors, prefix) {
    setStatus($root, `${prefix}：恢复了 ${ok} 个世界书/角色。${errors.length ? ` 出错：${errors.join('；')}` : ''}`, errors.length > 0);
    if (errors.length === 0) toastr.success(`${prefix}，恢复了 ${ok} 个文件`);
}

async function openPanel() {
    const settings = getSettings();
    results = [];
    searchedOptions = null;
    const $panel = buildPanel(settings);
    const popup = new (ctx().Popup)($panel, POPUP_TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: '关闭' });
    await popup.show();
}

// ───────────── 入口 ─────────────

jQuery(() => {
    getSettings();

    const menuItem = $(`
<div id="fr_open_menu" class="list-group-item flex-container flexGap5" title="批量查找替换世界书和角色卡中的文字">
    <div class="fa-solid fa-right-left extensionsMenuExtensionButton"></div>
    <span>查找替换</span>
</div>`);
    menuItem.on('click', openPanel);
    $('#extensionsMenu').append(menuItem);

    const drawer = $(`
<div class="fr-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>查找替换（世界书/角色卡）</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <p>批量查找并替换世界书条目和角色卡里的文字。也可以从输入框旁的魔杖菜单打开。</p>
            <div class="menu_button" id="fr_open_settings"><i class="fa-solid fa-right-left"></i> 打开查找替换</div>
        </div>
    </div>
</div>`);
    drawer.find('#fr_open_settings').on('click', openPanel);
    $('#extensions_settings2').append(drawer);
});
