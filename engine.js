// 纯函数：查找与替换逻辑，不依赖酒馆，可单独测试。

/**
 * @typedef {object} SearchOptions
 * @property {string} find 要查找的文字或正则表达式
 * @property {string} replace 替换为
 * @property {boolean} useRegex 是否按正则解析 find
 * @property {boolean} caseSensitive 是否区分大小写
 * @property {boolean} skipMacros 是否跳过 {{...}} 宏内部的匹配
 */

/**
 * @typedef {object} Match
 * @property {number} start 匹配起点
 * @property {number} end 匹配终点（不含）
 * @property {string} text 被匹配到的原文
 * @property {string} replacement 该处将替换成的文字
 */

export function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 根据选项构造正则。正则写法错误时抛出异常。
 * @param {SearchOptions} options
 * @returns {RegExp}
 */
export function buildRegExp(options) {
    const source = options.useRegex ? options.find : escapeRegExp(options.find);
    const flags = 'g' + (options.caseSensitive ? '' : 'i');
    return new RegExp(source, flags);
}

/**
 * 展开正则替换模板中的 $&、$1、$<name>、$$ 等。
 * @param {string} template
 * @param {RegExpExecArray} m
 * @returns {string}
 */
export function expandReplacement(template, m) {
    return template.replace(/\$(\$|&|`|'|<([^>]*)>|(\d{1,2}))/g, (whole, token, name, digits) => {
        if (token === '$') return '$';
        if (token === '&') return m[0];
        if (token === '`') return m.input.slice(0, m.index);
        if (token === '\'') return m.input.slice(m.index + m[0].length);
        if (name !== undefined) {
            return m.groups && name in m.groups ? (m.groups[name] ?? '') : whole;
        }
        // 先尝试两位数分组，不存在再退回一位数，与 String.prototype.replace 的行为一致
        let n = Number(digits);
        if (n > 0 && n < m.length) return m[n] ?? '';
        if (digits.length === 2) {
            n = Number(digits[0]);
            if (n > 0 && n < m.length) return (m[n] ?? '') + digits[1];
        }
        return whole;
    });
}

/**
 * 找出文本中所有 {{...}} 宏所在的区间。
 * @param {string} text
 * @returns {Array<[number, number]>}
 */
export function findMacroRanges(text) {
    const ranges = [];
    const re = /\{\{[\s\S]*?\}\}/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        ranges.push([m.index, m.index + m[0].length]);
    }
    return ranges;
}

/**
 * 在一段文本中查找所有匹配。
 * @param {string} text
 * @param {RegExp} re 必须带 g 标志
 * @param {SearchOptions} options
 * @returns {Match[]}
 */
export function findMatches(text, re, options) {
    if (typeof text !== 'string' || text.length === 0) return [];
    const macros = options.skipMacros ? findMacroRanges(text) : [];
    const matches = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (m[0].length === 0) {
            // 零宽匹配没有可替换的文字，跳过以免死循环
            re.lastIndex++;
            continue;
        }
        const insideMacro = macros.some(([a, b]) => start < b && end > a);
        if (!insideMacro) {
            const replacement = options.useRegex ? expandReplacement(options.replace, m) : options.replace;
            matches.push({ start, end, text: m[0], replacement });
        }
    }
    return matches;
}

/**
 * 只把选中的匹配替换掉，其余保持原样。
 * @param {string} text
 * @param {Match[]} matches 按 start 升序、互不重叠
 * @returns {string}
 */
export function applyMatches(text, matches) {
    let out = '';
    let cursor = 0;
    for (const match of matches) {
        out += text.slice(cursor, match.start) + match.replacement;
        cursor = match.end;
    }
    return out + text.slice(cursor);
}

/**
 * 截取匹配前后的上下文，供预览显示。
 * @param {string} text
 * @param {Match} match
 * @param {number} radius
 */
export function getContextSnippet(text, match, radius = 30) {
    const from = Math.max(0, match.start - radius);
    const to = Math.min(text.length, match.end + radius);
    return {
        before: (from > 0 ? '…' : '') + text.slice(from, match.start),
        after: text.slice(match.end, to) + (to < text.length ? '…' : ''),
    };
}
