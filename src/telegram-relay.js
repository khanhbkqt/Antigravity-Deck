// === Telegram Relay ===
// Low-level bot wrapper — mirrors discord-relay.js API surface.
//
// Three event streams:
//   command messages   → /help, /listws, /setws, /listconv, /joinconv
//   callback queries   → inline keyboard button presses
//   regular messages   → relay to Antigravity cascade

const TelegramBot = require('node-telegram-bot-api');

let bot = null;
let chatId = null;
let botUsername = null;
let onReplyCallback = null;
let onCommandCallback = null;
let onCallbackCallback = null;
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

        bot.getMe().then(async (me) => {
            clearTimeout(timeout);
            botUsername = me.username;
            isReady = true;

            // Register commands with Telegram so they appear in the / menu
            await bot.setMyCommands([
                { command: 'help',     description: '📖 Show available commands' },
                { command: 'listws',   description: '📂 List workspaces (inline buttons)' },
                { command: 'setws',    description: '🔀 Switch workspace by name' },
                { command: 'createws', description: '📁 Create new workspace' },
                { command: 'listconv', description: '💬 List conversations (inline buttons)' },
                { command: 'joinconv', description: '🔗 Join conversation by ID' },
            ]).catch(e => console.warn('[Telegram] setMyCommands failed:', e.message));

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

function startListening(replyCallback, commandCallback = null, callbackQueryCallback = null) {
    if (!bot || !isReady) throw new Error('Telegram bot not ready');
    onReplyCallback = replyCallback;
    onCommandCallback = commandCallback;
    onCallbackCallback = callbackQueryCallback;

    // ── Command messages ─────────────────────────────────────────────────
    const COMMANDS = ['help', 'listws', 'setws', 'createws', 'listconv', 'joinconv'];

    for (const cmd of COMMANDS) {
        bot.onText(new RegExp(`^\\/\\s*${cmd}(?:@${botUsername})?(?:\\s+(.*))?$`, 'i'), async (msg, match) => {
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

            const replyFn = async (content, opts = {}) => {
                try {
                    if (opts.reply_markup) {
                        await bot.sendMessage(chatId, content, { reply_markup: opts.reply_markup });
                    } else {
                        await sendMessage(content);
                    }
                } catch (e) {
                    console.warn('[Telegram] replyFn failed:', e.message);
                }
            };

            await onCommandCallback(cmd, args, replyFn, namedOpts);
        });
    }

    // ── Inline keyboard callback queries ─────────────────────────────────
    bot.on('callback_query', async (query) => {
        if (String(query.message.chat.id) !== chatId) return;

        const data = query.data || '';
        const from = query.from.username || query.from.first_name || 'unknown';
        console.log(`[Telegram] Callback: "${data}" from @${from}`);
        if (onEventCallback) onEventCallback('callback', { data, from });

        // Acknowledge the button press immediately (removes loading spinner)
        await bot.answerCallbackQuery(query.id).catch(() => {});

        if (onCallbackCallback) {
            const replyFn = async (content, opts = {}) => {
                try {
                    if (opts.edit && query.message) {
                        // Edit the original message instead of sending new one
                        await bot.editMessageText(content, {
                            chat_id: chatId,
                            message_id: query.message.message_id,
                            ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
                        });
                    } else if (opts.reply_markup) {
                        await bot.sendMessage(chatId, content, { reply_markup: opts.reply_markup });
                    } else {
                        await sendMessage(content);
                    }
                } catch (e) {
                    console.warn('[Telegram] callback replyFn failed:', e.message);
                }
            };
            await onCallbackCallback(data, replyFn, query);
        }
    });

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

    console.log('[Telegram] Listening (commands + callbacks + messages)...');
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

// Send message with inline keyboard buttons
async function sendInlineKeyboard(text, buttons, opts = {}) {
    if (!bot || !isReady) throw new Error('Telegram bot not ready');
    await bot.sendMessage(chatId, text, {
        reply_markup: { inline_keyboard: buttons },
        ...opts,
    });
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

// Edit an existing message (for streaming updates)
// Rate-limited: Telegram rejects edits that are too frequent
let _lastEditTime = 0;
const MIN_EDIT_INTERVAL = 1200; // ms between edits

async function editMessage(messageId, text) {
    if (!bot || !isReady) throw new Error('Telegram bot not ready');

    // Rate-limit protection
    const now = Date.now();
    if (now - _lastEditTime < MIN_EDIT_INTERVAL) {
        return; // skip this edit — too soon
    }
    _lastEditTime = now;

    // Telegram limit: 4096 chars
    const truncated = text.length > 4000 ? text.substring(0, 3997) + '...' : text;

    try {
        await bot.editMessageText(truncated, {
            chat_id: chatId,
            message_id: messageId,
        });
    } catch (e) {
        // "message is not modified" is expected when content hasn't changed
        if (!e.message?.includes('message is not modified')) {
            console.warn('[Telegram] editMessage failed:', e.message);
        }
    }
}

// Send a streaming placeholder and return its messageId
async function sendStreamingPlaceholder() {
    if (!bot || !isReady) throw new Error('Telegram bot not ready');
    const msg = await bot.sendMessage(chatId, '⏳ Generating response...');
    return msg.message_id;
}

// Finalize a streaming message — edit with final content or switch to file
async function finalizeStreamingMessage(messageId, params) {
    if (!bot || !isReady) throw new Error('Telegram bot not ready');
    const { content } = params;

    if (content.length > 3000) {
        // Too long for inline — delete placeholder and send as file
        try { await bot.deleteMessage(chatId, messageId); } catch { }
        await sendResponse(params);
    } else {
        // Edit placeholder with final formatted content
        const text = formatNotifyUser(params);
        const truncated = text.length > 4000 ? text.substring(0, 3997) + '...' : text;
        try {
            await bot.editMessageText(truncated, {
                chat_id: chatId,
                message_id: messageId,
            });
        } catch (e) {
            // Fallback: send as new message if edit fails
            console.warn('[Telegram] finalizeStreaming edit failed, sending new:', e.message);
            await sendResponse(params);
        }
    }
}

async function stop() {
    onReplyCallback = null;
    onCommandCallback = null;
    onCallbackCallback = null;
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
    sendMessage, sendTyping, sendResponse, sendInlineKeyboard,
    editMessage, sendStreamingPlaceholder, finalizeStreamingMessage,
    startListening,
    formatNotifyUser, formatCascadeSwitch, formatBridgeStatus,
    parsePiReply,
};
