/**
 * 离线验证：不启动 DSH，用一个假的 ctx 模拟会话事件。
 * 运行：node test/mock.mjs
 * 前置：能解析到 @deepseek-ai/schemastery（在 profile 里直接跑最省事）。
 */
import { apply, Config } from '../index.js';

const LIMIT = 1_000_000;
const appended = [];
const handlers = new Map();

const ctx = {
    on(name, fn) {
        const list = handlers.get(name) ?? [];
        list.push(fn);
        handlers.set(name, list);
        return () => { };
    },
    effect(fn) { fn(); },
    agents: {
        get: id => (id === 's1' ? { inbox: { append: (target, message) => appended.push({ target, message }) } } : undefined),
    },
    llm: {
        async resolveModel() { return { context: { contextWindow: LIMIT } }; },
    },
};

apply(ctx, Config({}));

const session = { id: 's1' };

function emit(used) {
    const event = {
        type: 'assistant/message',
        data: {
            usage: { inputTokens: 0, cacheReadTokens: used, cacheWriteTokens: 0 },
            message: { source: { provider: 'deepseek-account', model: 'deepseek-flash' } },
        },
    };
    for (const fn of handlers.get('session/event') ?? []) fn(session, event);
}

const tick = () => new Promise(r => setTimeout(r, 10));

let failures = 0;
function expect(label, actual, wanted) {
    const ok = actual === wanted;
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, want ${wanted}`);
}

const steps = [
    [500_000, 0, '五成：不吭声'],
    [810_000, 1, '八成：喊一次'],
    [850_000, 1, '还在八成区间：不重复喊'],
    [930_000, 2, '九成二：再喊一次'],
    [990_000, 2, '更高了：不再重复'],
];

for (const [used, wanted, label] of steps) {
    emit(used);
    await tick();
    expect(label, appended.length, wanted);
}

console.log('--- 实际塞进收件箱的内容 ---');
for (const item of appended) {
    console.log(`[${item.target}] ${String(item.message.content?.[0]?.text ?? '').split('\n')[0]}`);
    if (item.message.role !== 'user') failures += 1;
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
