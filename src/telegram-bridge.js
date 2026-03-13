// === Telegram Bridge ===
// High-level orchestration — mirrors agent-bridge.js but uses telegram-relay.
//
// Telegram Commands (no @mention needed):
//   /help           — show available commands
//   /listws         — list workspaces under defaultWorkspaceRoot
//   /setws <name>   — set active workspace; creates new cascade if bridge active
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
const { callApi: _callApi } = require('./api');

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
        if (event === 'listening') addLog('system', `Telegram polling active on chat ${data.channelId}`);
        if (event === 'ready') addLog('system', `Telegram bot ready: ${data.tag}`);
        if (event === 'ignored') addLog('system', `Telegram ignored: "${data.text}"`);
    };

    await telegram.init(token, targetChatId, '', eventHook);
    telegram.startListening(handleUserReply, handleCommand);

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

// ── Command Handler ──────────────────────────────────────────────────────────

async function handleCommand(cmd, args, replyFn) {
    const settings = getSettings();
    const wsRoot = settings.defaultWorkspaceRoot || '';
    const { lsInstances } = require('./config');

    switch (cmd) {
        case 'help': {
            await replyFn([
                '📖 **Telegram Agent Bridge Commands**',
                '```',
                '/help              — Show this help',
                '/listws            — List running LS instances + folders',
                '/setws <name>      — Switch to workspace (opens if needed)',
                '/createws <name>   — Create new workspace folder + open in Antigravity',
                '```',
                `**Active workspace:** \`${workspaceName}\``,
                `**Cascade:** #${shortId(activeCascadeId)} (${stepCount}/${softLimit} steps)`,
                `**State:** ${state}`,
            ].join('\n'));
            break;
        }

        case 'listws': {
            const lines = [];
            if (lsInstances.length > 0) {
                lines.push('**🟢 Running (Antigravity open):**');
                lsInstances.forEach(inst => {
                    const activeTag = inst.active ? ' ← LS active' : '';
                    const bridgeTag = inst.workspaceName === workspaceName ? ' 🤖' : '';
                    const bold = inst.active ? '**' : '';
                    lines.push(`${bold}• ${inst.workspaceName}${activeTag}${bridgeTag}${bold}`);
                });
            } else {
                lines.push('*No running Antigravity instances detected*');
            }
            try {
                if (wsRoot && fs.existsSync(wsRoot)) {
                    const running = new Set(lsInstances.map(i => i.workspaceName));
                    const fsWs = fs.readdirSync(wsRoot, { withFileTypes: true })
                        .filter(d => d.isDirectory() && !running.has(d.name))
                        .map(d => d.name).sort();
                    if (fsWs.length > 0) {
                        lines.push('\n**📁 Other folders (not running):**');
                        fsWs.forEach(w => lines.push(`• ${w}`));
                    }
                }
            } catch { /* ignore */ }
            lines.push(`\n*Use /setws <name> to switch. 🤖 = bridge workspace*`);
            await replyFn(lines.join('\n'));
            break;
        }

        case 'setws': {
            const newWs = args[0] || '';
            if (!newWs.trim()) {
                await replyFn(`❌ Usage: /setws <workspace_name>\nCurrent: \`${workspaceName}\``);
                break;
            }

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
                break;
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
                break;
            }

            if (createResult.error) {
                await replyFn(`❌ ${createResult.error}`);
                break;
            }

            const newIdx = lsInstances.findIndex(
                i => i.workspaceName.toLowerCase() === newWs.toLowerCase()
            );
            if (newIdx >= 0) {
                bridgeLsInst = { port: lsInstances[newIdx].port, csrfToken: lsInstances[newIdx].csrfToken, useTls: lsInstances[newIdx].useTls };
                workspaceName = lsInstances[newIdx].workspaceName;
            } else if (createResult.workspace?.workspaceName) {
                const fallbackIdx = lsInstances.findIndex(
                    i => i.workspaceName.toLowerCase() === createResult.workspace.workspaceName.toLowerCase()
                );
                if (fallbackIdx >= 0) {
                    bridgeLsInst = { port: lsInstances[fallbackIdx].port, csrfToken: lsInstances[fallbackIdx].csrfToken, useTls: lsInstances[fallbackIdx].useTls };
                }
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
            break;
        }

        case 'createws': {
            const newWsName = args[0] || '';
            if (!newWsName.trim()) {
                await replyFn(`❌ Usage: /createws <workspace_name>`);
                break;
            }

            await replyFn(`⏳ Creating \`${newWsName}\` and opening in Antigravity... (waiting up to 30s)`);
            addLog('system', `Creating workspace: ${newWsName}`);

            const { PORT: CREATE_PORT } = require('./config');
            const { lsInstances: lsInst2 } = require('./config');
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
                break;
            }

            if (result.error) {
                await replyFn(`❌ ${result.error}`);
                break;
            }

            if (result.alreadyOpen) {
                await replyFn(`ℹ️ Workspace \`${newWsName}\` already open — use /setws ${newWsName} to switch`);
                break;
            }

            const newIdx2 = lsInst2.findIndex(i => i.workspaceName.toLowerCase() === newWsName.toLowerCase());
            if (newIdx2 >= 0) {
                bridgeLsInst = { port: lsInst2[newIdx2].port, csrfToken: lsInst2[newIdx2].csrfToken, useTls: lsInst2[newIdx2].useTls };
                workspaceName = lsInst2[newIdx2].workspaceName;
            } else if (result.workspace?.workspaceName) {
                const fallbackIdx2 = lsInst2.findIndex(
                    i => i.workspaceName.toLowerCase() === result.workspace.workspaceName.toLowerCase()
                );
                if (fallbackIdx2 >= 0) {
                    bridgeLsInst = { port: lsInst2[fallbackIdx2].port, csrfToken: lsInst2[fallbackIdx2].csrfToken, useTls: lsInst2[fallbackIdx2].useTls };
                }
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
            break;
        }

        default:
            await replyFn(`❓ Unknown command \`/${cmd}\`. Type /help for available commands.`);
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
