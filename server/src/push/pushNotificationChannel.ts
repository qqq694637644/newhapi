import type { Session } from '../sync/syncEngine'
import type { NotificationChannel } from '../notifications/notificationTypes'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import type { PushPayload, PushService } from './pushService'

export class PushNotificationChannel implements NotificationChannel {
    constructor(
        private readonly pushService: PushService,
        private readonly appUrl: string
    ) {}

    async sendPermissionRequest(session: Session): Promise<void> {
        if (!session.active) {
            return
        }

        const name = getSessionName(session)
        const request = session.agentState?.requests
            ? Object.values(session.agentState.requests)[0]
            : null
        const toolName = request?.tool ? ` (${request.tool})` : ''

        const payload: PushPayload = {
            title: 'Permission Request',
            body: `${name}${toolName}`,
            tag: `permission-${session.id}`,
            data: {
                type: 'permission-request',
                sessionId: session.id,
                url: this.buildSessionUrl(session.id)
            }
        }

        await this.pushService.sendToNamespace(session.namespace, payload)
    }

    async sendReady(session: Session): Promise<void> {
        if (!session.active) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)

        const payload: PushPayload = {
            title: 'Ready for input',
            body: `${agentName} is waiting in ${name}`,
            tag: `ready-${session.id}`,
            data: {
                type: 'ready',
                sessionId: session.id,
                url: this.buildSessionUrl(session.id)
            }
        }

        await this.pushService.sendToNamespace(session.namespace, payload)
    }

    private buildSessionUrl(sessionId: string): string {
        try {
            const baseUrl = new URL(this.appUrl)
            const basePath = baseUrl.pathname === '/'
                ? ''
                : baseUrl.pathname.replace(/\/$/, '')
            baseUrl.pathname = `${basePath}/sessions/${sessionId}`
            baseUrl.search = ''
            baseUrl.hash = ''
            return baseUrl.toString()
        } catch {
            const trimmed = this.appUrl.replace(/\/$/, '')
            return `${trimmed}/sessions/${sessionId}`
        }
    }
}
