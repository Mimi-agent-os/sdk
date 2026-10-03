/** A scripted agent speaking @mimi-os/protocol: hello → describe → answer invoke, over any injected RawSocketLike. */
import { randomUUID } from "node:crypto";

import { x25519 } from "@noble/curves/ed25519.js";

import { parseEnvelope } from "@mimi-os/protocol";
import type {
    ReplyOf,
    RequestOf,
    A2aInvokePayload,
    AgentApp,
    AgentManifest,
    InvokePayload,
    ResultPayload,
    ToolSchema,
} from "@mimi-os/protocol";

import { createAppExecutor } from "../runtime/app-executor.ts";
import { channelSocket } from "../runtime/channel.ts";
import { b64, type AgentIdentity } from "../runtime/identity.ts";
import type { SocketLike } from "../client.ts";

export type { AgentIdentity };

export type ToolResult = ResultPayload;
/** `invoke` is the requesting frame's payload — `InvokePayload` for a model invoke, `A2aInvokePayload` for an a2a_invoke (same handler table, looked up by tool/command name either way). */
export type ToolHandler = (
    args: Record<string, unknown>,
    invoke: InvokePayload | A2aInvokePayload,
) => ToolResult | Promise<ToolResult>;
export type ToolTable = Record<string, ToolResult | ToolHandler>;

export type MisbehaviorMode = "none" | "silent" | "die" | "garbage" | "delay";

export interface RawSocketLike {
    send(data: string): void;
    close(): void;
}

/** The encrypted-channel socket returned by fakeAgentSocket(). */
export type AgentSocketLike = SocketLike;

export interface FakeAgentOptions {
    name: string;
    manifest?: Partial<AgentManifest> | undefined;
    /** The agent's own HTTP server, declared on describe beside the manifest. */
    app?: AgentApp | undefined;
    tools?: ToolSchema[] | undefined;
    handlers?: ToolTable | undefined;
    delayMs?: number | undefined;
}

export interface FakeAgentCore {
    readonly log: unknown[];
    setHandler(tool: string, handler: ToolResult | ToolHandler): void;
    setMisbehavior(tool: string, mode: MisbehaviorMode): void;
    setDefaultMisbehavior(mode: MisbehaviorMode): void;
    hello(socket: RawSocketLike): void;
    describe(socket: RawSocketLike): void;
    /** hello, then describe — resolves once describe is on the wire. */
    handshake(socket: RawSocketLike): Promise<void>;
    receive(raw: string, socket: RawSocketLike): Promise<void>;
}

const HANDSHAKE_TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A throwaway X25519 pair, the same shape ensureIdentity() returns — so a test that needs an identity is one line. */
export function fakeIdentity(): AgentIdentity {
    const pair = x25519.keygen();
    return { secret: pair.secretKey, publicKey: pair.publicKey, pubkey: b64(pair.publicKey) };
}

export function createFakeAgentCore(opts: FakeAgentOptions): FakeAgentCore {
    const log: unknown[] = [];
    const handlers = new Map<string, ToolResult | ToolHandler>(Object.entries(opts.handlers ?? {}));
    const misbehavior = new Map<string, MisbehaviorMode>();
    let defaultMisbehavior: MisbehaviorMode = "none";
    const delayMs = opts.delayMs ?? 50;
    let waiting: { socket: RawSocketLike; settle: (e?: Error) => void } | null = null;

    function errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    function hello(socket: RawSocketLike): void {
        const frame: RequestOf<"hello"> = {
            id: randomUUID(),
            type: "hello",
            payload: { agent: opts.name },
        };
        socket.send(JSON.stringify(frame));
    }

    /** hello, then describe once hello_ok has landed. */
    function handshake(socket: RawSocketLike): Promise<void> {
        hello(socket);
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (waiting?.socket === socket) waiting = null;
                reject(new Error("fake-agent: no hello_ok"));
            }, HANDSHAKE_TIMEOUT_MS);
            timer.unref?.();
            waiting = {
                socket,
                settle: (e?: Error) => {
                    clearTimeout(timer);
                    if (e) reject(e);
                    else resolve();
                },
            };
        });
    }

    function describe(socket: RawSocketLike): void {
        const manifest: AgentManifest = { name: opts.name, chain: false, ...opts.manifest };
        const frame: RequestOf<"describe"> = {
            id: randomUUID(),
            type: "describe",
            payload: { manifest, prompt: [], tools: opts.tools ?? [], app: opts.app },
        };
        socket.send(JSON.stringify(frame));
    }

    function setHandler(tool: string, handler: ToolResult | ToolHandler): void {
        handlers.set(tool, handler);
    }
    function setMisbehavior(tool: string, mode: MisbehaviorMode): void {
        misbehavior.set(tool, mode);
    }
    function setDefaultMisbehavior(mode: MisbehaviorMode): void {
        defaultMisbehavior = mode;
    }

    async function handleInvoke(frame: RequestOf<"invoke">, socket: RawSocketLike): Promise<void> {
        const mode = misbehavior.get(frame.payload.tool) ?? defaultMisbehavior;
        switch (mode) {
            case "silent":
                return;
            case "die":
                socket.close();
                return;
            case "garbage":
                socket.send("{not-json-fake-agent");
                return;
            case "delay":
                // clears the caller's deadline (not just a fixed pause) so the test provably sees a timeout
                await new Promise<void>((resolve) => setTimeout(resolve, (frame.deadline ?? 0) + delayMs));
                break;
            case "none":
                break;
        }

        const handler = handlers.get(frame.payload.tool);
        if (handler === undefined) {
            const reply: ReplyOf<"invoke"> = {
                id: frame.id,
                type: "result",
                status: "error",
                error: { message: `fake-agent: no handler for tool "${frame.payload.tool}"` },
            };
            socket.send(JSON.stringify(reply));
            return;
        }
        let encoded: string;
        try {
            const payload =
                typeof handler === "function" ? await handler(frame.payload.args, frame.payload) : handler;
            const reply: ReplyOf<"invoke"> = { id: frame.id, type: "result", status: "ok", payload };
            encoded = JSON.stringify(reply);
        } catch (error) {
            const reply: ReplyOf<"invoke"> = {
                id: frame.id,
                type: "result",
                status: "error",
                error: { message: errorMessage(error) },
            };
            socket.send(JSON.stringify(reply));
            return;
        }
        socket.send(encoded);
    }

    /** Same handler table as invoke, looked up by command name — a2a commands always name a mounted tool. */
    async function handleA2aInvoke(frame: RequestOf<"a2a_invoke">, socket: RawSocketLike): Promise<void> {
        const handler = handlers.get(frame.payload.command);
        if (handler === undefined) {
            const reply: ReplyOf<"a2a_invoke"> = {
                id: frame.id,
                type: "a2a_invoke_ok",
                status: "error",
                error: { message: `fake-agent: no handler for a2a command "${frame.payload.command}"` },
            };
            socket.send(JSON.stringify(reply));
            return;
        }
        let encoded: string;
        try {
            const result =
                typeof handler === "function" ? await handler(frame.payload.args, frame.payload) : handler;
            const reply: ReplyOf<"a2a_invoke"> = {
                id: frame.id,
                type: "a2a_invoke_ok",
                status: "ok",
                payload: { result },
            };
            encoded = JSON.stringify(reply);
        } catch (error) {
            const reply: ReplyOf<"a2a_invoke"> = {
                id: frame.id,
                type: "a2a_invoke_ok",
                status: "error",
                error: { message: errorMessage(error) },
            };
            socket.send(JSON.stringify(reply));
            return;
        }
        socket.send(encoded);
    }

    async function receive(raw: string, socket: RawSocketLike): Promise<void> {
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw) as unknown;
        } catch {
            log.push({ parseError: true, raw });
            return;
        }
        const frame = parseEnvelope(parsed);
        if (!frame) {
            log.push({ parseError: true, raw });
            return;
        }
        log.push(frame);
        const any = frame as unknown as Record<string, unknown>;
        if (any["type"] === "hello_ok") {
            const w = waiting;
            waiting = null;
            if (any["status"] !== "ok") w?.settle(new Error("fake-agent: hello refused"));
            else if (w) {
                describe(w.socket);
                w.settle();
            }
            return;
        }
        if (frame.type === "invoke") {
            const payload = any["payload"];
            if (!isRecord(payload) || typeof payload["tool"] !== "string" || !isRecord(payload["args"])) {
                log.push({ parseError: true, raw });
                return;
            }
            await handleInvoke(frame as RequestOf<"invoke">, socket);
        }
        if (frame.type === "a2a_invoke") {
            const payload = any["payload"];
            if (!isRecord(payload) || typeof payload["command"] !== "string" || !isRecord(payload["args"])) {
                log.push({ parseError: true, raw });
                return;
            }
            await handleA2aInvoke(frame as RequestOf<"a2a_invoke">, socket);
        }
    }

    return {
        log,
        setHandler,
        setMisbehavior,
        setDefaultMisbehavior,
        hello,
        describe,
        handshake,
        receive,
    };
}

/** A SocketLike over the real channel core, so a gateway test harness can drive a fake agent through the same ClientSession/ServerSession machinery real agents use. */
export function fakeAgentSocket(
    url: string,
    identity: AgentIdentity,
    gatewayPub: Uint8Array,
    opts?: { app?: { appId: string; upstream: string } | undefined; idleMs?: number | undefined },
): AgentSocketLike {
    // the real executor, never a second in-memory one: a gateway test spins a real upstream and this dials it
    const app = opts?.app;
    const appStreams = app
        ? createAppExecutor({ app, log: () => undefined, idleMs: opts?.idleMs })
        : undefined;
    return channelSocket({ url, secret: identity.secret, gatewayPub, appStreams });
}
