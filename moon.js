#!/usr/bin/env node
/**
 * The moon launcher, the only code in the npm package. It fetches the current
 * CLI, verifies it against the signed file list of its build, and runs it, so
 * every install is on the current version without an npm release. Installed
 * copies never change, so keep this small and stable. If new CLI code needs
 * something this launcher does not offer, bump moonLauncherApi in package.json:
 * older launchers then stay on the last build they can run.
 */
import { createHash, verify } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "https://assets.moonomat.com/app/moon/";
const { version: VERSION, moonLauncherApi: API } = createRequire(import.meta.url)("./package.json");
const PUBLIC_KEY = fs.readFileSync(new URL("./keys/runtime.pub", import.meta.url), "utf8");

const cacheRoot = process.env.MOONOMAT_CACHE_DIR ? path.resolve(process.env.MOONOMAT_CACHE_DIR) : path.join(os.homedir(), ".cache", "moonomat");
const cli = path.join(cacheRoot, "cli");
const currentFile = path.join(cli, "current");
const previousFile = path.join(cli, "previous");
const etagFile = path.join(cli, "index.etag");
const unreachableFile = path.join(cli, "index.unreachable");
/** After a failed check, how long to run the installed version without trying again. */
const RETRY_AFTER_MS = 10 * 60 * 1000;

const BUILD_ID = /^[0-9a-f]+$/;
const LIST_LINE = /^([0-9a-f]{64}) {2}cli\/([A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*)$/;

const readText = (file) => {
    try {
        return fs.readFileSync(file, "utf8");
    } catch {
        return null;
    }
};

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** On Windows the rename fails while another moon process has the file open. */
const writeAtomic = (file, text) => {
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, text);
    for (let attempt = 1; ; attempt++) {
        try {
            fs.renameSync(temporary, file);
            return;
        } catch (e) {
            // Parallel processes write the same text.
            const done = readText(file) === text;
            if (done || attempt === 10) {
                fs.rmSync(temporary, { force: true });
                if (done) return;
                throw e;
            }
            sleep(20);
        }
    }
};

/** A file that only saves work later, so a failed write is no error. */
const remember = (file, text) => {
    try {
        writeAtomic(file, text);
    } catch {
        // Costs one more check next time.
    }
};

const isInstalled = (build) => build !== null && fs.existsSync(path.join(cli, build, "moon.mjs"));

const download = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`could not download ${url.pathname}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const readBytes = (file) => {
    try {
        return fs.readFileSync(file);
    } catch {
        return null;
    }
};

/** Writes the build's CLI files to its own folder, which appears only when complete. */
const install = async (build, installed) => {
    if (!BUILD_ID.test(build)) throw new Error("the build index is malformed");
    const buildRoot = new URL(`builds/${build}/`, ROOT);
    const list = await download(new URL("files.sha256", buildRoot));
    const signature = await download(new URL("files.sig", buildRoot));
    if (!verify(null, list, PUBLIC_KEY, signature)) throw new Error(`build ${build} has no valid signature`);

    const [header, ...lines] = new TextDecoder().decode(list).trimEnd().split("\n");
    if (header !== `moon-runtime build=${build} launcher=${API}`) throw new Error(`the signed file list does not belong to build ${build}`);

    const target = path.join(cli, build);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
        for (const line of lines) {
            if (!line.includes("  cli/")) continue;
            const match = LIST_LINE.exec(line);
            if (!match) throw new Error("the signed file list is malformed");
            // Most files do not change between builds.
            const known = installed ? readBytes(path.join(cli, installed, match[2])) : null;
            const bytes = known && sha256(known) === match[1] ? known : await download(new URL(`cli/${match[2]}`, buildRoot));
            if (sha256(bytes) !== match[1]) throw new Error(`${match[2]} does not match the signed file list`);
            const file = path.join(temporary, match[2]);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, bytes);
        }
        if (!isInstalled(build)) {
            try {
                fs.renameSync(temporary, target);
            } catch (e) {
                // Another moon process installed it first.
                if (!isInstalled(build)) throw e;
            }
        }
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
};

/** Keeps the current build and the one before it. A failed cleanup costs only disk space. */
const prune = (keep) => {
    try {
        for (const name of fs.readdirSync(cli)) {
            if (BUILD_ID.test(name) && !keep.includes(name)) fs.rmSync(path.join(cli, name), { recursive: true, force: true });
        }
    } catch {
        // Tried again after the next update.
    }
};

/** The build to run: the newest one this launcher can, or the installed one if that cannot be had. */
const resolveBuild = async () => {
    fs.mkdirSync(cli, { recursive: true });
    const stored = readText(currentFile);
    const current = isInstalled(stored) ? stored : null;
    const etag = current ? readText(etagFile) : null;

    // On a network that drops traffic, each try costs a full timeout.
    const failedAgo = Date.now() - Number(readText(unreachableFile));
    if (current && failedAgo >= 0 && failedAgo < RETRY_AFTER_MS) return current;

    let response;
    try {
        response = await fetch(new URL("builds/index.json", ROOT), { headers: etag ? { "If-None-Match": etag } : {}, signal: AbortSignal.timeout(current ? 2000 : 15000) });
    } catch (e) {
        if (current) {
            remember(unreachableFile, String(Date.now()));
            return current;
        }
        throw new Error(`could not reach moonomat.com: ${e.message}`);
    }
    if (response.status === 304 && current) return current;
    if (!response.ok) {
        if (current) return current;
        throw new Error(`could not reach moonomat.com: HTTP ${response.status}`);
    }

    try {
        const { builds } = await response.json();
        const newest = builds.find((b) => b.launcher === API);
        if (!newest) throw new Error("this version of moon is too old: run npm install -g @moonomat/moon@latest");
        if (newest !== builds[0]) process.stderr.write("moon: a newer version needs an update: run npm install -g @moonomat/moon@latest\n");
        if (newest.build !== current) {
            process.stderr.write("moon: updating\n");
            await install(newest.build, current);
            if (current) writeAtomic(previousFile, current);
            writeAtomic(currentFile, newest.build);
            prune([newest.build, current]);
        }
        const newEtag = response.headers.get("etag");
        if (newEtag) remember(etagFile, newEtag);
        return newest.build;
    } catch (e) {
        if (!current) throw e;
        process.stderr.write(`moon: keeping the installed version: ${e.message}\n`);
        return current;
    }
};

const run = async (build) => {
    globalThis.moonLauncher = { build, version: VERSION, api: API, importDep: (name) => import(name) };
    await import(pathToFileURL(path.join(cli, build, "moon.mjs")).href);
};

try {
    const build = await resolveBuild();
    try {
        await run(build);
    } catch (e) {
        // moon.mjs handles its own errors, so this is a build that cannot even load.
        const previous = readText(previousFile);
        if (!isInstalled(previous) || previous === build) throw e;
        process.stderr.write(`moon: going back to the previous version: ${e.message}\n`);
        await run(previous);
    }
} catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
}
