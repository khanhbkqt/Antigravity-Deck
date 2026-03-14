// === Telegram Bridge ===
// High-level orchestration — mirrors agent-bridge.js but uses telegram-relay.
//
// Telegram Commands:
//   /help           — show available commands
//   /listws         — inline keyboard to switch workspace
//   /setws <name>   — set active workspace
//   /listconv       — inline keyboard to join a conversation
//   /joinconv <id>  — join a specific cascade by ID
//
// Inline Buttons:
//   ws:<name>       — switch to workspace
//   conv:<id>       — join conversation
//   newconv         — create new conversation
//   refresh_ws      — refresh workspace list
//   refresh_conv    — refresh conversation list
//
// Regular messages:
//   Relayed to Antigravity cascade. Antigravity NOTIFY_USER → forwarded to Telegram.

const fs = require('fs');
const path = require('path');
const telegram = require('./telegram-relay');
const { startCascade, sendMessage: cascadeSend } = require('./cascade');
const { getStepCountAndStatus } = require('./step-cache');
const { waitAndExtractResponse } = require('./cascade-relay');
const { getSettings, saveSettings, getTelegramSettings, saveTelegramSettings } = require('./config');
const { callApi: _callApi, callApiOnInstance } = require('./api');

// ── State ────────────────────────────────────────────────────────────────────

const STATES = { IDLE: 'IDLE', ACTIVE: 'ACTIVE', TRANSITIONING: 'TRANSITIONING' };

let state = STATES.IDLE;
let activeCascadeId = null;
let stepCount = 0;
let softLimit = 500;
let workspaceName = 'AntigravityAuto';
let log = [];
let lastRelayTs = 0;
let lastRelayedStepIndex = -1;
let isBridgeBusy = false;
let bridgeLsInst = null;

// ── Persist bridge state ─────────────────────────────────────────────────────

function saveBridgeState() {
    saveTelegramSettings({
        currentWorkspace: workspaceName,
        lastCascadeId: activeCascadeId,
        lastStepCount: stepCount,
        lastRelayedStepIndex: lastRelayedStepIndex,
    });
}

function restoreBridgeState() {
    const ts = getTelegramSettings();
    if (ts.lastCascadeId) {
        activeCascadeId = ts.lastCascadeId;
        stepCount = ts.lastStepCount || 0;
        lastRelayedStepIndex = ts.lastRelayedStepIndex ?? -1;
        addLog('system', `Restored previous cascade: ${shortId(activeCascadeId)} (${stepCount} steps, lastRelayed=${lastRelayedStepIndex})`);
    }
}

function bridgeCallApi(method, body = {}) {
    return _callApi(method, body, bridgeLsInst);
}

// ── Public API ───────────────────────────────────────────────────────────────

async function startBridge(config = {}) {
    if (state !== STATES.IDLE) {
        throw new Error(`Telegram bridge already ${state}`);
    }

    const ts = getTelegramSettings();

    const token = config.telegramBotToken || ts.telegramBotToken;
    const targetChatId = config.telegramChatId || ts.telegramChatId;
    softLimit = config.stepSoftLimit || ts.stepSoftLimit || 500;

    workspaceName = ts.currentWorkspace
        || config.workspaceName
        || 'AntigravityAuto';

    // Bind to LS instance matching the workspace
    const { lsInstances } = require('./config');
    const matchInst = lsInstances.find(
        i => i.workspaceName.toLowerCase() === workspaceName.toLowerCase()
    );
    if (matchInst) {
        bridgeLsInst = { port: matchInst.port, csrfToken: matchInst.csrfToken, useTls: matchInst.useTls };
        addLog('system', `Bound to LS instance: ${workspaceName} (port ${matchInst.port})`);
    } else {
        addLog('system', `No LS instance found for workspace "${workspaceName}" — using global fallback`);
    }

    if (!token) throw new Error('Missing telegramBotToken');
    if (!targetChatId) throw new Error('Missing telegramChatId');

    if (config.cascadeId && config.cascadeId.trim()) {
        activeCascadeId = config.cascadeId.trim();
        const info = await getStepCountAndStatus(activeCascadeId).catch(() => ({ stepCount: 0 }));
        stepCount = info.stepCount || 0;
        addLog('system', `Locking to cascade: ${shortId(activeCascadeId)} (${stepCount} steps)`);
    } else {
        restoreBridgeState();
        if (!activeCascadeId) {
            addLog('system', 'Auto-follow mode: will latch to first active cascade');
        }
    }

    const eventHook = (event, data) => {
        if (event === 'error') addLog('error', `Telegram: ${data.message}`);
        if (event === 'update') addLog('system', `Telegram msg from @${data.from}: "${data.text}"`);
        if (event === 'reply') addLog('system', `Telegram reply processed: action=${data.action}`);
        if (event === 'command') addLog('system', `Telegram command: /${data.command} from @${data.from}`);
        if (event === 'callback') addLog('system', `Telegram button: ${data.data} from @${data.from}`);
        if (event === 'listening') addLog('system', `Telegram polling active on chat ${data.channelId}`);
        if (event === 'ready') addLog('system', `Telegram bot ready: ${data.tag}`);
        if (event === 'ignored') addLog('system', `Telegram ignored: "${data.text}"`);
    };

    await telegram.init(token, targetChatId, '', eventHook);
    telegram.startListening(handleUserReply, handleCommand, handleCallbackQuery);

    state = STATES.ACTIVE;
    addLog('system', `Telegram Bridge ACTIVE — workspace: ${workspaceName}, limit: ${softLimit}`);

    await telegram.sendMessage(telegram.formatBridgeStatus(
        `Bridge ACTIVE\n` +
        `**Workspace:** \`${workspaceName}\`\n` +
        `**Cascade limit:** ${softLimit} steps\n` +
        `Type /help for commands`
    )).catch(e => addLog('error', `Telegram init msg error: ${e.message}`));

    return getStatus();
}

function stopBridge() {
    if (state === STATES.IDLE) return;
    telegram.stop().catch(() => { });
    state = STATES.IDLE;
    activeCascadeId = null;
    stepCount = 0;
    lastRelayedStepIndex = -1;
    isBridgeBusy = false;
    addLog('system', 'Telegram Bridge stopped');
}

function getStatus() {
    return {
        state,
        cascadeId: activeCascadeId,
        cascadeIdShort: shortId(activeCascadeId),
        stepCount,
        softLimit,
        workspaceName,
        log: log.slice(-50),
    };
}

// ── Inline Keyboard Builders ─────────────────────────────────────────────────

function buildWorkspaceButtons(lsInstances, wsRoot) {
    const rows = [];

    // Running workspaces (green circle)
    for (const inst of lsInstances) {
        const isActive = inst.workspaceName === workspaceName;
        const label = `${isActive ? '🟢' : '⚪'} ${inst.workspaceName}${isActive ? ' ← active' : ''}`;
        rows.push([{ text: label, callback_data: `ws:${inst.workspaceName}` }]);
    }

    // Folder workspaces (not running)
    try {
        if (wsRoot && fs.existsSync(wsRoot)) {
            const running = new Set(lsInstances.map(i => i.workspaceName));
            const fsWs = fs.readdirSync(wsRoot, { withFileTypes: true })
                .filter(d => d.isDirectory() && !running.has(d.name))
                .map(d => d.name).sort().slice(0, 10); // cap at 10
            for (const w of fsWs) {
                rows.push([{ text: `📁 ${w}`, callback_data: `ws:${w}` }]);
            }
        }
    } catch { /* ignore */ }

    // Refresh button
    rows.push([{ text: '🔄 Refresh', callback_data: 'refresh_ws' }]);
    return rows;
}

async function buildConversationButtons() {
    const { lsInstances } = require('./config');
    const rows = [];

    // Query ALL instances and merge — also track which instance owns each cascade
    const merged = {};
    const cascadeInst = {}; // cascadeId → instance
    const instList = bridgeLsInst ? [bridgeLsInst] : [];
    for (const inst of lsInstances) {
        const ii = { port: inst.port, csrfToken: inst.csrfToken, useTls: inst.useTls };
        if (!instList.some(x => x.port === ii.port)) instList.push(ii);
    }

    for (const ii of instList) {
        try {
            const data = await callApiOnInstance(ii, 'GetAllCascadeTrajectories');
            if (data?.trajectorySummaries) {
                for (const [id, info] of Object.entries(data.trajectorySummaries)) {
                    merged[id] = info;
                    cascadeInst[id] = ii;
                }
            }
        } catch (e) {
            addLog('error', `Failed to query instance port ${ii.port}: ${e.message}`);
        }
    }

    const entries = Object.entries(merged)
        .sort((a, b) => {
            const tA = a[1].lastUpdatedTime || '0';
            const tB = b[1].lastUpdatedTime || '0';
            return tB.localeCompare(tA);
        })
        .slice(0, 15); // cap at 15

    // Fetch first user message for each conversation (in parallel, with timeout)
    const previews = {};
    await Promise.all(entries.map(async ([id]) => {
        try {
            const inst = cascadeInst[id];
            if (!inst) return;
            const data = await callApiOnInstance(inst, 'GetCascadeTrajectorySteps', {
                cascadeId: id, startIndex: 0, endIndex: 3,
            });
            const steps = data?.steps || [];
            // Find first USER_TURN step with content
            for (const s of steps) {
                const type = s.type || '';
                if (type.includes('USER') || type.includes('user') || type === 'CORTEX_STEP_TYPE_USER_INPUT') {
                    const content = s.content?.rawContent || s.content?.content || '';
                    if (content.trim()) {
                        previews[id] = content.trim();
                        return;
                    }
                }
            }
            // Fallback: any step with text content
            for (const s of steps) {
                const content = s.content?.rawContent || s.content?.content || '';
                if (content.trim()) {
                    previews[id] = content.trim();
                    return;
                }
            }
        } catch { /* ignore — show ID fallback */ }
    }));

    // Build button rows
    for (const [id, summary] of entries) {
        const status = summary.runStatus || '';
        const steps = summary.stepCount || 0;
        const isActive = id === activeCascadeId;

        let icon = '⚪';
        if (isActive) icon = '🟢';
        else if (status.includes('RUNNING')) icon = '🔵';
        else if (status.includes('DONE') || status.includes('COMPLETED')) icon = '⚫';

        // Build preview text: first user message → truncated to fit
        const raw = previews[id] || '';
        // Clean up: collapse whitespace, remove markdown
        const clean = raw.replace(/[#*_`~>\[\]()]/g, '').replace(/\s+/g, ' ').trim();

        // Telegram button limit is 64 chars. Icon + steps take ~15, so preview gets ~45
        const maxPreview = 42;
        const preview = clean
            ? (clean.length > maxPreview ? clean.substring(0, maxPreview - 1) + '…' : clean)
            : `#${id.substring(0, 8)}`;

        const joined = isActive ? ' ✓' : '';
        const label = `${icon} ${preview} (${steps})${joined}`;
        rows.push([{ text: label, callback_data: `conv:${id}` }]);
    }

    if (entries.length === 0) {
        rows.push([{ text: '📭 No conversations found', callback_data: 'noop' }]);
    }

    // New conversation + refresh buttons
    rows.push([
        { text: '➕ New Conversation', callback_data: 'newconv' },
        { text: '🔄 Refresh', callback_data: 'refresh_conv' },
    ]);
    return rows;
}

// ── Command Handler ──────────────────────────────────────────────────────────

async function handleCommand(cmd, args, replyFn) {
    const settings = getSettings();
    const wsRoot = settings.defaultWorkspaceRoot || '';
    const { lsInstances } = require('./config');

    switch (cmd) {
        case 'help': {
            await replyFn([
                '📖 *Telegram Agent Bridge*',
                '',
                '`/listws`     — Workspaces (inline buttons)',
                '`/setws <n>`  — Switch workspace by name',
                '`/listconv`   — Conversations (inline buttons)',
                '`/joinconv <id>` — Join conversation by ID',
                '`/createws <n>`  — Create new workspace',
                '`/help`       — This message',
                '',
                `*Workspace:* \`${workspaceName}\``,
                `*Cascade:* #${shortId(activeCascadeId)} (${stepCount}/${softLimit})`,
                `*State:* ${state}`,
            ].join('\n'));
            break;
        }

        case 'listws': {
            const buttons = buildWorkspaceButtons(lsInstances, wsRoot);
            const header = `📂 *Workspaces*\n\nCurrent: \`${workspaceName}\`\nTap to switch:`;
            await replyFn(header, {
                reply_markup: { inline_keyboard: buttons },
            });
            break;
        }

        case 'setws': {
            const newWs = args[0] || '';
            if (!newWs.trim()) {
                await replyFn(`❌ Usage: /setws <workspace_name>\nCurrent: \`${workspaceName}\``);
                break;
            }
            await switchWorkspace(newWs, replyFn);
            break;
        }

        case 'listconv': {
            const buttons = await buildConversationButtons();
            const header = `💬 *Conversations* in \`${workspaceName}\`\n\nCurrent: #${shortId(activeCascadeId)} (${stepCount} steps)\nTap to join:`;
            await replyFn(header, {
                reply_markup: { inline_keyboard: buttons },
            });
            break;
        }

        case 'joinconv': {
            const convId = args[0] || '';
            if (!convId.trim()) {
                await replyFn(`❌ Usage: /joinconv <cascade_id>\nCurrent: #${shortId(activeCascadeId)}`);
                break;
            }
            await joinConversation(convId.trim(), replyFn);
            break;
        }

        case 'createws': {
            const newWsName = args[0] || '';
            if (!newWsName.trim()) {
                await replyFn(`❌ Usage: /createws <workspace_name>`);
                break;
            }
            await createWorkspace(newWsName, replyFn);
            break;
        }

        default:
            await replyFn(`❓ Unknown command \`/${cmd}\`. Type /help for available commands.`);
    }
}

// ── Callback Query Handler (inline keyboard presses) ─────────────────────────

async function handleCallbackQuery(data, replyFn, query) {
    const { lsInstances } = require('./config');
    const settings = getSettings();
    const wsRoot = settings.defaultWorkspaceRoot || '';

    if (data.startsWith('ws:')) {
        const targetWs = data.substring(3);
        await switchWorkspace(targetWs, replyFn);
    } else if (data.startsWith('conv:')) {
        const targetConvId = data.substring(5);
        await joinConversation(targetConvId, replyFn);
    } else if (data === 'newconv') {
        await createNewConversation(replyFn);
    } else if (data === 'refresh_ws') {
        const buttons = buildWorkspaceButtons(lsInstances, wsRoot);
        const header = `📂 *Workspaces*\n\nCurrent: \`${workspaceName}\`\nTap to switch:`;
        await replyFn(header, { edit: true, reply_markup: { inline_keyboard: buttons } });
    } else if (data === 'refresh_conv') {
        const buttons = await buildConversationButtons();
        const header = `💬 *Conversations* in \`${workspaceName}\`\n\nCurrent: #${shortId(activeCascadeId)} (${stepCount} steps)\nTap to join:`;
        await replyFn(header, { edit: true, reply_markup: { inline_keyboard: buttons } });
    } else if (data === 'noop') {
        // Do nothing — placeholder button
    } else {
        await replyFn(`❓ Unknown action: ${data}`);
    }
}

// ── Workspace Switching ──────────────────────────────────────────────────────

async function switchWorkspace(newWs, replyFn) {
    const { lsInstances } = require('./config');

    const matchIdx = lsInstances.findIndex(
        i => i.workspaceName.toLowerCase() === newWs.toLowerCase()
    );

    if (matchIdx >= 0) {
        const { cleanupAll } = require('./cleanup');
        cleanupAll();
        bridgeLsInst = { port: lsInstances[matchIdx].port, csrfToken: lsInstances[matchIdx].csrfToken, useTls: lsInstances[matchIdx].useTls };
        workspaceName = lsInstances[matchIdx].workspaceName;
        addLog('system', `Switched LS → ${workspaceName} (port: ${lsInstances[matchIdx].port})`);
        saveTelegramSettings({ currentWorkspace: workspaceName });

        if (state === STATES.ACTIVE || state === STATES.TRANSITIONING) {
            await replyFn(`✅ Switched to \`${workspaceName}\` (port ${lsInstances[matchIdx].port})\n🔄 Starting new cascade...`);
            await performCascadeTransition(`Workspace: ${workspaceName}`);
        } else {
            await replyFn(`✅ Switched to \`${workspaceName}\` — ready`);
        }
        return;
    }

    // Not running — open in Antigravity IDE
    await replyFn(`⏳ Opening \`${newWs}\` in Antigravity... (waiting up to 30s)`);
    addLog('system', `Opening workspace: ${newWs}`);

    const { PORT } = require('./config');
    const authKey = process.env.AUTH_KEY || '';
    const headers = { 'Content-Type': 'application/json' };
    if (authKey) headers['X-Auth-Key'] = authKey;

    let createResult;
    try {
        const res = await fetch(`http://localhost:${PORT}/api/workspaces/create`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: newWs }),
            signal: AbortSignal.timeout(35000),
        });
        createResult = await res.json();
    } catch (e) {
        await replyFn(`❌ Failed to open workspace: ${e.message}`);
        return;
    }

    if (createResult.error) {
        await replyFn(`❌ ${createResult.error}`);
        return;
    }

    const refreshedInstances = require('./config').lsInstances;
    const newIdx = refreshedInstances.findIndex(
        i => i.workspaceName.toLowerCase() === newWs.toLowerCase()
    );
    if (newIdx >= 0) {
        bridgeLsInst = { port: refreshedInstances[newIdx].port, csrfToken: refreshedInstances[newIdx].csrfToken, useTls: refreshedInstances[newIdx].useTls };
        workspaceName = refreshedInstances[newIdx].workspaceName;
    } else if (createResult.workspace?.workspaceName) {
        workspaceName = createResult.workspace.workspaceName;
    } else {
        workspaceName = newWs;
    }

    saveTelegramSettings({ currentWorkspace: workspaceName });
    addLog('system', `Workspace opened: ${workspaceName}`);

    if (state === STATES.ACTIVE || state === STATES.TRANSITIONING) {
        await replyFn(`✅ \`${workspaceName}\` opened — starting new cascade...`);
        await performCascadeTransition(`Workspace: ${workspaceName}`);
    } else {
        await replyFn(`✅ \`${workspaceName}\` is ready`);
    }
}

// ── Create Workspace ────────────────────────────────────────────────────────

async function createWorkspace(newWsName, replyFn) {
    await replyFn(`⏳ Creating \`${newWsName}\` and opening... (waiting up to 30s)`);
    addLog('system', `Creating workspace: ${newWsName}`);

    const { PORT: CREATE_PORT } = require('./config');
    const createAuthKey = process.env.AUTH_KEY || '';
    const createHeaders = { 'Content-Type': 'application/json' };
    if (createAuthKey) createHeaders['X-Auth-Key'] = createAuthKey;

    let result;
    try {
        const res = await fetch(`http://localhost:${CREATE_PORT}/api/workspaces/create`, {
            method: 'POST',
            headers: createHeaders,
            body: JSON.stringify({ name: newWsName }),
            signal: AbortSignal.timeout(35000),
        });
        result = await res.json();
    } catch (e) {
        await replyFn(`❌ Failed: ${e.message}`);
        return;
    }

    if (result.error) {
        await replyFn(`❌ ${result.error}`);
        return;
    }

    if (result.alreadyOpen) {
        await replyFn(`ℹ️ Workspace \`${newWsName}\` already open — use /setws ${newWsName} to switch`);
        return;
    }

    const lsInst = require('./config').lsInstances;
    const newIdx = lsInst.findIndex(i => i.workspaceName.toLowerCase() === newWsName.toLowerCase());
    if (newIdx >= 0) {
        bridgeLsInst = { port: lsInst[newIdx].port, csrfToken: lsInst[newIdx].csrfToken, useTls: lsInst[newIdx].useTls };
        workspaceName = lsInst[newIdx].workspaceName;
    } else if (result.workspace?.workspaceName) {
        workspaceName = result.workspace.workspaceName;
    } else {
        workspaceName = newWsName;
    }

    saveTelegramSettings({ currentWorkspace: workspaceName });
    addLog('system', `Workspace created + opened: ${workspaceName}`);

    if (state === STATES.ACTIVE || state === STATES.TRANSITIONING) {
        await replyFn(`✅ \`${workspaceName}\` created — starting new cascade...`);
        await performCascadeTransition(`New workspace: ${workspaceName}`);
    } else {
        await replyFn(`✅ \`${workspaceName}\` created and ready`);
    }
}

// ── Join Conversation ────────────────────────────────────────────────────────

async function joinConversation(cascadeId, replyFn) {
    addLog('system', `Joining cascade: ${shortId(cascadeId)}`);

    try {
        const info = await getStepCountAndStatus(cascadeId, (m, b) => bridgeCallApi(m, b));
        const oldShort = shortId(activeCascadeId);
        const oldCount = stepCount;

        activeCascadeId = cascadeId;
        stepCount = info.stepCount || 0;
        lastRelayedStepIndex = stepCount > 0 ? stepCount - 1 : -1; // Start from latest
        isBridgeBusy = false;
        lastRelayTs = 0;
        saveBridgeState();

        const status = info.status || 'unknown';
        let statusLabel = '🟢 active';
        if (status.includes('DONE') || status.includes('COMPLETED')) statusLabel = '⚫ completed';
        else if (status.includes('WAITING')) statusLabel = '🟡 waiting';

        await replyFn(
            `✅ Joined cascade #${shortId(cascadeId)}\n` +
            `• Status: ${statusLabel}\n` +
            `• Steps: ${stepCount}\n` +
            `• Previous: #${oldShort} (${oldCount} steps)\n\n` +
            `Messages you send will now go to this conversation.`
        );
        addLog('system', `✓ Joined cascade ${shortId(cascadeId)} (${stepCount} steps, status: ${status})`);
    } catch (e) {
        // If we can't get status, still join
        const oldShort = shortId(activeCascadeId);
        activeCascadeId = cascadeId;
        stepCount = 0;
        lastRelayedStepIndex = -1;
        isBridgeBusy = false;
        saveBridgeState();

        await replyFn(
            `⚠️ Joined cascade #${shortId(cascadeId)} (status unknown)\n` +
            `Previous: #${oldShort}\n` +
            `Error: ${e.message}`
        );
        addLog('system', `Joined cascade ${shortId(cascadeId)} with error: ${e.message}`);
    }
}

// ── Create New Conversation ──────────────────────────────────────────────────

async function createNewConversation(replyFn) {
    try {
        const oldShort = shortId(activeCascadeId);
        const oldCount = stepCount;

        const newId = await startCascade(bridgeLsInst);
        activeCascadeId = newId;
        stepCount = 0;
        lastRelayedStepIndex = -1;
        isBridgeBusy = false;
        lastRelayTs = 0;
        saveBridgeState();

        await replyFn(
            `✅ New cascade #${shortId(newId)}\n` +
            `• Workspace: \`${workspaceName}\`\n` +
            `• Previous: #${oldShort} (${oldCount} steps)\n\n` +
            `Send a message to start the conversation.`
        );
        addLog('system', `Created new cascade: ${shortId(newId)}`);
    } catch (e) {
        await replyFn(`❌ Failed to create cascade: ${e.message}`);
        addLog('error', `Create cascade failed: ${e.message}`);
    }
}

// ── Handle user reply from Telegram ──────────────────────────────────────────

async function handleUserReply({ reply, action, authorId, authorName }) {
    if (state !== STATES.ACTIVE && state !== STATES.TRANSITIONING) return;

    const messageToSend = authorName ? `${authorName}: ${reply}` : reply;

    if (!activeCascadeId) {
        try {
            activeCascadeId = await startCascade(bridgeLsInst);
            stepCount = 0;
            lastRelayTs = 0;
            lastRelayedStepIndex = -1;
            isBridgeBusy = false;
            addLog('system', `Created cascade: ${shortId(activeCascadeId)} for workspace: ${workspaceName}`);
            saveBridgeState();
            await telegram.sendMessage(telegram.formatBridgeStatus(
                `New cascade #${shortId(activeCascadeId)} — workspace: \`${workspaceName}\``
            )).catch(() => { });
        } catch (e) {
            addLog('error', `Cannot create cascade: ${e.message}`);
            return;
        }
    } else {
        if (isBridgeBusy) {
            addLog('system', `Bridge busy — waiting for response relay. Message blocked.`);
            await telegram.sendMessage(telegram.formatBridgeStatus(
                `⚠️ Agent đang xử lý, hãy chờ response rồi gửi lại message nhé`
            )).catch(() => { });
            return;
        }

        try {
            const info = await getStepCountAndStatus(activeCascadeId, (m, b) => bridgeCallApi(m, b));
            const status = info.status || '';
            const isTerminal = status === 'CASCADE_RUN_STATUS_DONE' ||
                status === 'CASCADE_RUN_STATUS_COMPLETED' ||
                status === '';
            if (isTerminal) {
                addLog('system', `Cascade ${shortId(activeCascadeId)} is ${status || 'UNKNOWN'} — creating new cascade`);
                const oldId = activeCascadeId;
                activeCascadeId = await startCascade(bridgeLsInst);
                stepCount = 0;
                lastRelayTs = 0;
                lastRelayedStepIndex = -1;
                isBridgeBusy = false;
                addLog('system', `New cascade: ${shortId(activeCascadeId)} (old: ${shortId(oldId)})`);
                saveBridgeState();
                await telegram.sendMessage(telegram.formatBridgeStatus(
                    `Previous cascade finished → new cascade #${shortId(activeCascadeId)}`
                )).catch(() => { });
            } else {
                stepCount = info.stepCount || stepCount;
                addLog('system', `Cascade ${shortId(activeCascadeId)} is ${status} — reusing (${stepCount} steps)`);
                if (stepCount >= softLimit) {
                    addLog('system', `Step limit reached (${stepCount}/${softLimit}) — transitioning before send`);
                    await performCascadeTransition('Step limit reached');
                }
            }
        } catch (e) {
            addLog('system', `Status check failed: ${e.message} — sending to existing cascade`);
        }
    }

    addLog('from_user', messageToSend.substring(0, 200));

    const cascadeIdAtSend = activeCascadeId;
    isBridgeBusy = true;

    try {
        await cascadeSend(activeCascadeId, messageToSend, { inst: bridgeLsInst });
        addLog('system', `✓ Sent to cascade ${shortId(activeCascadeId)} — waiting for response`);
    } catch (e) {
        isBridgeBusy = false;
        addLog('error', `cascadeSend failed: ${e.message}`);
        return;
    }

    if (action === 'accept') {
        await triggerAccept().catch(e => addLog('error', `Accept failed: ${e.message}`));
    } else if (action === 'reject') {
        await triggerReject().catch(e => addLog('error', `Reject failed: ${e.message}`));
    }

    if (state === STATES.TRANSITIONING) {
        state = STATES.ACTIVE;
        addLog('system', `Transitioned OK → ${shortId(activeCascadeId)}`);
    }

    telegram.sendTyping();
    const typingInterval = setInterval(() => telegram.sendTyping(), 4000); // TG typing expires after 5s

    const result = await waitAndExtractResponse(cascadeIdAtSend, {
        inst: bridgeLsInst,
        fromStepIndex: lastRelayedStepIndex,
        log: addLog,
        shouldAbort: () => activeCascadeId !== cascadeIdAtSend || !isBridgeBusy,
    });

    clearInterval(typingInterval);

    if (result.text) {
        try {
            await telegram.sendResponse({
                workspaceName,
                cascadeIdShort: shortId(activeCascadeId),
                stepCount: result.stepCount,
                softLimit,
                content: result.text,
                mentionUserName: authorName,
            });
        } catch (e) {
            isBridgeBusy = false;
            addLog('error', `Telegram send failed (response NOT consumed): ${e.message}`);
            return;
        }

        lastRelayedStepIndex = result.stepIndex;
        stepCount = result.stepCount;
        isBridgeBusy = false;
        lastRelayTs = Date.now();
        saveBridgeState();

        if (stepCount >= softLimit) {
            await performCascadeTransition('Auto: step limit reached');
        } else if (stepCount >= softLimit - 10) {
            await telegram.sendMessage(telegram.formatBridgeStatus(
                `⚠️ Cascade #${shortId(activeCascadeId)} at ${stepCount}/${softLimit} steps — will auto-transition soon`
            )).catch(() => { });
        }
    } else {
        isBridgeBusy = false;
        addLog('system', `Response extraction failed or timeout for ${shortId(cascadeIdAtSend)}`);
    }
}

// ── Cascade Transition ────────────────────────────────────────────────────────

async function performCascadeTransition(reason = null) {
    const oldId = activeCascadeId;
    const oldCount = stepCount;

    state = STATES.TRANSITIONING;
    addLog('system', `Transitioning cascade after ${oldCount} steps...${reason ? ` (${reason})` : ''}`);

    let newId;
    try {
        newId = await startCascade(bridgeLsInst);
    } catch (e) {
        addLog('error', `Failed to create new cascade: ${e.message}`);
        state = STATES.ACTIVE;
        return;
    }

    activeCascadeId = newId;
    stepCount = 0;
    lastRelayedStepIndex = -1;
    isBridgeBusy = false;
    lastRelayTs = 0;

    await telegram.sendMessage(telegram.formatCascadeSwitch({
        oldShort: shortId(oldId),
        newShort: shortId(newId),
        stepCount: oldCount,
    })).catch(e => addLog('error', `Transition notice error: ${e.message}`));

    if (reason) {
        await telegram.sendMessage(telegram.formatBridgeStatus(
            `New cascade #${shortId(newId)} for workspace \`${workspaceName}\` — please re-inject context`
        )).catch(() => { });
    }

    state = STATES.ACTIVE;
    addLog('system', `Cascade transitioned → ${shortId(newId)}`);
    saveBridgeState();
}

// ── Accept / Reject ───────────────────────────────────────────────────────────

async function triggerAccept() {
    await bridgeCallApi('AcceptDiff', { cascadeId: activeCascadeId });
    addLog('system', '✓ Auto-accepted code changes');
}

async function triggerReject() {
    await bridgeCallApi('RejectDiff', { cascadeId: activeCascadeId });
    addLog('system', '✓ Auto-rejected code changes');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortId(id) {
    return id ? id.substring(0, 8) : '--------';
}

function addLog(type, message) {
    log.push({ type, message, ts: Date.now() });
    if (log.length > 200) log = log.slice(-200);
    const line = `[TGBridge/${type}] ${String(message).substring(0, 120)}`;
    console.log(line);
    try {
        const logPath = path.join(__dirname, '..', 'telegram-bridge.log');
        fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    } catch { /* ignore write errors */ }
    try {
        const { broadcastAll } = require('./ws');
        broadcastAll({ type: 'telegram_bridge_status', ...getStatus() });
    } catch { /* ws not ready yet */ }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
    startBridge, stopBridge, getStatus,
    STATES,
    get state() { return state; },
    get activeCascadeId() { return activeCascadeId; },
    get stepCount() { return stepCount; },
};
