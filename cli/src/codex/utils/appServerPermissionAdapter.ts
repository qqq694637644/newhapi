import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import type { CodexPermissionHandler } from './permissionHandler';
import type { CodexAppServerClient } from '../codexAppServerClient';

type PermissionDecision = 'approved' | 'approved_for_session' | 'denied' | 'abort';
type UserInputAnswers = Record<string, { answers: string[] }>;

type PermissionResult = {
    decision: PermissionDecision;
    reason?: string;
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function mapDecision(decision: PermissionDecision): { decision: string } {
    switch (decision) {
        case 'approved':
            return { decision: 'accept' };
        case 'approved_for_session':
            return { decision: 'acceptForSession' };
        case 'denied':
            return { decision: 'decline' };
        case 'abort':
            return { decision: 'cancel' };
    }
}

function normalizeUserInputAnswers(
    value: Record<string, string[]> | Record<string, { answers: string[] }> | undefined
): UserInputAnswers {
    if (!value || typeof value !== 'object') {
        return {};
    }

    const normalized: UserInputAnswers = {};
    for (const [key, entry] of Object.entries(value)) {
        if (Array.isArray(entry)) {
            normalized[key] = {
                answers: entry.filter((item: unknown): item is string => typeof item === 'string')
            };
            continue;
        }

        if (entry && typeof entry === 'object' && Array.isArray(entry.answers)) {
            normalized[key] = {
                answers: entry.answers.filter((item: unknown): item is string => typeof item === 'string')
            };
        }
    }

    return normalized;
}

export function registerAppServerPermissionHandlers(args: {
    client: CodexAppServerClient;
    permissionHandler: CodexPermissionHandler;
    onUserInputRequest?: (request: unknown) => Promise<UserInputAnswers>;
}): void {
    const { client, permissionHandler, onUserInputRequest } = args;

    client.registerRequestHandler('item/commandExecution/requestApproval', async (params) => {
        const record = asRecord(params) ?? {};
        const toolCallId = asString(record.itemId) ?? randomUUID();
        const reason = asString(record.reason);
        const command = record.command;
        const cwd = asString(record.cwd);

        const result = await permissionHandler.handleToolCall(
            toolCallId,
            'CodexBash',
            {
                message: reason,
                command,
                cwd
            }
        ) as PermissionResult;

        return mapDecision(result.decision);
    });

    client.registerRequestHandler('item/fileChange/requestApproval', async (params) => {
        const record = asRecord(params) ?? {};
        const toolCallId = asString(record.itemId) ?? randomUUID();
        const reason = asString(record.reason);
        const grantRoot = asString(record.grantRoot);

        const result = await permissionHandler.handleToolCall(
            toolCallId,
            'CodexPatch',
            {
                message: reason,
                grantRoot
            }
        ) as PermissionResult;

        return mapDecision(result.decision);
    });

    client.registerRequestHandler('item/tool/requestUserInput', async (params) => {
        if (!onUserInputRequest) {
            logger.debug('[CodexAppServer] No user-input handler registered; cancelling request');
            throw new Error('request_user_input cancelled: no user-input handler registered');
        }

        const answers = await onUserInputRequest(params);
        return {
            answers: normalizeUserInputAnswers(answers)
        };
    });
}
