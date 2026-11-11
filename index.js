/**
 * dsh-context-watch — 上下文守夜人
 * ------------------------------------------------------------------
 * 会话不会突然断掉，它是慢慢涨满的。
 * 这个插件只做一件事：在上下文快满的时候喊一声，
 * 带上「现在多大、上限多少、还剩多少」，让 agent 有时间把交接单写完。
 *
 * 它不常驻、不轮询、不占上下文：
 *   · 只订阅 session/event，从 assistant/message 的 usage 里读真实用量
 *   · 只在跨过阈值的那一刻提醒一次（每个阈值每个会话只喊一次）
 *   · 提醒走 agent 的 next-turn 收件箱，和一条普通消息一样
 *
 * 上下文上限来源：模型信息里的 context.contextWindow。
 * 读不到就用 config.fallbackContextWindow。
 */
import { appendFileSync } from 'node:fs';

let z;
try {
    ({ default: z } = await import('@deepseek-ai/schemastery'));
}
catch (error) {
    console.error('[context-watch] 挂载失败：找不到 @deepseek-ai/schemastery。'
        + '插件必须装在 dsh profile 的 node_modules 里。原始错误：'
        + (error instanceof Error ? error.message : String(error)));
    throw error;
}

export const name = 'context-watch';
export const inject = ['sessions', 'agents', 'llm'];

export const Config = z.object({
    enabled: z.boolean().default(true)
        .description('总开关。false 时插件仍然挂载，但什么都不做'),
    thresholds: z.array(z.number()).default([0.8, 0.92])
        .description('提醒阈值（0~1 的占比）。数组里每个值、每个会话只提醒一次；触发时取最高的那个'),
    contextWindow: z.number().default(0)
        .description('上下文上限（token）。0 = 自动从模型信息读取，读不到再用 fallbackContextWindow'),
    fallbackContextWindow: z.number().default(1000000)
        .description('读不到模型上限时的兜底值'),
    notifyAgent: z.boolean().default(true)
        .description('是否把提醒塞进 agent 的下一轮（会触发一次回答，消耗一轮上下文）'),
    logToConsole: z.boolean().default(true)
        .description('是否在 DSH 控制台打印提醒'),
    logFile: z.string().default('')
        .description('可选：把提醒同时追加写进这个文件（每行带时间戳）。留空则不写文件'),
    template: z.string()
        .default('[上下文提醒] 已用 {{used}} / {{limit}}（{{percent}}%），还剩 {{remaining}}。\n'
            + '建议尽快整理交接信息：没做完的事、重要的约定、下次醒来第一件要做的事。')
        .description('提醒文本模板。可用变量：{{used}} {{limit}} {{percent}} {{remaining}} {{threshold}}'),
});

/** 1234567 → "1.23M"，820000 → "820k"，1234 → "1.2k"。 */
function formatTokens(n) {
    if (!Number.isFinite(n) || n < 0) return '?';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2) + 'M';
    if (n >= 1_000) return Math.round(n / 1_000) + 'k';
    return String(Math.round(n));
}

function renderTemplate(template, vars) {
    return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key) => (
        Object.hasOwn(vars, key) ? String(vars[key]) : whole
    ));
}

function usageTotal(usage) {
    if (usage === null || typeof usage !== 'object') return 0;
    const n = v => (Number.isFinite(v) ? v : 0);
    // 一次调用实际塞进模型的 prompt = 新输入 + 命中缓存的前缀 + 新写入缓存的部分
    return n(usage.inputTokens) + n(usage.cacheReadTokens) + n(usage.cacheWriteTokens);
}

export function apply(ctx, config) {
    /** sessionId → { warnedThresholds: Set<number>, lastUsed: number, lastWindow: number } */
    const stateBySession = new Map();
    /** "provider/model" → contextWindow */
    const windowByModel = new Map();
    const thresholds = [...new Set((config.thresholds ?? []).filter(t => Number.isFinite(t) && t > 0 && t <= 1))]
        .sort((a, b) => a - b);

    const logLine = (level, message) => {
        if (config.logToConsole) {
            const text = '[context-watch] ' + message;
            if (level === 'error') console.error(text);
            else if (level === 'warn') console.warn(text);
            else console.log(text);
        }
        if (config.logFile !== '') {
            try {
                appendFileSync(config.logFile,
                    new Date().toISOString() + ' [' + level + '] ' + message + '\n', 'utf8');
            }
            catch { /* 日志写不进去不能影响主流程 */ }
        }
    };

    if (!config.enabled) {
        logLine('info', '已停用（config.enabled = false）');
        return;
    }
    if (thresholds.length === 0) {
        logLine('warn', 'thresholds 里没有有效的阈值，插件不做任何事');
        return;
    }

    /**
     * 问宿主要模型上下文上限。
     * DSH 不同版本把这个数字放在不同方法/不同层级上，所以按顺序试几个，
     * 谁先给出正整数就用谁；都不行就用兜底值。
     */
    async function readContextWindow(provider, model) {
        const llm = ctx.llm;
        const attempts = [];
        if (typeof llm?.resolveModelInfo === 'function') {
            attempts.push(() => llm.resolveModelInfo(provider, model));
        }
        if (typeof llm?.resolveModel === 'function') {
            attempts.push(() => llm.resolveModel(provider, model));
        }
        if (typeof llm?.prepareCall === 'function') {
            attempts.push(() => llm.prepareCall(provider, model));
        }
        for (const attempt of attempts) {
            try {
                const info = await attempt();
                const window = info?.context?.contextWindow
                    ?? info?.contextWindow
                    ?? info?.model?.contextWindow
                    ?? info?.info?.contextWindow;
                if (Number.isInteger(window) && window > 0) return window;
            }
            catch { /* 试下一个 */ }
        }
        return undefined;
    }

    async function resolveContextWindow(provider, model) {
        if (config.contextWindow > 0) return config.contextWindow;
        const key = String(provider) + '/' + String(model);
        const cached = windowByModel.get(key);
        if (cached !== undefined) return cached;
        const detected = await readContextWindow(provider, model);
        const value = detected ?? config.fallbackContextWindow;
        if (detected === undefined) {
            logLine('warn', `读不到 ${key} 的上下文上限，用兜底值 ${formatTokens(value)}。`
                + '可以在 config 里直接写 contextWindow');
        }
        else {
            logLine('info', `${key} 的上下文上限 = ${formatTokens(value)}（自动读取）`);
        }
        windowByModel.set(key, value);
        return value;
    }

    function stateOf(sessionId) {
        let state = stateBySession.get(sessionId);
        if (state === undefined) {
            state = { warnedThresholds: new Set(), lastUsed: 0, lastWindow: 0 };
            stateBySession.set(sessionId, state);
        }
        return state;
    }

    /** 跨过阈值了：喊一声。 */
    function warn(session, { used, window, ratio, crossed }) {
        const percent = Math.round(ratio * 1000) / 10;
        const remaining = Math.max(0, window - used);
        const text = renderTemplate(config.template, {
            used: formatTokens(used),
            limit: formatTokens(window),
            percent: percent.toFixed(percent < 10 ? 1 : 0),
            remaining: formatTokens(remaining),
            threshold: Math.round(crossed * 100) + '%',
        });

        logLine('warn', `${session.id} 已用 ${formatTokens(used)} / ${formatTokens(window)}`
            + `（${percent.toFixed(1)}%），跨过 ${Math.round(crossed * 100)}% 阈值`);

        if (!config.notifyAgent) return;

        const agent = ctx.agents.get(session.id);
        const inbox = agent?.inbox;
        if (inbox === undefined || typeof inbox.append !== 'function') {
            logLine('warn', `${session.id} 没有活着的 agent（或收件箱接口变了），只在控制台提醒`);
            return;
        }
        try {
            inbox.append('next-turn', {
                id: `${session.id}:context-watch:${Math.round(crossed * 100)}:${Date.now()}`,
                role: 'user',
                content: [{ type: 'text', text }],
                source: { kind: 'plugin:context-watch' },
            });
        }
        catch (error) {
            logLine('error', `把提醒塞进 ${session.id} 的收件箱失败：`
                + (error instanceof Error ? error.message : String(error)));
        }
    }

    async function handleSessionEvent(session, event) {
        if (event?.type !== 'assistant/message') return;
        const used = usageTotal(event.data?.usage);
        if (used <= 0) return;

        const source = event.data?.message?.source ?? {};
        const window = await resolveContextWindow(source.provider, source.model);
        if (!Number.isFinite(window) || window <= 0) return;

        const state = stateOf(session.id);
        state.lastUsed = used;
        state.lastWindow = window;

        const ratio = used / window;
        const crossed = thresholds.filter(t => ratio >= t && !state.warnedThresholds.has(t));
        if (crossed.length === 0) return;
        for (const t of crossed) state.warnedThresholds.add(t);
        warn(session, { used, window, ratio, crossed: crossed[crossed.length - 1] });
    }

    const offEvent = ctx.on('session/event', (session, event) => {
        if (session?.id === undefined) return;
        // 事件回调是同步分发，异常必须自己吞掉，不能污染会话。
        void handleSessionEvent(session, event).catch((error) => {
            logLine('error', '处理会话事件失败：' + (error instanceof Error ? error.message : String(error)));
        });
    });

    const offDisposed = ctx.on('session/disposed', (session) => {
        if (session?.id !== undefined) stateBySession.delete(session.id);
    });

    ctx.effect(() => () => {
        offEvent?.();
        offDisposed?.();
        stateBySession.clear();
        windowByModel.clear();
    });

    logLine('info', '已启用，阈值 ' + thresholds.map(t => Math.round(t * 100) + '%').join(' / ')
        + (config.contextWindow > 0 ? `，上限固定 ${formatTokens(config.contextWindow)}` : '，上限自动读取'));
}
