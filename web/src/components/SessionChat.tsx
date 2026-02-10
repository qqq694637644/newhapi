import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata, DecryptedMessage, ModelMode, PermissionMode, Session } from '@/types/api'
import type { ChatBlock, NormalizedMessage } from '@/chat/types'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { reconcileChatBlocks } from '@/chat/reconcile'
import { HappyComposer } from '@/components/AssistantChat/HappyComposer'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { createAttachmentAdapter } from '@/lib/attachmentAdapter'
import { SessionHeader } from '@/components/SessionHeader'
import { usePlatform } from '@/hooks/usePlatform'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { appendOptimisticMessage } from '@/lib/message-window-store'
import { useVoiceOptional } from '@/lib/voice-context'
import { RealtimeVoiceSession, registerSessionStore, registerVoiceHooksStore, voiceHooks } from '@/realtime'

export function SessionChat(props: {
    api: ApiClient
    session: Session
    messages: DecryptedMessage[]
    messagesWarning: string | null
    hasMoreMessages: boolean
    isLoadingMessages: boolean
    isLoadingMoreMessages: boolean
    isSending: boolean
    pendingCount: number
    messagesVersion: number
    onBack: () => void
    onRefresh: () => void
    onLoadMore: () => Promise<unknown>
    onSend: (text: string, attachments?: AttachmentMetadata[]) => void
    onFlushPending: () => void
    onAtBottomChange: (atBottom: boolean) => void
    onRetryMessage?: (localId: string) => void
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
}) {
    const { haptic } = usePlatform()
    const navigate = useNavigate()
    const sessionInactive = !props.session.active
    const normalizedCacheRef = useRef<Map<string, { source: DecryptedMessage; normalized: NormalizedMessage | null }>>(new Map())
    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())
    const [forceScrollToken, setForceScrollToken] = useState(0)
    const agentFlavor = props.session.metadata?.flavor ?? null
    const { abortSession, switchSession, setPermissionMode, setModelMode } = useSessionActions(
        props.api,
        props.session.id,
        agentFlavor
    )

    const appendCommandMessage = useCallback((text: string) => {
        const localMessageId = typeof crypto?.randomUUID === 'function'
            ? crypto.randomUUID()
            : `local-command-${Date.now()}-${Math.random().toString(16).slice(2)}`

        appendOptimisticMessage(props.session.id, {
            id: localMessageId,
            seq: null,
            localId: null,
            createdAt: Date.now(),
            content: {
                role: 'agent',
                content: text
            }
        })
        setForceScrollToken((token) => token + 1)
    }, [props.session.id])

    const formatResetTime = (timestamp: number | null | undefined): string | null => {
        if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
            return null
        }
        const millis = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000
        const date = new Date(millis)
        if (Number.isNaN(date.getTime())) {
            return null
        }
        return date.toLocaleString()
    }

    const formatRateWindowLabel = (windowDurationMins: number | null | undefined, fallback: string): string => {
        if (typeof windowDurationMins !== 'number' || !Number.isFinite(windowDurationMins) || windowDurationMins <= 0) {
            return fallback
        }
        if (windowDurationMins === 300) {
            return '5h limit'
        }
        if (windowDurationMins === 10_080) {
            return 'Weekly limit'
        }
        return `${windowDurationMins}m limit`
    }

    const runCodexCommand = useCallback(async (text: string, attachments?: AttachmentMetadata[]): Promise<boolean> => {
        if (agentFlavor !== 'codex') {
            return false
        }

        const trimmed = text.trim()
        if (!trimmed.startsWith('/')) {
            return false
        }

        const firstSpace = trimmed.indexOf(' ')
        const commandToken = (firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace)).toLowerCase()
        const args = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim()

        if (commandToken === 'new') {
            appendCommandMessage('Command disabled: `/new` is disabled in HAPI. Start a new session from the New Session button.')
            haptic.notification('error')
            return true
        }

        if (commandToken === 'status') {
            if (attachments && attachments.length > 0) {
                appendCommandMessage('Command failed: slash commands do not support attachments.')
                haptic.notification('error')
                return true
            }

            let hapiBlock = 'HAPI status: unavailable'
            let nativeBlock = 'Codex native status: unavailable'
            let success = false

            try {
                const [hapiResponse, nativeResponse] = await Promise.all([
                    props.api.getCodexStatus(props.session.id),
                    props.api.getCodexNativeStatus(props.session.id)
                ])

                if (hapiResponse.success && hapiResponse.status) {
                    const status = hapiResponse.status
                    const collaborationMode = status.collaborationMode ?? 'default'
                    hapiBlock =
                        `HAPI status:\n` +
                        `- Model: ${status.model ?? 'default'}\n` +
                        `- Collaboration: ${collaborationMode}\n` +
                        `- Permission: ${status.permissionMode}\n` +
                        `- Pending requests: ${status.pendingRequests}\n` +
                        `- Active: ${status.active ? 'yes' : 'no'}`
                    success = true
                } else {
                    hapiBlock = `HAPI status failed: ${hapiResponse.error ?? 'unknown error'}`
                }

                if (nativeResponse.success && nativeResponse.nativeStatus) {
                    const native = nativeResponse.nativeStatus
                    if (!native.available) {
                        nativeBlock = `Codex native status unavailable: ${native.error ?? 'no data'}`
                    } else {
                        const account = native.account
                        const accountLabel = account
                            ? account.type === 'chatgpt'
                                ? `${account.email ?? 'unknown'}${account.planType ? ` (${account.planType})` : ''}`
                                : 'API key'
                            : 'unknown'

                        const primary = native.rateLimits?.primary
                        const secondary = native.rateLimits?.secondary

                        const nativeLines: string[] = [
                            'Codex native status:',
                            `- Session: ${native.sessionId ?? 'unknown'}`,
                            `- Directory: ${native.directory ?? 'unknown'}`,
                            `- Model: ${native.model ?? native.config?.model ?? 'unknown'}`,
                            `- Collaboration: ${native.collaborationMode ?? 'default'}`,
                            `- Approval: ${native.approvalPolicy ?? native.config?.approvalPolicy ?? 'unknown'}`,
                            `- Sandbox: ${native.sandbox ?? native.config?.sandboxMode ?? 'unknown'}`,
                            `- Account: ${accountLabel}`,
                        ]

                        if (primary && typeof primary.usedPercent === 'number') {
                            const left = Math.max(0, 100 - primary.usedPercent)
                            const resetAt = formatResetTime(primary.resetsAt)
                            const label = formatRateWindowLabel(primary.windowDurationMins, 'Primary limit')
                            nativeLines.push(`- ${label}: ${left}% left${resetAt ? ` (resets ${resetAt})` : ''}`)
                        }

                        if (secondary && typeof secondary.usedPercent === 'number') {
                            const left = Math.max(0, 100 - secondary.usedPercent)
                            const resetAt = formatResetTime(secondary.resetsAt)
                            const label = formatRateWindowLabel(secondary.windowDurationMins, 'Secondary limit')
                            nativeLines.push(`- ${label}: ${left}% left${resetAt ? ` (resets ${resetAt})` : ''}`)
                        }

                        nativeBlock = nativeLines.join('\n')
                        success = true
                    }
                } else {
                    nativeBlock = `Codex native status failed: ${nativeResponse.error ?? 'unknown error'}`
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Failed to fetch status'
                nativeBlock = `Codex native status failed: ${message}`
            }

            appendCommandMessage(`${hapiBlock}\n\n${nativeBlock}`)
            props.onRefresh()
            haptic.notification(success ? 'success' : 'error')
            return true
        }

        const recognized = commandToken === 'model'
            || commandToken === 'skills'
            || commandToken === 'plan'

        if (!recognized) {
            return false
        }

        if (attachments && attachments.length > 0) {
            appendCommandMessage('Command failed: slash commands do not support attachments.')
            haptic.notification('error')
            return true
        }

        try {
            if (commandToken === 'model') {
                if (!args) {
                    const response = await props.api.getCodexStatus(props.session.id)
                    if (!response.success || !response.status) {
                        throw new Error(response.error ?? 'Failed to fetch model status')
                    }
                    appendCommandMessage(`Model: ${response.status.model ?? 'default'}`)
                } else {
                    const response = await props.api.setCodexConfig(props.session.id, { model: args })
                    if (!response.success || !response.config) {
                        throw new Error(response.error ?? 'Failed to update model')
                    }
                    appendCommandMessage(`Model updated: ${response.config.model ?? 'default'}`)
                }
                props.onRefresh()
                haptic.notification('success')
                return true
            }

            if (commandToken === 'skills') {
                const response = await props.api.getSkills(props.session.id)
                if (!response.success) {
                    throw new Error(response.error ?? 'Failed to list skills')
                }
                const skills = response.skills ?? []
                if (skills.length === 0) {
                    appendCommandMessage('Skills: none')
                } else {
                    const lines = skills.map((skill) => `- ${skill.name}${skill.description ? `: ${skill.description}` : ''}`)
                    appendCommandMessage(`Skills (${skills.length}):\n${lines.join('\n')}`)
                }
                haptic.notification('success')
                return true
            }

            if (commandToken === 'plan') {
                const normalizedArgs = args.trim().toLowerCase()
                if (normalizedArgs === 'off') {
                    const response = await props.api.setCodexConfig(
                        props.session.id,
                        { collaborationMode: null }
                    )
                    if (!response.success || !response.config) {
                        throw new Error(response.error ?? 'Failed to update collaboration mode')
                    }
                    if (response.config.collaborationMode !== null) {
                        throw new Error(`Plan mode not disabled (actual: ${response.config.collaborationMode ?? 'default'})`)
                    }
                    appendCommandMessage('Plan mode: OFF')
                    props.onRefresh()
                    haptic.notification('success')
                    return true
                }

                const fallbackPlanModel = 'gpt-5.2-codex'
                let resolvedModel: string | undefined

                const statusResponse = await props.api.getCodexStatus(props.session.id)
                if (statusResponse.success && statusResponse.status?.model) {
                    resolvedModel = statusResponse.status.model
                }

                const targetModel = resolvedModel ?? fallbackPlanModel

                const response = await props.api.setCodexConfig(
                    props.session.id,
                    {
                        collaborationMode: 'plan',
                        model: targetModel
                    }
                )
                if (!response.success || !response.config) {
                    throw new Error(response.error ?? 'Failed to update collaboration mode')
                }

                if (response.config.collaborationMode !== 'plan') {
                    throw new Error(`Plan mode not applied (actual: ${response.config.collaborationMode ?? 'default'})`)
                }

                appendCommandMessage(
                    resolvedModel
                        ? 'Plan mode: ON'
                        : `Plan mode: ON (model fallback: ${fallbackPlanModel})`
                )

                if (args && normalizedArgs !== 'on') {
                    props.onSend(args)
                }

                props.onRefresh()
                haptic.notification('success')
                return true
            }

        } catch (error) {
            const message = error instanceof Error ? error.message : 'Command failed'
            appendCommandMessage(`Command failed: ${message}`)
            haptic.notification('error')
            return true
        }

        return false
    }, [agentFlavor, appendCommandMessage, haptic, props.api, props.onRefresh, props.onSend, props.session.id])

    // Voice assistant integration
    const voice = useVoiceOptional()

    // Register session store for voice client tools
    useEffect(() => {
        registerSessionStore({
            getSession: () => props.session as { agentState?: { requests?: Record<string, unknown> } } | null,
            sendMessage: (_sessionId: string, message: string) => props.onSend(message),
            approvePermission: async (_sessionId: string, requestId: string) => {
                await props.api.approvePermission(props.session.id, requestId)
                props.onRefresh()
            },
            denyPermission: async (_sessionId: string, requestId: string) => {
                await props.api.denyPermission(props.session.id, requestId)
                props.onRefresh()
            }
        })
    }, [props.session, props.api, props.onSend, props.onRefresh])

    useEffect(() => {
        registerVoiceHooksStore(
            (sessionId) => (sessionId === props.session.id ? props.session : null),
            (sessionId) => (sessionId === props.session.id ? props.messages : [])
        )
    }, [props.session, props.messages])

    // Track and report new messages to voice assistant
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const prevMessagesRef = useRef<DecryptedMessage[]>([])

    useEffect(() => {
        const prevIds = new Set(prevMessagesRef.current.map(m => m.id))
        const newMessages = props.messages.filter(m => !prevIds.has(m.id))

        if (newMessages.length > 0) {
            voiceHooks.onMessages(props.session.id, newMessages)
        }

        prevMessagesRef.current = props.messages
    }, [props.messages, props.session.id])

    // Report ready event when thinking stops
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const prevThinkingRef = useRef(props.session.thinking)

    useEffect(() => {
        // Detect transition: thinking → not thinking
        if (prevThinkingRef.current && !props.session.thinking) {
            voiceHooks.onReady(props.session.id)
        }

        prevThinkingRef.current = props.session.thinking
    }, [props.session.thinking, props.session.id])

    // Report permission requests to voice assistant
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const prevRequestIdsRef = useRef<Set<string>>(new Set())

    useEffect(() => {
        const requests = props.session.agentState?.requests ?? {}
        const currentIds = new Set(Object.keys(requests))

        for (const [requestId, request] of Object.entries(requests)) {
            if (!prevRequestIdsRef.current.has(requestId)) {
                voiceHooks.onPermissionRequested(
                    props.session.id,
                    requestId,
                    (request as { tool?: string }).tool ?? 'unknown',
                    (request as { arguments?: unknown }).arguments
                )
            }
        }

        prevRequestIdsRef.current = currentIds
    }, [props.session.agentState?.requests, props.session.id])

    const handleVoiceToggle = useCallback(async () => {
        if (!voice) return
        if (voice.status === 'connected' || voice.status === 'connecting') {
            await voice.stopVoice()
        } else {
            await voice.startVoice(props.session.id)
        }
    }, [voice, props.session.id])

    const handleVoiceMicToggle = useCallback(() => {
        if (!voice) return
        voice.toggleMic()
    }, [voice])

    // Track session id to clear caches when it changes
    const prevSessionIdRef = useRef<string | null>(null)

    useEffect(() => {
        normalizedCacheRef.current.clear()
        blocksByIdRef.current.clear()
    }, [props.session.id])

    const normalizedMessages: NormalizedMessage[] = useMemo(() => {
        // Clear caches immediately when session changes (before useEffect runs)
        if (prevSessionIdRef.current !== null && prevSessionIdRef.current !== props.session.id) {
            normalizedCacheRef.current.clear()
            blocksByIdRef.current.clear()
        }
        prevSessionIdRef.current = props.session.id

        const cache = normalizedCacheRef.current
        const normalized: NormalizedMessage[] = []
        const seen = new Set<string>()
        for (const message of props.messages) {
            seen.add(message.id)
            const cached = cache.get(message.id)
            if (cached && cached.source === message) {
                if (cached.normalized) normalized.push(cached.normalized)
                continue
            }
            const next = normalizeDecryptedMessage(message)
            cache.set(message.id, { source: message, normalized: next })
            if (next) normalized.push(next)
        }
        for (const id of cache.keys()) {
            if (!seen.has(id)) {
                cache.delete(id)
            }
        }
        return normalized
    }, [props.messages])

    const reduced = useMemo(
        () => reduceChatBlocks(normalizedMessages, props.session.agentState),
        [normalizedMessages, props.session.agentState]
    )
    const reconciled = useMemo(
        () => reconcileChatBlocks(reduced.blocks, blocksByIdRef.current),
        [reduced.blocks]
    )

    useEffect(() => {
        blocksByIdRef.current = reconciled.byId
    }, [reconciled.byId])

    // Permission mode change handler
    const handlePermissionModeChange = useCallback(async (mode: PermissionMode) => {
        try {
            await setPermissionMode(mode)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set permission mode:', e)
        }
    }, [setPermissionMode, props.onRefresh, haptic])

    // Model mode change handler
    const handleModelModeChange = useCallback(async (mode: ModelMode) => {
        try {
            await setModelMode(mode)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set model mode:', e)
        }
    }, [setModelMode, props.onRefresh, haptic])

    // Abort handler
    const handleAbort = useCallback(async () => {
        await abortSession()
        props.onRefresh()
    }, [abortSession, props.onRefresh])

    // Switch to remote handler
    const handleSwitchToRemote = useCallback(async () => {
        await switchSession()
        props.onRefresh()
    }, [switchSession, props.onRefresh])

    const handleViewFiles = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId/files',
            params: { sessionId: props.session.id }
        })
    }, [navigate, props.session.id])

    const handleViewTerminal = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId/terminal',
            params: { sessionId: props.session.id }
        })
    }, [navigate, props.session.id])

    const handleSend = useCallback((text: string, attachments?: AttachmentMetadata[]) => {
        void (async () => {
            const handled = await runCodexCommand(text, attachments)
            if (handled) {
                return
            }
            props.onSend(text, attachments)
            setForceScrollToken((token) => token + 1)
        })()
    }, [props.onSend, runCodexCommand])

    const attachmentAdapter = useMemo(() => {
        if (!props.session.active) {
            return undefined
        }
        return createAttachmentAdapter(props.api, props.session.id)
    }, [props.api, props.session.id, props.session.active])

    const runtime = useHappyRuntime({
        session: props.session,
        blocks: reconciled.blocks,
        isSending: props.isSending,
        onSendMessage: handleSend,
        onAbort: handleAbort,
        attachmentAdapter,
        allowSendWhenInactive: true
    })

    return (
        <div className="flex h-full flex-col">
            <SessionHeader
                session={props.session}
                onBack={props.onBack}
                onViewFiles={props.session.metadata?.path ? handleViewFiles : undefined}
                api={props.api}
                onSessionDeleted={props.onBack}
            />

            {sessionInactive ? (
                <div className="px-3 pt-3">
                    <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                        Session is inactive. Sending will resume it automatically.
                    </div>
                </div>
            ) : null}

            <AssistantRuntimeProvider runtime={runtime}>
                <div className="relative flex min-h-0 flex-1 flex-col">
                    <HappyThread
                        key={props.session.id}
                        api={props.api}
                        sessionId={props.session.id}
                        metadata={props.session.metadata}
                        disabled={sessionInactive}
                        onRefresh={props.onRefresh}
                        onRetryMessage={props.onRetryMessage}
                        onFlushPending={props.onFlushPending}
                        onAtBottomChange={props.onAtBottomChange}
                        isLoadingMessages={props.isLoadingMessages}
                        messagesWarning={props.messagesWarning}
                        hasMoreMessages={props.hasMoreMessages}
                        isLoadingMoreMessages={props.isLoadingMoreMessages}
                        onLoadMore={props.onLoadMore}
                        pendingCount={props.pendingCount}
                        rawMessagesCount={props.messages.length}
                        normalizedMessagesCount={normalizedMessages.length}
                        messagesVersion={props.messagesVersion}
                        forceScrollToken={forceScrollToken}
                    />

                    <HappyComposer
                        disabled={props.isSending}
                        permissionMode={props.session.permissionMode}
                        modelMode={props.session.modelMode}
                        agentFlavor={agentFlavor}
                        active={props.session.active}
                        allowSendWhenInactive
                        thinking={props.session.thinking}
                        agentState={props.session.agentState}
                        contextSize={reduced.latestUsage?.contextSize}
                        controlledByUser={props.session.agentState?.controlledByUser === true}
                        onPermissionModeChange={handlePermissionModeChange}
                        onModelModeChange={handleModelModeChange}
                        onSwitchToRemote={handleSwitchToRemote}
                        onTerminal={props.session.active ? handleViewTerminal : undefined}
                        autocompleteSuggestions={props.autocompleteSuggestions}
                        voiceStatus={voice?.status}
                        voiceMicMuted={voice?.micMuted}
                        onVoiceToggle={voice ? handleVoiceToggle : undefined}
                        onVoiceMicToggle={voice ? handleVoiceMicToggle : undefined}
                    />
                </div>
            </AssistantRuntimeProvider>

            {/* Voice session component - renders nothing but initializes ElevenLabs */}
            {voice && (
                <RealtimeVoiceSession
                    api={props.api}
                    micMuted={voice.micMuted}
                    onStatusChange={voice.setStatus}
                />
            )}
        </div>
    )
}
