# @mimi-os/sdk

[![CI](https://github.com/Mimi-agent-os/sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/Mimi-agent-os/sdk/actions/workflows/ci.yml)

The library you write a mimi-os agent with; mimi-os is a personal agent runtime with a gateway, agents and an app.
An agent is a folder with a prompt and some tools; `runAgent()` connects it to your gateway, which runs the model.
It builds on protocol, and plugins adds ready-made memory, wiki and daily routines on top.

Requires Node.js 24 or newer and pnpm (`corepack enable pnpm`).

## Where it sits

`runAgent()` reads `agent.json`, opens the agent's store, mounts its tools and packs, and holds one encrypted
channel to the gateway, which runs every chat turn and calls the tools over it. The `agents` and `devkit`
profiles of `mimi-launch` clone the sdk next to `protocol/`, which it links as `link:../protocol`; plugins,
gateway, devkit and every agent link the sdk in turn. Consumers import `dist/`, so run `pnpm build` after
editing `src/`.

## Commands

Build protocol first.

```sh
pnpm build    # empty dist/, then tsc -p tsconfig.build.json
pnpm check    # tsc over src and test, no emit
pnpm test     # node --test "test/**/*.test.ts"
```

## A minimal agent

An agent is a folder with its own `package.json`; link the SDK into it with `pnpm add link:<workspace>/sdk`.

`agent.json` holds the name and a one-line description:

```json
{ "name": "hello", "description": "Rolls dice for the owner." }
```

`prompt.md` is the persona, the first part of the system prompt:

```md
You are Hello. Use roll_dice for every roll; never make a number up.
```

`index.ts`, run by `"start": "node index.ts"` in a `"type": "module"` `package.json`:

```ts
import { defineTool, runAgent } from "@mimi-os/sdk";

const rollDice = defineTool(
    "roll_dice",
    "Roll one die and return the number that came up.",
    { type: "object", properties: { sides: { type: "integer", description: "Sides, 6 if omitted." } } },
    (args) => {
        const sides = typeof args["sides"] === "number" ? args["sides"] : 6;
        return String(1 + Math.floor(Math.random() * sides));
    },
);

const agent = await runAgent({ tools: [rollDice] });
process.on("SIGINT", () => void agent.stop().then(() => process.exit(0)));
```

`pnpm start` creates `data/identity.key` and waits for an invite. With the gateway running, create
one for the name `hello` in the app (Agent invites) or with `mimi invite hello --write .env`. The
agent re-reads `.env` every 30 s, pairs, pins the gateway's key in `data/gateway.pub`, and connects;
later starts connect with that pinned key. Everything it keeps (`agent.db`, its keys, `packs/<name>/`) lives in
the data folder. The other `runAgent()` options (`model`, `packs`, `app`, `a2a`, `unasked`, ...)
are typed and commented in `RunOptions`, `src/agent.ts`.

## Avatar

The agent's picture is a file beside `agent.json`: the first of `avatar.png`, `avatar.webp`,
`avatar.jpg`, or the path `runAgent({ avatar })` names, relative to the agent folder. The SDK checks
its bytes for PNG, WebP or JPEG, at most 64 KiB, in a regular file that resolves inside the agent folder,
symlinks included; an invalid picture stops the boot. On connect the agent sends the gateway one
message that describes it: its name, tools, prompt and the picture (base64), together at most 512 KiB
of JSON. The picture goes in last: when the prompt fills that budget, the message goes without it and
the agent's health status names it. The SDK watches the folder and sends that message again when the
file is replaced or deleted, so a new picture reaches the gateway while the agent runs; a file edited
into something invalid is dropped and named the same way.

## .env

The agent's own `.env`, plain or dotenvx-encrypted with `.env.keys`. The SDK reads three keys:

| key | meaning |
|---|---|
| `MIMI_INVITE` | read while `gateway.pub` is absent; single use, for one agent name, valid for 24 hours |
| `MIMI_GATEWAY_URL` | the gateway's `ws://<host>:<port>/channel` when `runAgent` gets no `url`, `host` or `port`; default `ws://127.0.0.1:46464/channel` |
| `MIMI_DATA_DIR` | the data folder, relative to the agent folder, when `runAgent` gets no `dataDir`; default `data`; read once, at boot |

Every other key is the agent's: `loadAgentEnv(dir)` returns them decrypted as a frozen object,
separate from `process.env`; `setAgentEnv(dir, key, value)` writes one, encrypted unless
`{ encrypt: false }`.

## Packs

A pack is a reusable feature: `definePack({ name, tools, skill?, prompt?, env?, mount?, start?, ... })`
bundles tools with prompt text, the `.env` keys it needs (the pack mounts when all of them are set),
a data folder and a background job; mount it with `runAgent({ packs: [...] })`. The standard packs
`memory()`, `wiki()` and `cron()` are in `@mimi-os/plugins`.

## Trust

An agent on the gateway's machine runs as your OS user, with access to the gateway's files, its `.env`
and keys included. Run agents you did not write on another machine or as another OS user.

An agent can serve its own web interface (`runAgent({ app })`), which the macOS desktop app opens.
The SDK carries the app's requests to `app.upstream` with a key held in this process's memory and the
upstream's own Host. The agent's web server runs in that same process and checks both: wrap its
request listener in `gatewayOnly()` (an Express app is one), and call `fromGateway(req)` in an upgrade
listener. Every other caller, including a page that rebinds its name to 127.0.0.1, gets a plain 403.

## Testing

`@mimi-os/sdk/testing`: `HandshakeSocket` stands in for the gateway, so `runAgent({ socket: () => sock })`
runs an agent under `node --test` in process; the other fakes are for gateway tests.
`gatewayHeaders(upstream)` is the header that gets a test's requests past `gatewayOnly()`.

To test against a real gateway and model, use devkit (`pnpm add -D link:<workspace>/devkit`):

```sh
pnpm exec mimi-dev up --provider vllm --url <endpoint> --model <id> --ctx <tokens>
pnpm exec mimi-dev invite --write     # MIMI_INVITE, MIMI_GATEWAY_URL, MIMI_DATA_DIR into .env
pnpm start                            # the agent, in another terminal
pnpm exec mimi-dev check              # what the gateway made of it
pnpm exec mimi-dev chat
pnpm exec mimi-dev down
```

## Neighbours

- [protocol](https://github.com/Mimi-agent-os/protocol): the wire types and the channel this runtime speaks.
- [plugins](https://github.com/Mimi-agent-os/plugins): the `memory()`, `wiki()` and `cron()` packs.
- [gateway](https://github.com/Mimi-agent-os/gateway): the other end of the channel, and the `mimi` CLI.
- [devkit](https://github.com/Mimi-agent-os/devkit): `mimi-dev`, an agent against a real gateway.
- [launch](https://github.com/Mimi-agent-os/launch): `mimi-launch` and the workspace profiles.
- [wiki](https://mimi-agent-os.github.io/wiki/): every mimi-os README in one place.

Licensed under Apache-2.0, see LICENSE.
