import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyMatches, buildRegExp, findMatches } from '../engine.js';

const run = (text, opts) => {
    const options = { replace: '', useRegex: false, caseSensitive: true, skipMacros: false, ...opts };
    const matches = findMatches(text, buildRegExp(options), options);
    return { matches, result: applyMatches(text, matches) };
};

test('plain text replaces every occurrence', () => {
    assert.equal(run('小明和小明天', { find: '小明', replace: '小红' }).result, '小红和小红天');
});

test('plain text escapes regex characters and ignores $ in replacement', () => {
    assert.equal(run('a.b a+b', { find: 'a.b', replace: '$1&' }).result, '$1& a+b');
});

test('case-insensitive', () => {
    assert.equal(run('Alice alice', { find: 'ALICE', replace: 'Bob', caseSensitive: false }).result, 'Bob Bob');
});

test('regex groups and named groups', () => {
    assert.equal(run('2024-05', { find: '(\\d+)-(\\d+)', replace: '$2/$1', useRegex: true }).result, '05/2024');
    assert.equal(run('ab', { find: '(?<x>a)', replace: '[$<x>]', useRegex: true }).result, '[a]b');
    assert.equal(run('ab', { find: 'a', replace: '$$$&', useRegex: true }).result, '$ab');
});

test('skip macros', () => {
    assert.equal(run('{{char}} 叫 char', { find: 'char', replace: 'X', skipMacros: true }).result, '{{char}} 叫 X');
    assert.equal(run('{{char}} 叫 char', { find: 'char', replace: 'X' }).result, '{{X}} 叫 X');
});

test('zero-length matches do not loop forever', () => {
    assert.equal(run('abc', { find: 'x*', replace: '-', useRegex: true }).matches.length, 0);
});

test('applying a subset only changes selected matches', () => {
    const { matches } = run('猫猫猫', { find: '猫', replace: '狗' });
    assert.equal(applyMatches('猫猫猫', [matches[1]]), '猫狗猫');
});

test('invalid regex throws', () => {
    assert.throws(() => buildRegExp({ find: '(', useRegex: true, caseSensitive: true }));
});
