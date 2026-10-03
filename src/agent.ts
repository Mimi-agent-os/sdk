/** runAgent(): the whole agent process — its folder, store, packs, one socket. */

import { existsSync, lstatSync, readFileSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { GATEWAY_PORT, parseInviteUri } from "@mimi-os/protocol";
import type {
    AgentApp,
    AgentManifest,
    AgentPolicy,
    ChatOkPayload,
    DescribePayload,
    Message,
    ModelGrant,
    NotifyPayload,
    PackDisabled,
    PromptPart,
    ResultPayload,
    SessionHead,
    SessionId,
    Tool,
    ToolSchema,
} from "@mimi-os/protocol";
import { Chat } from "./store/chat.ts";
import { GatewayClient } from "./client.ts";
import type { SocketFactory } from "./client.ts";
import { buildDispatch } from "./dispatch.ts";
import { createAppExecutor } from "./runtime/app-executor.ts";
import { AVATAR_FILES, readAvatar } from "./runtime/avatar.ts";
import { loadAgentEnv } from "./runtime/env.ts";
import type { AgentEnv } from "./runtime/env.ts";
import { channelSocket, enrollAgent } from "./runtime/channel.ts";
import { b64, ensureIdentity, gatewayKeyFile, unb64 } from "./runtime/identity.ts";
import { buildManifest, readManifest } from "./manifest.ts";
import type { PackDef, PackRuntime } from "./runtime/pack.ts";
import { Projection } from "./store/projection.ts";
import { agentDir, dataDir, ensureDataDir, promptFile, writeAtomic } from "./runtime/paths.ts";
import { openStore } from "./store/store.ts";
import { defineTool, toolSchema } from "./runtime/tool.ts";
import type { ToolInstance } from "./runtime/tool.ts";

export interface RunOptions {
    /** The agent's folder — its code, its .env, its data folder. Defaults to the cwd. */
    dir?: string | undefined;
    /** Store, identity, gateway pin and pack files, relative to `dir`; defaults to MIMI_DATA_DIR in the agent's .env, else data/. */
    dataDir?: string | undefined;
    /** Where the gateway listens; `url` overrides both. With none of the three set, MIMI_GATEWAY_URL from the agent's .env is the url. */
    host?: string | undefined;
    port?: number | undefined;
    url?: string | undefined;
    log?: ((msg: string) => void) | undefined;
    /** Preferred model id; the gateway resolves a turn's model primary → this → its default. */
    model?: string | undefined;
    /** This agent may be a chain target. Default false. */
    chain?: boolean | undefined;
    policy?: AgentPolicy | undefined;
    /** Tool names other agents may run over a2a, no LLM turn on either side; each must name a mounted tool. */
    a2a?: string[] | undefined;
    /** The agent's own running HTTP server; sent to the gateway on connect with the manifest. */
    app?: AgentApp | undefined;
    /** The avatar file, relative to `dir`; defaults to the first of avatar.png, avatar.webp, avatar.jpg there. PNG, WebP or JPEG, at most 64 KiB. */
    avatar?: string | undefined;
    /** Tools that never ask: described read-only, and a mid-execution ask answers yes. */
    unasked?: string[] | undefined;
    /** false drops the built-in notify_user tool; agent.notify() from code stays. */
    notify?: false | undefined;
    /** Tools written in code; mounted after the built-ins and before any pack. */
    tools?: ToolInstance[] | undefined;
    /** Packs defined in code with definePack(); env-gated, then mounted and started. */
    packs?: PackDef[] | undefined;
    /** Test seam: bypasses identity/enrollment/channel entirely, wired straight into GatewayClient. */
    socket?: SocketFactory | undefined;
}

export interface AskOptions {
    /** A granted model id; "auto" or omitted lets the gateway resolve primary → manifest → default. */
    model?: string;
    tools?: Tool[];
    params?: Record<string, unknown>;
    session?: SessionId;
    /** Bare label for the Calls list; the gateway prefixes the agent name. */
    scope?: string;
    /** Reject the call if the gateway does not answer within this many ms; omitted = wait forever. */
    timeoutMs?: number;
    /** Put this agent's own system prompt (persona, pack parts, date) in front, exactly as a turn builds it. */
    withPrompt?: boolean;
}

export interface A2aOptions {
    timeoutMs?: number;
}

export interface AgentRuntime {
    name: string;
    dir: string;
    /** What describe sends: agent.json's name and description plus the RunOptions fields. */
    manifest: AgentManifest;
    chat: Chat;
    projection: Projection;
    client: GatewayClient;
    tools: Map<string, ToolInstance>;
    /** The model grants the gateway sent at describe time — empty until connected, refreshed on reconnect. */
    models(): ModelGrant[];
    /** One-shot model call for the agent's own code; a string becomes a single user message. */
    ask(input: string | Message[], opts?: AskOptions): Promise<ChatOkPayload>;
    /** Run one of a target agent's listed a2a commands — no LLM turn on either side. */
    a2a(target: string, command: string, args?: Record<string, unknown>, opts?: A2aOptions): Promise<ResultPayload>;
    /** Tell the person something unprompted — the tool's own path, for code that has no model. */
    notify(payload: NotifyPayload): void;
    stop(): Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";
const ENROLL_RETRY_MS = 30_000;
// an editor's save is several fs events in a row; one describe answers them all
const AVATAR_SETTLE_MS = 100;
// describe travels as one stream-0 message the channel refuses above 1 MiB; the whole serialized payload shares this budget.
const DESCRIBE_JSON_MAX = 512 * 1024;

/** No gateway.pub yet: wait for MIMI_INVITE in the agent's own .env, then pair and pin the key for good. */
async function resolveGatewayPub(
    dir: string,
    data: string,
    url: () => string,
    name: string,
    secret: Uint8Array,
    log: (msg: string) => void,
    dataFromEnv: boolean,
): Promise<Uint8Array> {
    const file = gatewayKeyFile(data);
    const pinnedFile = lstatSync(file, { throwIfNoEntry: false });
    if (pinnedFile?.isFile()) {
        const pinned = unb64(readFileSync(file, "utf8").trim());
        if (pinned.length === 32) return pinned;
        log(`[identity] ${file} is not a valid gateway key — re-enrolling\n`);
    } else if (pinnedFile?.isDirectory()) {
        throw new Error(`[identity] ${file} is a directory, not a gateway key.`);
    } else if (pinnedFile) {
        log(`[identity] ${file} is not a regular gateway key — re-enrolling\n`);
    }
    for (;;) {
        const env = loadAgentEnv(dir);
        const invite = env["MIMI_INVITE"];
        // the data folder is fixed at boot: enrolling now would pin this gateway where .env no longer points
        const named = dataFromEnv ? dataDir(dir, env["MIMI_DATA_DIR"]?.trim()) : data;
        if (named !== data) {
            log(`[identity] MIMI_DATA_DIR now names ${named}, but this agent booted with ${data} — restart it to enroll there\n`);
        } else if (!invite) {
            log(
                "[identity] no gateway.pub and no MIMI_INVITE — create an agent invite in the " +
                    "app and put it in this agent's .env as MIMI_INVITE\n",
            );
        } else {
            try {
                const { id } = parseInviteUri(invite);
                const pub = await enrollAgent({
                    url: `${url()}/pair?invite=${id}`,
                    secret,
                    invite,
                    name,
                    log,
                });
                writeAtomic(file, `${b64(pub)}\n`);
                log("[identity] enrolled with the gateway — MIMI_INVITE may now be removed from .env\n");
                return pub;
            } catch (e) {
                log(`[identity] enrollment failed — ${(e as Error).message}\n`);
            }
        }
        await new Promise((resolve) => setTimeout(resolve, ENROLL_RETRY_MS));
    }
}

/** `writes: false` on purpose — a run nobody is watching is exactly who needs this. */
function notifyTools(getClient: () => GatewayClient): ToolInstance[] {
    return [
        defineTool(
            "notify_user",
            "Report something to the OWNER proactively — it's filed in their Inbox and reaches " +
                "their devices even when no chat is open. Use this for things that happened without " +
                'them asking, e.g. "finished the nightly report". Not for answering a question you ' +
                "were just asked.",
            {
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        description: "One short line — this is what they see first. Keep it short.",
                    },
                    body: {
                        type: "string",
                        description: "The report, as Markdown. Optional, but this is where detail goes.",
                    },
                    level: {
                        type: "string",
                        enum: ["info", "warn", "action"],
                        description:
                            "info = it just happened; warn = it went wrong; action = you need them.",
                    },
                },
                required: ["title"],
            },
            (args) => {
                const title = String(args["title"] ?? "").trim();
                if (!title) return "Error: pass a non-empty title.";
                const body = typeof args["body"] === "string" ? args["body"].trim() : "";
                const raw = String(args["level"] ?? "info");
                const level = raw === "warn" || raw === "action" ? raw : "info";
                getClient().notify({ title, level, ...(body ? { body } : {}) });
                return "Sent.";
            },
        ),
    ];
}

/** Boot the agent whose folder this is and connect it to the gateway. */
export async function runAgent(opts: RunOptions = {}): Promise<AgentRuntime> {
    const bootedAt = Date.now();
    const log = opts.log ?? ((msg: string): void => void process.stdout.write(msg));
    const dir = agentDir(opts.dir);
    const local = readManifest(dir);
    const name = local.name;
    const env: AgentEnv = loadAgentEnv(dir);
    const data = dataDir(dir, opts.dataDir ?? env["MIMI_DATA_DIR"]?.trim());

    const tools = new Map<string, ToolInstance>();
    const add = (list: readonly ToolInstance[], source: string): void => {
        const collision = list.find((tool) => tools.has(tool.definition.function.name));
        if (collision) {
            throw new Error(
                `Agent "${name}": duplicate tool "${collision.definition.function.name}" from ${source}.`,
            );
        }
        for (const tool of list) tools.set(tool.definition.function.name, tool);
    };
    if (opts.notify !== false) add(notifyTools(() => client), "built-ins");
    add(opts.tools ?? [], "code");

    // packs and the returned runtime share these, so a pack drives the same client
    const ask: AgentRuntime["ask"] = (input, { model, timeoutMs, ...rest } = {}) =>
        client.chat(
            {
                ...rest,
                messages: typeof input === "string" ? [{ role: "user", content: input }] : input,
                model: model === "auto" ? undefined : model,
            },
            timeoutMs,
        );
    const notify: AgentRuntime["notify"] = (payload: NotifyPayload) => client.notify(payload);

    let packError: string | undefined;
    let describeError: string | undefined;

    const packs: Array<{ def: PackDef; rt: PackRuntime }> = [];
    const packsDisabled: PackDisabled[] = [];
    for (const def of opts.packs ?? []) {
        const missing = (def.env ?? []).filter((key) => !Object.hasOwn(env, key) || !env[key]);
        if (missing.length) {
            log(`[pack] ${def.name}: disabled — set ${missing.join(", ")}\n`);
            packsDisabled.push({ name: def.name, missing });
            continue;
        }
        const rt: PackRuntime = {
            ask,
            notify,
            connected: () => client.connected,
            dataDir: join(data, "packs", def.name),
            redescribe: () => client.redescribe(),
            log: (m) => log(`[pack] ${def.name}: ${m}\n`),
        };
        try {
            // a second pack of the same name would share the first one's data folder and prompt part
            if (packs.some((p) => p.def.name === def.name)) throw new Error(`a pack named "${def.name}" is already mounted`);
            // mount first: a pack whose mount throws mounts no tools, and add() is atomic on a collision
            def.mount?.(rt);
            add(def.tools, `pack "${def.name}"`);
            packs.push({ def, rt });
        } catch (e) {
            // one broken pack must not stop the agent coming up — health is where it surfaces
            packError = `pack ${def.name}: ${(e as Error).message}`;
            log(`[pack] ${def.name}: FAILED — ${(e as Error).message}\n`);
        }
    }

    const { manifest, app } = buildManifest(local, opts, new Set(tools.keys()));
    const a2aCommands = new Set(opts.a2a ?? []);
    // an unasked tool is described as no write at all, so the gateway never parks a card for it
    const unasked = new Set(opts.unasked ?? []);
    if (unasked.size) log(`[approval] never asked for: ${[...unasked].join(", ")}\n`);
    const schemas = (): ToolSchema[] =>
        [...tools.values()].map((t) =>
            unasked.has(t.definition.function.name) ? { ...toolSchema(t), writes: false } : toolSchema(t),
        );

    // describe cannot drop these: an agent declaring more than the budget would never complete a handshake, so it fails here instead of retrying forever
    const fixedBytes = Buffer.byteLength(JSON.stringify({ manifest, tools: schemas(), app, packsDisabled }), "utf8");
    if (fixedBytes > DESCRIBE_JSON_MAX) {
        throw new Error(
            `Agent "${name}": manifest, app and tool schemas serialize to ${fixedBytes} bytes, over the ` +
                `${DESCRIBE_JSON_MAX}-byte limit for what an agent sends the gateway on connect. Shorten tool descriptions or parameter schemas.`,
        );
    }
    // a bad avatar stops the boot like any other describe limit; describe re-reads it, so later edits only drop it
    const bootAvatar = readAvatar(dir, opts.avatar);
    if (!bootAvatar && opts.avatar !== undefined) {
        throw new Error(`Agent "${name}": avatar ${resolve(dir, opts.avatar)} does not exist.`);
    }
    // only a configuration that checked out creates anything on disk
    ensureDataDir(data);

    /** Rebuilt per connect. A part that no longer fits the budget is dropped and named, never silently truncated. */
    const describe = (): DescribePayload => {
        // app is the agent's own HTTP server; the gateway carries requests to it over this channel
        const payload: DescribePayload = { manifest, prompt: [], tools: schemas(), app, packsDisabled };

        const omitted: string[] = [];
        const problems: string[] = [];
        // the channel measures the SERIALIZED message, so the budget charges JSON bytes — escaping included — over what already rides
        let budget = DESCRIBE_JSON_MAX - Buffer.byteLength(JSON.stringify(payload), "utf8");
        const parts: PromptPart[] = [];
        const persona = promptFile(dir);
        if (existsSync(persona)) {
            parts.push({ name: "persona", text: readFileSync(persona, "utf8").trim() });
        }
        for (const { def } of packs) {
            let text: string | undefined;
            try {
                text = def.prompt?.();
            } catch (e) {
                // one broken pack must not fail the handshake: its skill still rides, and health names it
                problems.push(`pack ${def.name}: prompt() failed — ${(e as Error).message}`);
            }
            parts.push({ name: `pack:${def.name}`, text: [def.skill, text].filter(Boolean).join("\n\n") });
        }
        for (const part of parts) {
            if (part.text === "") continue;
            const bytes = Buffer.byteLength(JSON.stringify(part), "utf8");
            if (bytes > budget) {
                omitted.push(`prompt section ${part.name} (${bytes} bytes)`);
                continue;
            }
            budget -= bytes;
            payload.prompt.push(part);
        }

        // the avatar is decoration: it takes what the prompt left over
        try {
            const avatar = readAvatar(dir, opts.avatar);
            const bytes = avatar ? Buffer.byteLength(JSON.stringify(avatar), "utf8") : 0;
            if (bytes > budget) omitted.push(`avatar (${bytes} bytes)`);
            else payload.avatar = avatar;
        } catch (e) {
            problems.push((e as Error).message);
        }

        if (omitted.length) problems.push(`omitted ${omitted.join(", ")}: over the ${DESCRIBE_JSON_MAX}-byte limit`);
        describeError = problems.length ? `describe: ${problems.join("; ")}` : undefined;
        if (describeError) log(`[describe] ${describeError}\n`);
        return payload;
    };

    const localUrl = `ws://${opts.host ?? DEFAULT_HOST}:${opts.port ?? GATEWAY_PORT}/channel`;
    // re-read while enrolling, so a waiting agent follows the address a later `mimi invite --write` puts in .env
    const gatewayUrl = (): string =>
        opts.url ??
        (opts.host === undefined && opts.port === undefined ? loadAgentEnv(dir)["MIMI_GATEWAY_URL"]?.trim() || localUrl : localUrl);

    // A test socket owns the whole transport; real connections create an identity and pin the gateway first.
    let socket = opts.socket;
    if (!socket) {
        const identity = ensureIdentity(data, log);
        const gatewayPub = await resolveGatewayPub(dir, data, gatewayUrl, name, identity.secret, log, opts.dataDir === undefined);
        // appId is the agent name, the way the gateway assigns it; with no app every stream > 0 is reset
        const appStreams = app ? createAppExecutor({ app: { appId: name, upstream: app.upstream }, log }) : undefined;
        socket = (u: string) => channelSocket({ url: u, secret: identity.secret, gatewayPub, log, appStreams });
    }

    const packStops: Array<() => void> = [];
    let packsStarted = false;

    const store = openStore(name, data);
    const chat = new Chat(store);
    const projection = new Projection(chat);
    const client: GatewayClient = new GatewayClient({
        url: gatewayUrl(),
        agent: name,
        log,
        socket,
        describe,
        dispatch: buildDispatch({
            name,
            chat,
            tools,
            a2aCommands,
            unasked,
            bootedAt,
            getClient: (): GatewayClient => client,
            getLastError: () => describeError ?? packError,
        }),
        // once, on the first ready session: a pack's first job must find the gateway already there
        onReady: () => {
            if (packsStarted) return;
            packsStarted = true;
            for (const { def, rt } of packs) {
                if (!def.start) continue;
                try {
                    const stop = def.start(rt);
                    if (stop) packStops.push(stop);
                } catch (e) {
                    packError = `pack ${def.name}: ${(e as Error).message}`;
                    log(`[pack] ${def.name}: start FAILED — ${(e as Error).message}\n`);
                }
            }
        },
    });

    chat.onChange((head: SessionHead) => client.notifyChanged(head));

    // watch the folder, not the file: editors save by writing a temp file and renaming it over the old one
    const avatarFolder = opts.avatar === undefined ? dir : dirname(resolve(dir, opts.avatar));
    const avatarNames = opts.avatar === undefined ? AVATAR_FILES : [basename(opts.avatar)];
    let avatarTimer: NodeJS.Timeout | undefined;
    let avatarWatch: FSWatcher | undefined;
    try {
        avatarWatch = watch(avatarFolder, (_event, file) => {
            if (file !== null && !avatarNames.includes(file)) return;
            clearTimeout(avatarTimer);
            avatarTimer = setTimeout(() => client.redescribe(), AVATAR_SETTLE_MS);
        });
        avatarWatch.on("error", (e) => log(`[avatar] watching ${avatarFolder} failed — ${e.message}\n`));
    } catch (e) {
        // an exhausted watch limit costs only live avatar updates, never the agent
        log(`[avatar] cannot watch ${avatarFolder}, a changed avatar needs a restart — ${(e as Error).message}\n`);
    }

    let shuttingDown: Promise<void> | undefined;
    function shutdown(): Promise<void> {
        if (!shuttingDown) {
            avatarWatch?.close();
            clearTimeout(avatarTimer);
            for (const stop of packStops) {
                try {
                    stop();
                } catch (e) {
                    log(`[pack] stop failed — ${(e as Error).message}\n`);
                }
            }
            client.close();
            chat.onChange(undefined);
            store.close();
            shuttingDown = Promise.resolve();
        }
        return shuttingDown;
    }

    try {
        // a turn that died left its tool_calls open; the boot is where that gets closed for real
        for (const s of chat.listSessions()) {
            const repaired = projection.repairParity(s.id);
            if (repaired) log(`[chat] session ${s.id}: ${repaired} tool result(s) synthesized\n`);
        }
        client.start();
    } catch (error) {
        await shutdown();
        throw error;
    }

    return {
        name,
        dir,
        manifest,
        chat,
        projection,
        client,
        tools,
        models: () => client.models(),
        ask,
        a2a: (target, command, args, opts) =>
            client.a2aCall({ agent: target, command, args: args ?? {} }, opts?.timeoutMs),
        notify,
        stop: shutdown,
    };
}
