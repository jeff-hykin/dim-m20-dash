// Hand-written types for the vendored zenoh.js (the parts dimos-react uses).
export { checkTopic } from "./topic.js"
import type { Lease, LeaseOptions, ZenohGateway } from "./vendor/zenoh-gateway/zenoh_gateway.js"

export type { Lease, LeaseOptions }

export type ConnectionState = "connecting" | "connected" | "degraded" | "lost"

/** A zenoh-gateway sample: `{ key, bytes, timestamp, … }` (`decoded` when the encoding decodes itself). */
export interface ZenohMessage {
    key: string
    bytes: Uint8Array
    timestamp?: number
    kind?: string
    seq?: number
    decoded?: unknown
}

/** The discovery answer from `GET /gateways/desktop/management/gateways/zenoh`. */
export interface ZenohInfo {
    namespace: string
    desktop?: string
    dimos?: string
    apps?: string
    zenohPrefix?: string
    zenohGatewayUrl?: string
    [field: string]: unknown
}

/** The zenoh-gateway client (ZenohGateway), once connected. */
/** the gateway client (zenoh-gateway's ZenohGateway, its types emitted from the vendored commit's source) */
export type ZenohGatewayClient = ZenohGateway

export type ZenohSubscription = (() => void) & {
    unsubscribe(): void
    update(changes: Record<string, unknown>): Promise<void>
}

export interface ZenohUnderOptions {
    parse?: "json" | "text" | "bytes"
    delivery?: "latest" | "reliable"
    [option: string]: unknown
}

export interface GetZenohOptions {
    app?: string
    href?: string
    base?: string
    connect?: (url: string, options: object) => Promise<ZenohGatewayClient>
    connectOptions?: object
    zenohGatewayUrl?: string
    fetch?: typeof fetch
}

export declare class AppZenoh {
    info: ZenohInfo | null
    client: ZenohGatewayClient | null
    state: ConnectionState
    base: string | null
    app: string | null
    ready: Promise<AppZenoh>
    constructor(options?: GetZenohOptions)
    get namespace(): string | null
    get prefix(): string | null
    subscribe(
        key: string | ((info: ZenohInfo) => string),
        options: object | undefined,
        callback: (message: ZenohMessage) => void,
    ): ZenohSubscription
    subscribeFrontend(
        topic: string,
        callback: (payload: any, message: ZenohMessage) => void,
        options?: ZenohUnderOptions,
    ): ZenohSubscription
    subscribeDesktop(type: string, callback: (event: any, message: ZenohMessage) => void, options?: ZenohUnderOptions): ZenohSubscription
    subscribeDimos(type: string, callback: (event: any, message: ZenohMessage) => void, options?: ZenohUnderOptions): ZenohSubscription
    subscribeJob(jobId: string | number, callback: (event: any, message: ZenohMessage) => void, options?: ZenohUnderOptions): ZenohSubscription
    /**
     * zenoh-gateway >= 0.5.16: exclusive publish/subscribe keys among the gateway's pages, once connected (take it before
     * subscribing to its keys; needs connectOptions' heartbeat). `allowTakeover`: a newer page ends it ("takenOver").
     */
    lease(options: LeaseOptions): Promise<Lease>
    onState(listener: (state: ConnectionState) => void): () => boolean
    onReconnect(listener: () => void): () => boolean
    close(): void
}

export declare function appBase(href: string): { base: string; app: string | null }
export declare function updatedOptions(options: Record<string, any>, changes?: Record<string, any> | null): Record<string, any>
export declare function getZenoh(options?: GetZenohOptions): AppZenoh
