// === Telegram Relay ===
// Low-level bot wrapper — mirrors discord-relay.js API surface.
//
// Two event streams:
//   command messages  → /help, /listws, /setws
//   regular messages  → relay to Antigravity cascade

const TelegramBot = require('node-telegram-bot-api');

let bot = null;
let chatId = null;
let botUsername = null;
let onReplyCallback = null;
let onCommandCallback = null;
let onEventCallback = null;
let isReady = false;

// ── Format helpers ──────────────────────────────────────────────────────────

function formatNotifyUser({ workspaceName, cascadeIdShort, stepCount, softLimit, content, mentionUserName }) {
    const lines = [];
    if (mentionUserName) lines.push(`@${mentionUserName}`);
    lines.push(
        `🤖 *[ANTIGRAVITY AGENT]*`,
        `\`━━━━━━━━━━━━━━━━━━━━━━\``,
        `*Project:* ${escapeMarkdown(workspaceName)}`,
        `*Cascade:* #${cascadeIdShort} (step ${stepCount}/~${softLimit})`,
        `\`━━━━━━━━━━━━━━━━━━━━━━\``,
        ``,
        content,
    );
    return lines.join('\n');
}

function formatCascadeSwitch({ oldShort, newShort, stepCount }) {
    return [
        `🔄 *[CASCADE SWITCHED]*`,
        `\`━━━━━━━━━━━━━━━━━━━━━━\``,
        `*Old:* #${oldShort} → ${stepCount} steps`,
        `*New:* #${newShort} → fresh start`,
        `\`━━━━━━━━━━━━━━━━━━━━━━\``,
        ``,
        `Please re\\-inject your plan context into the new cascade\\.`,
    ].join('\n');
}

function formatBridgeStatus(msg) {
    return `ℹ️ *[BRIDGE]* ${msg}`;
}

// Escape MarkdownV2 special chars (Telegram requirement)
function escapeMarkdown(text) {
    if (!text) return '';
    return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

// ── Parse user reply (same contract as discord-relay.parsePiReply) ────────

function parsePiReply(text) {
    if (!text) return null;
    const actionMatch = text.match(/\[ACTION:\s*(accept|reject|none)\]/i);
    const action = actionMatch ? actionMatch[1].toLowerCase() : null;
    let reply = text
        .replace(/^\[REPLY\]\s*/i, '')
        .replace(/\[ACTION:\s*(?:accept|reject|none)\]\s*/gi, '')
        .trim();
    if (!reply) return null;
    return { reply, action: action === 'none' ? null : action };
}


// ── Bot lifecycle ─────────────────────────────────────────────────────────

async function init(token, targetChatId, _guildId, eventHook = null) {
    if (bot) await stop();
    chatId = String(targetChatId);
    onEventCallback = eventHook;

    bot = new TelegramBot(token, { polling: true });

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Telegram login timeout (30s)')), 30000);

        bot.getMe().then(me => {
            clearTimeout(timeout);
            botUsername = me.username;
            isReady = true;
            console.log(`[Telegram] Bot: @${botUsername}, chat: ${chatId}`);
            if (onEventCallback) onEventCallback('ready', { tag: `@${botUsername}`, channelId: chatId });
            resolve();
        }).catch(e => {
            clearTimeout(timeout);
            reject(e);
        });

        bot.on('polling_error', e => {
            console.error('[Telegram] Polling error:', e.message);
            if (onEventCallback) onEventCallback('error', { message: e.message });
        });
    });
}

function startListening(replyCallback, commandCallback = null) {
    if (!bot || !isReady) throw new Error('Telegram bot not ready');
    onReplyCallback = replyCallback;
    onCommandCallback = commandCallback;

    // ── Command messages ─────────────────────────────────────────────────
    const COMMANDS = ['help', 'listws', 'setws', 'createws'];

    for (const cmd of COMMANDS) {
        bot.onText(new RegExp(`^\\/${cmd}(?:@${botUsername})?(?:\\s+(.*))?$`, 'i'), async (msg, match) => {
            if (String(msg.chat.id) !== chatId) return;

            const from = msg.from.username || msg.from.first_name || 'unknown';
            console.log(`[Telegram] Command: /${cmd} from @${from}`);
            if (onEventCallback) onEventCallback('command', { command: cmd, from });

            if (!onCommandCallback) {
                await bot.sendMessage(chatId, '❌ Bridge not handling commands.');
                return;
            }

            const args = match && match[1] ? [match[1].trim()] : [];
            const namedOpts = {};
            if (args[0]) namedOpts.name = args[0];

            const replyFn = async (content) => {
                try {
                    await sendMessage(content);
                } catch (e) {
                    console.warn('[Telegram] replyFn failed:', e.message);
                }
            };

            await onCommandCallback(cmd, args, replyFn, namedOpts);
        });
    }

    // ── Regular messages → relay to cascade ─────────────────────────────
    bot.on('message', async (msg) => {
        if (String(msg.chat.id) !== chatId) return;
        if (!msg.text) return;
        // Skip command messages (already handled above)
        if (msg.text.startsWith('/')) return;

        const from = msg.from.username || msg.from.first_name || 'unknown';
        const text = msg.text;

        console.log(`[Telegram] Message from @${from}: "${text.substring(0, 60)}"`);
        if (onEventCallback) onEventCallback('update', { channel: chatId, from, text: text.substring(0, 60) });

        const cleanText = text.trim();
        if (!cleanText) return;

        console.log(`[Telegram] ✓ Relay from @${from}: "${cleanText.substring(0, 60)}"`);

        const parsed = parsePiReply(cleanText);
        if (parsed && onReplyCallback) {
            parsed.authorId = String(msg.from.id);
            parsed.authorName = msg.from.first_name || msg.from.username || 'User';
            if (onEventCallback) onEventCallback('reply', { action: parsed.action });
            await onReplyCallback(parsed);
        } else {
            if (onEventCallback) onEventCallback('ignored', { reason: 'empty', text: cleanText });
        }
    });

    console.log('[Telegram] Listening (commands + messages)...');
    if (onEventCallback) onEventCallback('listening', { channelId: chatId });
}

async function sendTyping() {
    if (!bot || !isReady) return;
    try {
        await bot.sendChatAction(chatId, 'typing');
    } catch { }
}

async function sendMessage(text) {
    if (!bot || !isReady) throw new Error('Telegram bot not ready');

    // Telegram limit: 4096 chars per message
    if (text.length <= 4000) {
        await bot.sendMessage(chatId, text);
    } else {
        const chunks = text.match(/.{1,3990}/gs) || [text];
        for (const chunk of chunks) await bot.sendMessage(chatId, chunk);
    }
}

// Send agent response — long content (>3000 chars) attached as .md file
async function sendResponse(params) {
    if (!bot || !isReady) throw new Error('Telegram bot not ready');

    const { content } = params;

    if (content.length > 3000) {
        // Long message → attach as file
        const header = formatNotifyUser({
            ...params,
            content: '📄 Message too long, see attached file.',
        });
        await bot.sendMessage(chatId, header);
        await bot.sendDocument(chatId, Buffer.from(content, 'utf-8'), {}, {
            filename: 'response.md',
            contentType: 'text/markdown',
        });
    } else {
        // Short message → inline
        const text = formatNotifyUser(params);
        await bot.sendMessage(chatId, text);
    }
}

async function stop() {
    onReplyCallback = null;
    onCommandCallback = null;
    isReady = false;
    if (bot) {
        try { await bot.stopPolling(); } catch { }
        bot.removeAllListeners();
        bot = null;
    }
    console.log('[Telegram] Bot stopped');
}

module.exports = {
    init, stop,
    sendMessage, sendTyping, sendResponse,
    startListening,
    formatNotifyUser, formatCascadeSwitch, formatBridgeStatus,
    parsePiReply,
};
