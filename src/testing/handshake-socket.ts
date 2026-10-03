/** A gateway stand-in for runAgent({ socket }): answers hello and describe, keeps every describe, and can answer chat. */
import type { ChatOkPayload, ChatPayload, DescribePayload, ModelGrant } from "@mimi-os/protocol";

import { DeniedError, type SocketLike } from "../client.ts";

export interface SentFrame {
    id: string;
    type: string;
    status?: string;
    payload?: unknown;
    error?: { message: string };
}

export interface HandshakeSocketOptions {
    /** The grants describe_ok carries. Default none. */
    models?: ModelGrant[] | undefined;
    /** Answers each chat the agent asks; a DeniedError answers `denied`, any other throw `error`. Omitted = chats are never answered. */
    chat?: ((payload: ChatPayload) => ChatOkPayload) | undefined;
}

export class HandshakeSocket implements SocketLike {
    readyState = 0;
    readonly sent: SentFrame[] = [];
    readonly describes: DescribePayload[] = [];
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    readonly #opts: HandshakeSocketOptions;

    constructor(opts: HandshakeSocketOptions = {}) {
        this.#opts = opts;
    }

    /** The latest describe the agent sent. */
    get describe(): DescribePayload | undefined {
        return this.describes.at(-1);
    }

    send(data: string): void {
        const frame = JSON.parse(data) as SentFrame;
        this.sent.push(frame);
        const reply = (fields: Record<string, unknown>): void => this.deliver({ id: frame.id, type: `${frame.type}_ok`, ...fields });
        if (frame.type === "hello") reply({ status: "ok", payload: {} });
        if (frame.type === "describe") {
            this.describes.push(frame.payload as DescribePayload);
            reply({ status: "ok", payload: { models: this.#opts.models ?? [] } });
        }
        if (frame.type === "chat" && this.#opts.chat) {
            try {
                reply({ status: "ok", payload: this.#opts.chat(frame.payload as ChatPayload) });
            } catch (e) {
                reply({ status: e instanceof DeniedError ? "denied" : "error", error: { message: (e as Error).message } });
            }
        }
    }

    close(): void {
        this.readyState = 3;
    }

    /** Open the socket; the handshake then runs on microtasks. */
    accept(): void {
        this.readyState = 1;
        this.onopen?.(null);
    }

    /** accept(), then wait until the handshake has settled. */
    async open(): Promise<void> {
        this.accept();
        await new Promise((resolve) => setImmediate(resolve));
    }

    /** A frame from the gateway: a request for the agent to answer, or a notice. */
    deliver(frame: unknown): void {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }

    /** The agent's reply to the request `id`, once it has sent one. */
    replyTo(id: string): SentFrame | undefined {
        return this.sent.find((f) => f.id === id && f.status !== undefined);
    }
}
