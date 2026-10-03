/** The agent's avatar: a small raster file in its folder that describe carries to the gateway. */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { AVATAR_MAX_BYTES, avatarType } from "@mimi-os/protocol";
import type { AgentAvatar } from "@mimi-os/protocol";

/** Looked up in this order beside agent.json when runAgent() names no avatar. */
export const AVATAR_FILES = ["avatar.png", "avatar.webp", "avatar.jpg"];

/** `explicit` resolves against the agent folder; a missing file is no avatar, a bad one throws, and so does one that resolves outside the folder. */
export function readAvatar(dir: string, explicit?: string): AgentAvatar | undefined {
    const file = explicit === undefined ? AVATAR_FILES.map((f) => join(dir, f)).find((f) => existsSync(f)) : resolve(dir, explicit);
    if (file === undefined) return undefined;
    let real: string;
    let size: number;
    try {
        real = realpathSync(file);
        const stat = statSync(real);
        if (!stat.isFile()) throw new Error("not a regular file");
        size = stat.size;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error(`avatar ${file}: ${(e as Error).message}`);
    }
    // only the agent folder is watched, and the owner's other files are not the agent's to send
    const inside = relative(realpathSync(dir), real);
    if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`avatar ${file} resolves to ${real}, outside the agent folder.`);
    // sized before reading, so a huge file is never loaded
    if (size > AVATAR_MAX_BYTES) throw new Error(`avatar ${file} is ${size} bytes — over the ${AVATAR_MAX_BYTES}-byte limit.`);
    const bytes = readFileSync(real);
    const type = avatarType(bytes);
    if (!type) throw new Error(`avatar ${file} is not a PNG, WebP or JPEG image (judged by its bytes; SVG is refused).`);
    return { type, sha256: createHash("sha256").update(bytes).digest("hex"), data: bytes.toString("base64") };
}
