import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RunOptions } from "../src/agent.ts";
import { buildManifest, readManifest } from "../src/manifest.ts";

const withManifest = (json: unknown, fn: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), "mimi-manifest-"));
    try {
        writeFileSync(join(dir, "agent.json"), JSON.stringify(json));
        fn(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

const build = (opts: RunOptions, tools: string[] = []): ReturnType<typeof buildManifest> =>
    buildManifest({ name: "shop" }, opts, new Set(tools));

test("agent.json holds a name and an optional one-line description, nothing else", () => {
    withManifest({ name: "quiet" }, (dir) => {
        assert.deepEqual(readManifest(dir), { name: "quiet" });
    });
    for (const raw of ["  Keeps a reading list.  ", "Keeps a reading list.\n"]) {
        withManifest({ name: "quiet", description: raw }, (dir) => {
            assert.deepEqual(readManifest(dir), { name: "quiet", description: "Keeps a reading list." });
        });
    }
    for (const description of [7, "", "   ", "two\nlines", "x".repeat(301)]) {
        withManifest({ name: "quiet", description }, (dir) => {
            assert.throws(() => readManifest(dir), /"description" must be one non-empty line of at most 300 characters/);
        });
    }
});

test("any other agent.json key fails", () => {
    withManifest({ name: "quiet", descripton: "typo" }, (dir) => {
        assert.throws(
            () => readManifest(dir),
            /"descripton" is not an agent\.json field\. agent\.json holds only "name" and "description"; everything else is a runAgent\(\) option/,
        );
    });
});

test("agent.json must be an object with a valid name", () => {
    for (const json of [null, [], "quiet"]) {
        withManifest(json, (dir) => {
            assert.throws(() => readManifest(dir), /agent\.json must contain an object/);
        });
    }
    withManifest({ name: 7 }, (dir) => {
        assert.throws(() => readManifest(dir), /"name" must be a string/);
    });
    withManifest({ name: "main" }, (dir) => {
        assert.throws(() => readManifest(dir), /Invalid agent name "main"/);
    });
});

test("the wire manifest is agent.json plus the RunOptions fields", () => {
    assert.deepEqual(build({}).manifest, { name: "shop", chain: false });
    const { manifest, app } = buildManifest(
        { name: "shop", description: "Sells things." },
        {
            model: "qwen",
            chain: true,
            policy: { allowedTools: ["orders"], budgets: { daily: 5 } },
            a2a: ["orders"],
            unasked: ["orders"],
            notify: false,
        },
        new Set(["orders"]),
    );
    assert.deepEqual(manifest, {
        name: "shop",
        description: "Sells things.",
        chain: true,
        model: "qwen",
        policy: { allowedTools: ["orders"], budgets: { daily: 5 } },
        a2a: { commands: ["orders"] },
    });
    assert.equal(app, undefined);
    assert.throws(() => build({ model: " " }), /"model" must be a non-empty string/);
});

test("the app is checked whole, and a bad one is refused with a message that names the field", () => {
    assert.deepEqual(
        build({
            app: {
                title: "  Orders  ",
                entry: "/orders",
                pages: [{ id: "queue", title: "Queue", path: "/orders/queue" }, { id: "done", title: "Done" }],
                upstream: "http://127.0.0.1:3377",
            },
        }).app,
        {
            title: "Orders",
            entry: "/orders",
            pages: [{ id: "queue", title: "Queue", path: "/orders/queue" }, { id: "done", title: "Done" }],
            upstream: "http://127.0.0.1:3377",
        },
    );
    const refused: Array<[NonNullable<RunOptions["app"]>, RegExp]> = [
        [{ title: " ", upstream: "http://127.0.0.1:3377" }, /"app\.title" must be a non-empty string/],
        [{ title: "Orders", upstream: "ftp://127.0.0.1:3377" }, /"app\.upstream" must be an http\(s\) URL/],
        [{ title: "Orders", upstream: "127.0.0.1:3377" }, /"app\.upstream" must be an http\(s\) URL/],
        [{ title: "Orders", upstream: "http://x", entry: "orders" }, /"app\.entry" must be a path/],
        [{ title: "Orders", upstream: "http://x", pages: [{ id: "queue", title: "" }] }, /"app\.pages\[0\]"/],
        [
            { title: "Orders", upstream: "http://x", pages: [{ id: "q", title: "Q", path: "q" }] },
            /"app\.pages\[0\]\.path" must be a path/,
        ],
    ];
    for (const [app, message] of refused) {
        assert.throws(() => build({ app }), message);
    }
});

test("a2a commands and unasked must name mounted tools, and nothing may use the reserved prefix", () => {
    assert.throws(() => build({ a2a: ["send_mail"] }, ["get_system"]), /a2a command "send_mail" does not name a mounted tool/);
    assert.throws(
        () => build({ a2a: ["a2a_send_mail"] }, ["send_mail"]),
        /a2a command "a2a_send_mail" uses the reserved prefix "a2a_"/,
    );
    assert.throws(() => build({}, ["a2a_shop"]), /tool "a2a_shop" uses the reserved prefix "a2a_"/);
    assert.throws(() => build({ unasked: ["typo"] }, ["orders"]), /"unasked" names no mounted tool "typo"/);
});
