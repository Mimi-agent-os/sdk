import { randomUUID } from "node:crypto";

import { parseEnvelope, REPLY_OF } from "@mimi-os/protocol";
import type {
    A2aCallPayload,
    A2aInvokeOkPayload,
    A2aInvokePayload,
    AppendOkPayload,
    AppendPayload,
    AskApproveOkPayload,
    AskApprovePayload,
    ChatOkPayload,
    ChatPayload,
    DescribePayload,
    EventsAfterOkPayload,
    EventsAfterPayload,
    HealthOkPayload,
    HelloPayload,
    InvokePayload,
    ModelGrant,
    NotifyPayload,
    OkPayloadOf,
    ResultPayload,
    RequestType,
    RequestOf,
    WireReply,
    WireRequest,
    SessionCreateOkPayload,
    SessionCreatePayload,
    SessionDeleteOkPayload,
    SessionDeletePayload,
    SessionHead,
    SessionHeadOkPayload,
    SessionHeadPayload,
    SessionListOkPayload,
    SessionListPayload,
    SessionUpdateOkPayload,
    SessionUpdatePayload,
    Status,
    StreamEvent,
} from "@mimi-os/protocol";

export interface SocketLike {
    readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onopen: ((ev: unknown) => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onclose: ((ev: unknown) => void) | null;
    onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface Dispatch {
    invoke(p: InvokePayload, ctx: { signal: AbortSignal }): Promise<ResultPayload> | ResultPayload;
    a2aInvoke(
        p: A2aInvokePayload,
        ctx: { signal: AbortSignal },
    ): Promise<A2aInvokeOkPayload> | A2aInvokeOkPayload;
    sessionHead(p: SessionHeadPayload): SessionHeadOkPayload;
    eventsAfter(p: EventsAfterPayload): EventsAfterOkPayload;
    append(p: AppendPayload): AppendOkPayload;
    sessionCreate(p: SessionCreatePayload): SessionCreateOkPayload;
    sessionList(p: SessionListPayload): SessionListOkPayload;
    sessionUpdate(p: SessionUpdatePayload): SessionUpdateOkPayload;
    sessionDelete(p: SessionDeletePayload): SessionDeleteOkPayload;
    health(): HealthOkPayload;
    stream?(ev: StreamEvent, id: string): void;
}

export interface ClientOptions {
    url: string;
    agent: string;
    /** Rebuilt on every (re)connect: tools and prompt may have changed while we were away. */
    describe: () => DescribePayload;
    dispatch: Dispatch;
    socket: SocketFactory;
    log?: ((msg: string) => void) | undefined;
    onReady?: ((models: ModelGrant[]) => void) | undefined;
}

interface Pending {
    resolve: (payload: unknown) => void;
    reject: (e: Error) => void;
    replyType: string;
}

type OutgoingFrame = WireRequest<string, unknown> | WireReply<string, unknown>;

const HANDSHAKE_TIMEOUT_MS = 15_000;
const BACKOFF_BASE_MS = 500;
// capped low so an agent left running notices a (re)started gateway within a few seconds, not half a minute
const BACKOFF_CAP_MS = 5_000;
const SEEN_LIMIT = 512;

// `type` comes off the wire: an own-property lookup, so "constructor" and friends cannot resolve to an inherited value.
const replyTypeForIncoming = (type: string): string =>
    Object.hasOwn(REPLY_OF, type) ? (REPLY_OF as Record<string, string>)[type]! : "result";

/** Deny-by-default: a tool that refuses mid-execution answers `denied`, not `error`. */
export class DeniedError extends Error {
    constructor(message = "denied") {
        super(message);
        this.name = "DeniedError";
    }
}

/** Why the gateway turned this agent away; each kind is a different thing for the owner to fix. */
export type RefusalKind = "gateway-key" | "agent-key" | "protocol" | "denied";

/** The gateway turned this agent away before ready: a SocketLike's onerror argument, or a hello/describe it answered `denied`. */
export class RefusedError extends Error {
    readonly kind: RefusalKind;

    constructor(message: string, kind: RefusalKind) {
        super(message);
        this.name = "RefusedError";
        this.kind = kind;
    }
}

// a blocked pin is refused exactly like a revoked one, so the agent-key advice has to cover both
const REFUSAL_HINTS: Record<RefusalKind, string> = {
    "gateway-key":
        "The gateway's key changed since this agent pinned it. To re-pair, delete data/gateway.pub, put a fresh " +
        "MIMI_INVITE in .env and restart the agent: the pinned key is read only at boot.",
    "agent-key":
        "The gateway holds no approved pin for this agent's key: it was revoked, blocked, or never paired. A re-pair " +
        "keeps a block, so a blocked agent's pin must first be revoked in the app. Then re-pair: delete " +
        "data/gateway.pub, put a fresh MIMI_INVITE in .env and restart the agent.",
    protocol: "This agent and the gateway speak different protocol versions: update @mimi-os/sdk or the gateway.",
    denied:
        "The gateway denied this agent's handshake for the reason above. A name mismatch means the agent runs " +
        "under a name other than the one its key was paired as: run it under that name, or revoke the old pin " +
        "in the app and re-pair under the new one.",
};

export class GatewayClient {
    private readonly opts: ClientOptions;
    private sock: SocketLike | null = null;
    private gen = 0;
    private ready = false;
    private stopped = false;
    private attempts = 0;
    // refusals per kind since the last completed handshake
    private readonly refusals = new Map<RefusalKind, number>();
    private retry: ReturnType<typeof setTimeout> | undefined;
    private connectTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly pending = new Map<string, Pending>();
    private readonly active = new Map<string, AbortController>();
    /** Recent completed requests on this connection; active requests are tracked separately. */
    private readonly seen = new Set<string>();
    private grants: ModelGrant[] = [];

    constructor(opts: ClientOptions) {
        this.opts = opts;
    }

    get connected(): boolean {
        return this.ready;
    }

    models(): ModelGrant[] {
        return this.grants.map((model) => ({ ...model }));
    }

    start(): void {
        if (!this.stopped && (this.sock !== null || this.retry !== undefined)) return;
        this.stopped = false;
        this.open();
    }

    close(): void {
        this.stopped = true;
        if (this.retry) clearTimeout(this.retry);
        this.retry = undefined;
        this.teardown(new Error("client closed"));
    }

    chat(payload: ChatPayload, timeoutMs?: number): Promise<ChatOkPayload> {
        return this.request("chat", payload, timeoutMs);
    }

    askApprove(payload: AskApprovePayload, timeoutMs?: number, signal?: AbortSignal): Promise<AskApproveOkPayload> {
        return this.request("ask_approve", payload, timeoutMs, signal);
    }

    a2aCall(payload: A2aCallPayload, timeoutMs?: number): Promise<ResultPayload> {
        return this.request("a2a_call", payload, timeoutMs).then((ok) => ok.result);
    }

    notifyChanged(head: SessionHead): void {
        if (!this.ready) return;
        this.writeBestEffort({ id: randomUUID(), type: "session_changed", payload: head });
    }

    notify(payload: NotifyPayload): void {
        if (!this.ready) return;
        this.writeBestEffort({ id: randomUUID(), type: "notify", payload });
    }

    /** Re-send describe so a pack's changed prompt() reaches the gateway's next round; a no-op until connected. */
    redescribe(): void {
        if (!this.ready) return;
        const gen = this.gen;
        // the write that asked for this already happened: a describe that cannot be built must not fail it
        let payload: DescribePayload;
        try {
            payload = this.opts.describe();
        } catch (e) {
            this.log(`[client] re-describe failed — ${String(e)}\n`);
            return;
        }
        void this.send("describe", payload, HANDSHAKE_TIMEOUT_MS).then(
            (described) => {
                if (gen === this.gen) this.grants = described.models;
            },
            (e) => this.log(`[client] re-describe failed — ${String(e)}\n`),
        );
    }

    private open(): void {
        if (this.stopped) return;
        const gen = ++this.gen;
        this.ready = false;
        this.seen.clear();
        let sock: SocketLike;
        try {
            sock = this.opts.socket(this.opts.url);
        } catch (e) {
            this.log(`[client] connect failed — ${String(e)}\n`);
            this.scheduleRetry();
            return;
        }
        this.sock = sock;
        this.connectTimer = setTimeout(() => this.drop(gen, "connection timed out"), HANDSHAKE_TIMEOUT_MS);
        sock.onopen = (): void => {
            if (gen !== this.gen) return;
            clearTimeout(this.connectTimer);
            this.connectTimer = undefined;
            void this.handshake(gen);
        };
        sock.onmessage = (ev): void => {
            if (gen !== this.gen) return;
            this.receive(ev.data);
        };
        sock.onerror = (ev): void => {
            this.drop(gen, ev instanceof Error ? ev.message : "socket error", ev);
        };
        sock.onclose = (): void => {
            this.drop(gen, "socket closed");
        };
    }

    private async handshake(gen: number): Promise<void> {
        try {
            const hello: HelloPayload = { agent: this.opts.agent };
            await this.send("hello", hello, HANDSHAKE_TIMEOUT_MS);
            if (gen !== this.gen) return;
            const described = await this.send("describe", this.opts.describe(), HANDSHAKE_TIMEOUT_MS);
            if (gen !== this.gen) return;
            this.grants = described.models;
            this.ready = true;
            this.attempts = 0; // only a COMPLETED handshake resets the backoff
            this.refusals.clear();
        } catch (e) {
            this.drop(gen, `handshake failed — ${String(e)}`, e);
            return;
        }
        try {
            this.opts.onReady?.(this.models());
        } catch (error) {
            this.log(`[client] onReady failed — ${String(error)}\n`);
        }
    }

    private drop(gen: number, why: string, cause?: unknown): void {
        if (gen !== this.gen) return;
        this.log(`[client] ${why}\n`);
        if (cause instanceof RefusedError) {
            const count = (this.refusals.get(cause.kind) ?? 0) + 1;
            this.refusals.set(cause.kind, count);
            // once per kind: a refusal that never clears would otherwise repeat it every backoff, forever
            if (count === 3) {
                this.log(
                    `[client] the gateway has turned this agent away ${count} times since its last session. ` +
                        `${REFUSAL_HINTS[cause.kind]}\n`,
                );
            }
        }
        this.teardown(new Error(why));
        this.scheduleRetry();
    }

    private teardown(reason: Error): void {
        this.gen++;
        this.ready = false;
        this.grants = [];
        clearTimeout(this.connectTimer);
        this.connectTimer = undefined;
        const sock = this.sock;
        this.sock = null;
        if (sock) {
            sock.onopen = null;
            sock.onmessage = null;
            sock.onerror = null;
            sock.onclose = null;
            try {
                sock.close();
            } catch {
                /* already gone */
            }
        }
        for (const pending of this.pending.values()) pending.reject(reason);
        for (const controller of this.active.values()) controller.abort(reason);
        this.active.clear();
    }

    private scheduleRetry(): void {
        if (this.stopped || this.retry) return;
        const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.attempts);
        this.attempts = Math.min(this.attempts + 1, 16);
        const jittered = Math.round(delay * (0.75 + Math.random() * 0.5));
        this.retry = setTimeout(() => {
            this.retry = undefined;
            this.open();
        }, jittered);
    }

    private request<K extends RequestType>(
        type: K,
        payload: RequestOf<K>["payload"],
        timeoutMs?: number,
        signal?: AbortSignal,
    ): Promise<OkPayloadOf<K>> {
        if (!this.ready) return Promise.reject(new Error("not connected to the gateway"));
        return this.send(type, payload, timeoutMs, signal);
    }

    private send<K extends RequestType>(
        type: K,
        payload: RequestOf<K>["payload"],
        timeoutMs?: number,
        signal?: AbortSignal,
    ): Promise<OkPayloadOf<K>> {
        const id = randomUUID();
        return new Promise<OkPayloadOf<K>>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const abort = (): void => pending.reject(
                signal?.reason instanceof Error ? signal.reason : new Error(`${type}: cancelled`),
            );
            const cleanup = (): void => {
                this.pending.delete(id);
                clearTimeout(timer);
                signal?.removeEventListener("abort", abort);
            };
            const pending: Pending = {
                replyType: REPLY_OF[type],
                resolve: (payload) => { cleanup(); resolve(payload as OkPayloadOf<K>); },
                reject: (error) => { cleanup(); reject(error); },
            };
            if (signal?.aborted) {
                abort();
                return;
            }
            if (timeoutMs !== undefined && timeoutMs <= 0) {
                pending.reject(new Error(`${type}: no reply within ${timeoutMs}ms`));
                return;
            }
            this.pending.set(id, pending);
            signal?.addEventListener("abort", abort, { once: true });
            if (timeoutMs !== undefined) {
                timer = setTimeout(() => pending.reject(new Error(`${type}: no reply within ${timeoutMs}ms`)), timeoutMs);
            }
            try {
                this.write({ id, type, payload });
            } catch (error) {
                pending.reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    private write(frame: OutgoingFrame): void {
        if (!this.sock) throw new Error("socket is not open");
        this.sock.send(JSON.stringify(frame));
    }

    // Notices and replies cannot be replayed safely after a connection is lost.
    private writeBestEffort(frame: OutgoingFrame): void {
        try {
            this.write(frame);
        } catch (error) {
            this.log(`[client] ${frame.type} ${frame.id} lost — ${String(error)}\n`);
        }
    }

    private receive(data: unknown): void {
        let decoded: unknown;
        try {
            decoded = JSON.parse(typeof data === "string" ? data : String(data)) as unknown;
        } catch (error) {
            this.log(`[client] undecodable frame — ${String(error)}\n`);
            return;
        }
        const frame = parseEnvelope(decoded);
        if (!frame) return;

        if ("status" in frame) {
            const pending = this.pending.get(frame.id);
            if (!pending || frame.type !== pending.replyType) return;
            if (frame.status === "ok") {
                pending.resolve(frame.payload);
                return;
            }
            const message = `${frame.type}: ${frame.error.message}`;
            // before ready only hello and describe are in flight: a denial there turns the agent away, one after fails only its call
            if (frame.status === "denied" && !this.ready) pending.reject(new RefusedError(message, "denied"));
            else pending.reject(Object.assign(new Error(message), { status: frame.status }));
            return;
        }
        if (frame.type === "stream") {
            try {
                this.opts.dispatch.stream?.(frame.payload as StreamEvent, frame.id);
            } catch (error) {
                this.log(`[client] stream handler ${frame.id} failed — ${String(error)}\n`);
            }
            return;
        }
        if (frame.type === "session_changed" || frame.type === "notify") return;
        const request: WireRequest<string, unknown> = { id: frame.id, type: frame.type, payload: frame.payload };
        if (frame.deadline !== undefined) request.deadline = frame.deadline;
        void this.handle(request);
    }

    private async handle(frame: WireRequest<string, unknown>): Promise<void> {
        if (this.active.has(frame.id) || this.seen.has(frame.id)) return;
        const type = replyTypeForIncoming(frame.type);
        if (!this.ready) {
            this.writeBestEffort({ id: frame.id, type, status: "error", error: { message: "handshake not complete" } });
            return;
        }
        const generation = this.gen;
        const dispatch = this.opts.dispatch;
        const controller = new AbortController();
        this.active.set(frame.id, controller);
        const cancelled = Promise.withResolvers<never>();
        const abort = (): void => cancelled.reject(controller.signal.reason);
        controller.signal.addEventListener("abort", abort, { once: true });
        // The deadline is a duration from receipt, not a timestamp shared with the gateway.
        const expire = (): void => {
            controller.abort(new Error(`deadline of ${frame.deadline}ms passed`));
        };
        const expired = frame.deadline !== undefined && frame.deadline <= 0;
        const timer = frame.deadline === undefined || expired
            ? undefined
            : setTimeout(expire, frame.deadline);
        if (expired) expire();
        let answer: WireReply<string, unknown>;
        try {
            const work = controller.signal.aborted ? cancelled.promise : (async (): Promise<unknown> => {
                switch (frame.type) {
                    case "invoke":
                        return dispatch.invoke(frame.payload as InvokePayload, { signal: controller.signal });
                    case "a2a_invoke":
                        return dispatch.a2aInvoke(frame.payload as A2aInvokePayload, { signal: controller.signal });
                    case "session_head":
                        return dispatch.sessionHead(frame.payload as SessionHeadPayload);
                    case "events_after":
                        return dispatch.eventsAfter(frame.payload as EventsAfterPayload);
                    case "append":
                        return dispatch.append(frame.payload as AppendPayload);
                    case "session_create":
                        return dispatch.sessionCreate(frame.payload as SessionCreatePayload);
                    case "session_list":
                        return dispatch.sessionList(frame.payload as SessionListPayload);
                    case "session_update":
                        return dispatch.sessionUpdate(frame.payload as SessionUpdatePayload);
                    case "session_delete":
                        return dispatch.sessionDelete(frame.payload as SessionDeletePayload);
                    case "health":
                        return dispatch.health();
                    default:
                        throw new Error(`unknown frame type "${frame.type}"`);
                }
            })();
            answer = { id: frame.id, type, status: "ok", payload: await Promise.race([work, cancelled.promise]) };
        } catch (error) {
            const status: Status = controller.signal.aborted ? "timeout" : error instanceof DeniedError ? "denied" : "error";
            answer = { id: frame.id, type, status, error: { message: error instanceof Error ? error.message : String(error) } };
        } finally {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", abort);
            if (generation === this.gen) {
                this.active.delete(frame.id);
                this.seen.add(frame.id);
                if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value!);
            }
        }
        if (generation !== this.gen) return;
        try {
            this.write(answer);
        } catch (error) {
            // a reply the transport refuses (an oversized result) still has to settle the request
            const message = error instanceof Error ? error.message : String(error);
            this.log(`[client] ${type} ${frame.id} not sent — ${message}\n`);
            this.writeBestEffort({ id: frame.id, type, status: "error", error: { message: `reply not sent — ${message}` } });
        }
    }

    private log(msg: string): void {
        this.opts.log?.(msg);
    }
}
