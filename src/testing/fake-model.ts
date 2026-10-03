/** OpenAI-compatible chat-completions SSE server, scripted per request — mirrors the llama.cpp/OpenRouter/vLLM dialect parsed by gateway/src/llm/providers/shared/openai-sse.ts. */
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";

export interface TextDelta {
    kind: "text";
    text: string;
}

export interface ToolCallDelta {
    kind: "tool_call";
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
}

export interface FinishDelta {
    kind: "finish";
    reason: string;
}

export type TurnEvent = TextDelta | ToolCallDelta | FinishDelta;

export interface TurnUsage {
    prompt_tokens: number;
    completion_tokens: number;
    /** Scripted only when the dialect reports it: rides as completion_tokens_details.reasoning_tokens. */
    reasoning_tokens?: number;
}

export interface ScriptedTurn {
    events: TurnEvent[];
    usage: TurnUsage;
}

export interface FakeModel {
    readonly requests: Record<string, unknown>[];
    readonly url: string;
    listen(): Promise<string>;
    nextTurn(turn: ScriptedTurn): void;
    close(): Promise<void>;
}

function eventChunk(event: TurnEvent): Record<string, unknown> {
    if (event.kind === "text") {
        return { choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }] };
    }
    if (event.kind === "tool_call") {
        const fn: Record<string, string> = {};
        if (event.name !== undefined) fn["name"] = event.name;
        if (event.arguments !== undefined) fn["arguments"] = event.arguments;
        const call: Record<string, unknown> = { index: event.index, function: fn };
        if (event.id !== undefined) call["id"] = event.id;
        return { choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] };
    }
    return { choices: [{ index: 0, delta: {}, finish_reason: event.reason }] };
}

function writeSafe(res: ServerResponse, text: string): void {
    if (!res.writable) return;
    try {
        res.write(text);
    } catch {
        // client disconnected mid-stream — nothing to recover
    }
}

/** FIFO queue of scripted turns (queue more with `nextTurn`); an empty queue answers a 4xx, which no provider retries, so a missing script fails loudly and at once. */
export function createFakeModel(turns: ScriptedTurn[] = []): FakeModel {
    const queue: ScriptedTurn[] = [...turns];
    const requests: Record<string, unknown>[] = [];
    let boundUrl = "";

    const server = createServer((req, res) => {
        if (req.method !== "POST") {
            res.writeHead(404).end();
            return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
            } catch {
                res.writeHead(400).end();
                return;
            }
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                res.writeHead(400).end();
                return;
            }
            const body = parsed as Record<string, unknown>;
            requests.push(body);

            const turn = queue.shift();
            if (!turn) {
                res.writeHead(409, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "fake-model: no scripted turn queued" }));
                return;
            }

            const model = typeof body["model"] === "string" ? body["model"] : "fake-model";
            const id = `fakecmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const created = Math.floor(Date.now() / 1000);

            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });

            for (const event of turn.events) {
                const chunk = { id, object: "chat.completion.chunk", created, model, ...eventChunk(event) };
                writeSafe(res, `data: ${JSON.stringify(chunk)}\n\n`);
            }
            const { prompt_tokens, completion_tokens, reasoning_tokens } = turn.usage;
            const usage: Record<string, unknown> = { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
            if (reasoning_tokens !== undefined) usage["completion_tokens_details"] = { reasoning_tokens };
            const usageChunk = { id, object: "chat.completion.chunk", created, model, choices: [], usage };
            writeSafe(res, `data: ${JSON.stringify(usageChunk)}\n\n`);
            writeSafe(res, "data: [DONE]\n\n");
            res.end();
        });
    });

    function listen(): Promise<string> {
        return new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                const addr = server.address();
                if (addr === null || typeof addr === "string") {
                    reject(new Error("fake-model: no address after listen"));
                    return;
                }
                boundUrl = `http://127.0.0.1:${addr.port}`;
                resolve(boundUrl);
            });
        });
    }

    function nextTurn(turn: ScriptedTurn): void {
        queue.push(turn);
    }

    function close(): Promise<void> {
        server.closeAllConnections();
        return new Promise((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
        });
    }

    return {
        requests,
        get url() {
            return boundUrl;
        },
        listen,
        nextTurn,
        close,
    };
}
