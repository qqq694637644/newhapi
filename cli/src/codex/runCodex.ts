import { logger } from '@/ui/logger';
import { loop, type EnhancedMode, type PermissionMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { AgentState } from '@/api/types';
import type { CodexSession } from './session';
import { parseCodexCliOverrides } from './utils/codexCliOverrides';
import { bootstrapSession } from '@/agent/sessionFactory';
import { createModeChangeHandler, createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol';
import { PermissionModeSchema } from '@hapi/protocol/schemas';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { CodexAppServerClient } from './codexAppServerClient';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export { emitReadyIfIdle } from './utils/emitReadyIfIdle';

export async function runCodex(opts: {
    startedBy?: 'runner' | 'terminal';
    codexArgs?: string[];
    permissionMode?: PermissionMode;
    resumeSessionId?: string;
    model?: string;
}): Promise<void> {
    const workingDirectory = process.cwd();
    const startedBy = opts.startedBy ?? 'terminal';

    logger.debug(`[codex] Starting with options: startedBy=${startedBy}`);

    let state: AgentState = {
        controlledByUser: false
    };
    const { api, session } = await bootstrapSession({
        flavor: 'codex',
        startedBy,
        workingDirectory,
        agentState: state
    });

    const startingMode: 'local' | 'remote' = startedBy === 'runner' ? 'remote' : 'local';

    setControlledByUser(session, startingMode);

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        collaborationMode: mode.collaborationMode
    }));

    const codexCliOverrides = parseCodexCliOverrides(opts.codexArgs);
    const sessionWrapperRef: { current: CodexSession | null } = { current: null };

    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'default';
    let currentModel = opts.model;
    let currentCollaborationMode: EnhancedMode['collaborationMode'];

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'codex',
        stopKeepAlive: () => sessionWrapperRef.current?.stopKeepAlive()
    });

    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle.cleanupAndExit);

    const syncSessionMode = () => {
        const sessionInstance = sessionWrapperRef.current;
        if (!sessionInstance) {
            return;
        }
        sessionInstance.setPermissionMode(currentPermissionMode);
        logger.debug(`[Codex] Synced session permission mode for keepalive: ${currentPermissionMode}`);
    };

    session.onUserMessage((message) => {
        const messagePermissionMode = currentPermissionMode;
        logger.debug(`[Codex] User message received with permission mode: ${currentPermissionMode}`);

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode ?? 'default',
            model: currentModel,
            collaborationMode: currentCollaborationMode
        };
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        messageQueue.push(formattedText, enhancedMode);
    });

    const formatFailureReason = (message: string): string => {
        const maxLength = 200;
        if (message.length <= maxLength) {
            return message;
        }
        return `${message.slice(0, maxLength)}...`;
    };

    const resolvePermissionMode = (value: unknown): PermissionMode => {
        const parsed = PermissionModeSchema.safeParse(value);
        if (!parsed.success || !isPermissionModeAllowedForFlavor(parsed.data, 'codex')) {
            throw new Error('Invalid permission mode');
        }
        return parsed.data as PermissionMode;
    };

    const resolveCollaborationMode = (value: unknown): EnhancedMode['collaborationMode'] => {
        if (value === null) {
            return undefined;
        }
        if (typeof value !== 'string') {
            throw new Error('Invalid collaboration mode');
        }
        const trimmed = value.trim();
        if (!trimmed) {
            throw new Error('Invalid collaboration mode');
        }
        return trimmed as EnhancedMode['collaborationMode'];
    };

    const resolveModel = (value: unknown): string | undefined => {
        if (value === null) {
            return undefined;
        }
        if (typeof value !== 'string') {
            throw new Error('Invalid model');
        }
        const trimmed = value.trim();
        if (!trimmed) {
            throw new Error('Invalid model');
        }
        return trimmed;
    };

    const resolveEffectiveApprovalPolicy = (): 'untrusted' | 'on-failure' | 'on-request' | 'never' => {
        if (currentPermissionMode === 'default' && codexCliOverrides?.approvalPolicy) {
            return codexCliOverrides.approvalPolicy;
        }

        switch (currentPermissionMode) {
            case 'default':
                return 'untrusted';
            case 'read-only':
                return 'never';
            case 'safe-yolo':
                return 'on-failure';
            case 'yolo':
                return 'on-failure';
        }
    };

    const resolveEffectiveSandbox = (): 'read-only' | 'workspace-write' | 'danger-full-access' => {
        if (currentPermissionMode === 'default' && codexCliOverrides?.sandbox) {
            return codexCliOverrides.sandbox;
        }

        switch (currentPermissionMode) {
            case 'default':
                return 'workspace-write';
            case 'read-only':
                return 'read-only';
            case 'safe-yolo':
                return 'workspace-write';
            case 'yolo':
                return 'danger-full-access';
        }
    };

    const readNativeStatus = async (): Promise<{
        available: boolean;
        sessionId: string | null;
        model: string | null;
        collaborationMode: string | null;
        permissionMode: PermissionMode;
        approvalPolicy: 'untrusted' | 'on-failure' | 'on-request' | 'never';
        sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
        directory: string;
        fetchedAt: number;
        account: {
            type: string | null;
            email: string | null;
            planType: string | null;
            requiresOpenaiAuth: boolean | null;
        } | null;
        rateLimits: {
            planType: string | null;
            primary: { usedPercent: number | null; resetsAt: number | null; windowDurationMins: number | null } | null;
            secondary: { usedPercent: number | null; resetsAt: number | null; windowDurationMins: number | null } | null;
        } | null;
        config: {
            model: string | null;
            approvalPolicy: string | null;
            sandboxMode: string | null;
            modelReasoningEffort: string | null;
            modelReasoningSummary: string | null;
        } | null;
        error?: string;
    }> => {
        const base = {
            available: false,
            sessionId: sessionWrapperRef.current?.sessionId ?? null,
            model: currentModel ?? null,
            collaborationMode: currentCollaborationMode ?? null,
            permissionMode: currentPermissionMode,
            approvalPolicy: resolveEffectiveApprovalPolicy(),
            sandbox: resolveEffectiveSandbox(),
            directory: workingDirectory,
            fetchedAt: Date.now(),
            account: null,
            rateLimits: null,
            config: null
        };

        const parseWindow = (value: unknown): { usedPercent: number | null; resetsAt: number | null; windowDurationMins: number | null } | null => {
            const record = asRecord(value);
            if (!record) return null;
            return {
                usedPercent: asNumber(record.usedPercent),
                resetsAt: asNumber(record.resetsAt),
                windowDurationMins: asNumber(record.windowDurationMins)
            };
        };

        const appServer = new CodexAppServerClient();
        try {
            await appServer.connect();
            await appServer.initialize({
                clientInfo: {
                    name: 'hapi-codex-status',
                    version: '1.0.0'
                }
            });

            const [accountResult, rateLimitsResult, configResult] = await Promise.allSettled([
                appServer.readAccount({ refreshToken: false }),
                appServer.readAccountRateLimits(),
                appServer.readConfig({ cwd: workingDirectory })
            ]);

            let account = null;
            if (accountResult.status === 'fulfilled') {
                const accountRecord = asRecord(accountResult.value.account);
                const requiresOpenaiAuthRaw = (accountResult.value as Record<string, unknown>).requiresOpenaiAuth;
                account = {
                    type: asString(accountRecord?.type),
                    email: asString(accountRecord?.email),
                    planType: asString(accountRecord?.planType),
                    requiresOpenaiAuth: typeof requiresOpenaiAuthRaw === 'boolean' ? requiresOpenaiAuthRaw : null
                };
            }

            let rateLimits = null;
            if (rateLimitsResult.status === 'fulfilled') {
                const rateLimitsRecord = asRecord(rateLimitsResult.value.rateLimits);
                rateLimits = {
                    planType: asString(rateLimitsRecord?.planType),
                    primary: parseWindow(rateLimitsRecord?.primary),
                    secondary: parseWindow(rateLimitsRecord?.secondary)
                };
            }

            let config = null;
            if (configResult.status === 'fulfilled') {
                const configRecord = asRecord(configResult.value.config);
                config = {
                    model: asString(configRecord?.model),
                    approvalPolicy: asString(configRecord?.approval_policy),
                    sandboxMode: asString(configRecord?.sandbox_mode),
                    modelReasoningEffort: asString(configRecord?.model_reasoning_effort),
                    modelReasoningSummary: asString(configRecord?.model_reasoning_summary)
                };
            }

            return {
                ...base,
                available: true,
                account,
                rateLimits,
                config
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                ...base,
                error: message
            };
        } finally {
            await appServer.disconnect().catch(() => undefined);
        }
    };

    session.rpcHandlerManager.registerHandler('set-session-config', async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload');
        }
        const config = payload as { permissionMode?: unknown; collaborationMode?: unknown; model?: unknown };

        if (config.permissionMode !== undefined) {
            currentPermissionMode = resolvePermissionMode(config.permissionMode);
        }

        if (config.collaborationMode !== undefined) {
            currentCollaborationMode = resolveCollaborationMode(config.collaborationMode);
        }

        if (config.model !== undefined) {
            currentModel = resolveModel(config.model);
        }

        syncSessionMode();
        return {
            applied: {
                permissionMode: currentPermissionMode,
                collaborationMode: currentCollaborationMode,
                model: currentModel ?? null
            }
        };
    });

    session.rpcHandlerManager.registerHandler('get-session-config', async () => {
        return {
            permissionMode: currentPermissionMode,
            collaborationMode: currentCollaborationMode ?? null,
            model: currentModel ?? null
        };
    });

    session.rpcHandlerManager.registerHandler('get-native-status', async () => {
        return await readNativeStatus();
    });

    try {
        await loop({
            path: workingDirectory,
            startingMode,
            messageQueue,
            api,
            session,
            codexArgs: opts.codexArgs,
            codexCliOverrides,
            startedBy,
            permissionMode: currentPermissionMode,
            resumeSessionId: opts.resumeSessionId,
            onModeChange: createModeChangeHandler(session),
            onSessionReady: (instance) => {
                sessionWrapperRef.current = instance;
                syncSessionMode();
            }
        });
    } catch (error) {
        lifecycle.markCrash(error);
        logger.debug('[codex] Loop error:', error);
    } finally {
        const localFailure = sessionWrapperRef.current?.localLaunchFailure;
        if (localFailure?.exitReason === 'exit') {
            lifecycle.setExitCode(1);
            lifecycle.setArchiveReason(`Local launch failed: ${formatFailureReason(localFailure.message)}`);
        }
        await lifecycle.cleanupAndExit();
    }
}
