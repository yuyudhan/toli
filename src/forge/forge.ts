import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Args } from "../core/args.ts";
import { currentBranch, git, gitOk, headSha, isGitRepo } from "../core/git.ts";
import { paths } from "../core/paths.ts";
import { persona } from "../core/persona.ts";
import { out, platform, printJson, run, runInherit, ToliError } from "../core/util.ts";
import { runInSlot, withBuildSlot } from "../fleet/build-slots.ts";
import { activeHookPath } from "../projects/hooks.ts";
import { requirePushHooks } from "../projects/hooks-gates.ts";
import { type Forge, findProject, loadProjects, type Project, projectCloneDir } from "../projects/projects.ts";
import { workDir } from "../projects/workspace.ts";
import { appendPush, pushAttribution, pushLine } from "../records/push-log.ts";
import { BitbucketClient, bitbucketCredentials, bitbucketCredentialsHelp } from "./bitbucket.ts";
import {
    type ForgeClient,
    GhClient,
    GlabClient,
    MERGE_METHODS,
    type MergeMethod,
    type PrStatus,
    type PrSummary,
} from "./cli.ts";
import { parseGateWait } from "./gate.ts";
import { gatePush } from "./gate-hook.ts";

/** `--task T<n>`: the project command acts on that task's workspace (its worktree or task branch). */
const TASK_FLAG = "task";

/** A remote URL split into host and repository path (`owner/repo`, `group/sub/repo`). */
export type Remote = { host: string; path: string; ssh: boolean };

/** Parse https://, ssh:// and scp-style (`git@host:path`) remote URLs; null when no host/path can be read. */
export function parseRemote(url: string): Remote | null {
    const trimmed = url.trim();
    let host: string;
    let path: string;
    let ssh: boolean;
    const withScheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
    if (withScheme) {
        ssh = !/^https?$/i.test(withScheme[1] as string);
        host = withScheme[2] as string;
        path = withScheme[3] as string;
    } else {
        const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(trimmed);
        if (!scp) return null;
        ssh = true;
        host = scp[1] as string;
        path = scp[2] as string;
    }
    path = path.replace(/\/+$/, "").replace(/\.git$/, "");
    if (!path.includes("/")) return null;
    return { host: host.toLowerCase(), path, ssh };
}

/** The real host behind an ssh alias (`ssh -G` reads ~/.ssh/config only; no connection is made). */
function resolveSshHost(alias: string): string {
    const result = run(["ssh", "-G", alias], { timeoutMs: 5_000 });
    if (result.code !== 0) return alias;
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("hostname "));
    return line ? line.slice("hostname ".length).trim().toLowerCase() : alias;
}

export type GlabHost = { host: string; sshHost?: string };

/** glab's config.yml: `GLAB_CONFIG_DIR`, else the platform config dir, else ~/.config/glab-cli. */
function glabConfigPath(): string | null {
    const dirs = process.env.GLAB_CONFIG_DIR
        ? [process.env.GLAB_CONFIG_DIR]
        : [
              ...(process.env.XDG_CONFIG_HOME ? [join(process.env.XDG_CONFIG_HOME, "glab-cli")] : []),
              ...(platform() === "darwin" ? [join(homedir(), "Library", "Application Support", "glab-cli")] : []),
              join(homedir(), ".config", "glab-cli"),
          ];
    return dirs.map((dir) => join(dir, "config.yml")).find((file) => existsSync(file)) ?? null;
}

/** Host names and their `ssh_host` from glab's config; tokens in the same file are never read into the result. */
export function glabHosts(): GlabHost[] {
    const file = glabConfigPath();
    if (file === null) return [];
    const hosts: GlabHost[] = [];
    let inHosts = false;
    for (const line of readFileSync(file, "utf8").split("\n")) {
        if (/^\S/.test(line)) {
            inHosts = /^hosts:\s*$/.test(line);
            continue;
        }
        if (!inHosts) continue;
        const hostKey = /^ {4}([^\s#:][^:]*):\s*$/.exec(line);
        if (hostKey) {
            hosts.push({ host: (hostKey[1] as string).replace(/^["']|["']$/g, "").toLowerCase() });
            continue;
        }
        const sshHost = /^ {8}ssh_host:\s*["']?([^"'\s#]+)["']?\s*(#.*)?$/.exec(line);
        const current = hosts[hosts.length - 1];
        if (sshHost && current) current.sshHost = (sshHost[1] as string).toLowerCase();
    }
    return hosts;
}

export type ForgeTarget = {
    forge: Forge;
    /** Host the forge CLI/API addresses (github.com, the glab host, bitbucket.org). */
    host: string;
    hostSource: "forgeHost" | "glab config" | "origin";
    /** Repository path on the forge: owner/repo, group/sub/repo, workspace/repo. */
    repo: string;
    remote: string;
    /** The host as written in the remote URL (an ssh alias or ssh endpoint for ssh remotes). */
    remoteHost: string;
};

/** Detect the forge of a remote URL; per-project `forge`/`forgeHost` overrides win over detection. */
export function detectForge(url: string, overrides: { forge?: Forge; forgeHost?: string } = {}): ForgeTarget {
    const remote = parseRemote(url);
    if (!remote) throw new ToliError(`cannot read a host and repository path from remote "${url}"`);
    // For ssh remotes match both the written host and the ~/.ssh/config HostName it resolves to.
    const resolved = remote.ssh ? resolveSshHost(remote.host) : remote.host;
    const candidates = [remote.host, resolved];
    const glab = glabHosts();
    const glabBySsh = glab.find((entry) => entry.sshHost !== undefined && candidates.includes(entry.sshHost));
    const glabKnown = glabBySsh ?? glab.find((entry) => candidates.includes(entry.host));
    let forge = overrides.forge;
    if (forge === undefined) {
        if (candidates.some((host) => host === "github.com" || host.endsWith(".github.com"))) forge = "github";
        else if (candidates.includes("bitbucket.org")) forge = "bitbucket";
        else if (glabKnown || candidates.some((host) => host.includes("gitlab"))) forge = "gitlab";
    }
    if (forge === undefined)
        throw new ToliError(
            `cannot tell which forge serves ${remote.host}: set it with bin/toli project set <name> --forge github|gitlab|bitbucket`,
        );
    const base = { forge, repo: remote.path, remote: url, remoteHost: remote.host };
    if (overrides.forgeHost) return { ...base, host: overrides.forgeHost, hostSource: "forgeHost" };
    if (forge === "bitbucket") return { ...base, host: "bitbucket.org", hostSource: "origin" };
    if (forge === "gitlab" && glabKnown) return { ...base, host: glabKnown.host, hostSource: "glab config" };
    return { ...base, host: resolved, hostSource: "origin" };
}

/**
 * Detection for a registered project from its clone's configured `remote.origin.url` (raw, before `insteadOf`
 * rewriting), falling back to the registered URL when the clone is missing.
 */
export function projectForge(project: Project): ForgeTarget {
    const dir = paths.projectDir(project.name);
    const origin = isGitRepo(dir) ? git(dir, ["config", "--get", "remote.origin.url"]) : null;
    const url = origin && origin.code === 0 ? origin.stdout.trim() : project.url;
    if (!url) throw new ToliError(`${project.name} has no origin remote and no registered URL`);
    return detectForge(url, project);
}

export type Readiness = { ready: boolean; detail: string };

function firstLine(text: string): string {
    return (
        text
            .split("\n")
            .find((line) => line.trim() !== "")
            ?.trim() ?? ""
    );
}

/** Whether toli can talk to this forge host: CLI authenticated (gh/glab) or credentials present (Bitbucket). */
export function forgeReadiness(forge: Forge, host: string): Readiness {
    if (forge === "bitbucket") {
        const credentials = bitbucketCredentials();
        return credentials
            ? { ready: true, detail: `credentials from ${credentials.source} (email ${credentials.email})` }
            : { ready: false, detail: bitbucketCredentialsHelp() };
    }
    const cli = forge === "github" ? "gh" : "glab";
    const result = run([cli, "auth", "status", "--hostname", host], { timeoutMs: 30_000 });
    if (result.code === 127) return { ready: false, detail: `${cli} not found on PATH` };
    if (result.code === 0) return { ready: true, detail: `${cli} authenticated for ${host}` };
    const reason = firstLine(result.stderr || result.stdout);
    return { ready: false, detail: `${cli} not authenticated for ${host}${reason ? `: ${reason}` : ""}` };
}

function clientFor(target: ForgeTarget, dir: string): ForgeClient {
    if (target.forge === "github")
        return new GhClient(target.host === "github.com" ? target.repo : `${target.host}/${target.repo}`, dir);
    if (target.forge === "gitlab") return new GlabClient(target.repo, target.host, dir);
    return new BitbucketClient(target.repo);
}

export function forgeCommand(argv: string[]): void {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(1);
    const project = findProject(args.pos(0, "project"));
    const target = projectForge(project);
    const readiness = forgeReadiness(target.forge, target.host);
    if (args.bool("json")) {
        printJson({ project: project.name, ...target, ...readiness });
        return;
    }
    out(`forge: ${target.forge}`);
    out(`host: ${target.host} (from ${target.hostSource})`);
    out(`repo: ${target.repo}`);
    out(`remote: ${target.remote}${target.remoteHost !== target.host ? ` (ssh host ${target.remoteHost})` : ""}`);
    out(`${readiness.ready ? "ready" : "not ready"}: ${readiness.detail}`);
}

/** The checked-out branch, refusing a detached HEAD. */
function requireBranch(dir: string, action: string): string {
    const branch = currentBranch(dir);
    if (branch === null) throw new ToliError(`refusing to ${action}: ${dir} is on a detached HEAD`);
    return branch;
}

/**
 * Hard rule 1: refuse a push that carries neither the user's `--word` nor the project's standing push grant on this
 * machine (`bin/toli project set <p> --standing-push yes`, kept in this machine's project entry).
 */
function requirePushAuthority(project: string, word: string | null): void {
    if (word !== null) return;
    if (loadProjects().find((entry) => entry.name === project)?.standing?.push === true) return;
    const user = persona().user;
    throw new ToliError(
        `refusing to push ${project}: no --word and no standing push grant for ${project} on this machine. ` +
            `Pass --word "<${user}'s word>" quoting ${user}'s word for this push, or have ${user} grant it with ` +
            `\`bin/toli project set ${project} --standing-push yes\``,
    );
}

/**
 * `git push -u origin <current branch>` as an explicit refs/heads refspec: never forced, never another ref. Refused
 * unless `--word` quotes the user's word for this push or the project has a standing push grant on this machine. Runs
 * in the task's workspace with `--task` (or from inside a task worktree), else in the project clone. A push that moved
 * origin's branch is recorded in this machine's push log (src/records/push-log.ts), attributed with `--by`/`--for`/
 * `--word` (or the issuing machine and task `bin/toli exec` put in the environment). With `--gate "<recipe>"` the gate
 * runs first and the push happens only once it passed on HEAD's tree (gatePush, src/forge/gate-hook.ts); a pre-push
 * hook that only repeats it is skipped for exactly the gated commit. A project whose pre-push hook runs pushes in one
 * heavy-build slot and its memory-capped scope (src/fleet/build-slots.ts), since the hook may run the long check
 * itself: its cargo gets one slot's share of the cores even through `just` without toli's cargo shim, and a `bin/toli
 * gate run` it starts rides on that slot. A push is refused when the repo declares a pre-push hook
 * (src/projects/hooks.ts) that git would not run, so the project's own check never silently skips; `--no-hooks-ok`
 * pushes anyway. Other declared hooks that are not installed only warn.
 */
export async function pushCommand(argv: string[]): Promise<void> {
    const args = new Args(argv, {
        values: [TASK_FLAG, "by", "for", "word", "gate", "gate-wait"],
        booleans: ["no-hooks-ok"],
    });
    args.maxPositional(1);
    const project = args.pos(0, "project");
    const { dir, task } = workDir(project, args.str(TASK_FLAG));
    const attribution = pushAttribution(args, task?.id);
    requirePushAuthority(project, attribution.word);
    requirePushHooks(project, dir, args.bool("no-hooks-ok"));
    const branch = requireBranch(dir, "push");
    const ref = `refs/heads/${branch}`;
    const recipe = args.str("gate");
    const { env: gateEnv, skipHookAt } =
        recipe === undefined
            ? { env: {}, skipHookAt: null }
            : await gatePush({ project, dir, recipe, json: false }, parseGateWait(args.str("gate-wait")));
    const before = git(dir, ["ls-remote", "origin", ref]);
    if (before.code !== 0)
        throw new ToliError(`git ls-remote origin failed: ${(before.stderr || before.stdout).trim()}`);
    const old = before.stdout.trim().split(/\s+/)[0] || null;
    // A skipped hook pushes the gated sha itself, never the branch (which could move before git reads it); git sets no
    // upstream for a sha source, so it is set below as -u would.
    const push =
        skipHookAt === null
            ? ["git", "-C", dir, "push", "-u", "origin", `${ref}:${ref}`]
            : ["git", "-C", dir, "push", "--no-verify", "origin", `${skipHookAt}:${ref}`];
    const code =
        skipHookAt === null && activeHookPath(dir, "pre-push") !== null
            ? await withBuildSlot(dir, project, ({ env, scope }) => runInSlot(push, { ...gateEnv, ...env }, scope))
            : await runInherit(push, { env: gateEnv });
    if (code !== 0) throw new ToliError(`git push origin ${branch} failed (exit ${code})`);
    if (skipHookAt !== null) {
        gitOk(dir, ["config", `branch.${branch}.remote`, "origin"]);
        gitOk(dir, ["config", `branch.${branch}.merge`, ref]);
    }
    const pushed = skipHookAt ?? headSha(dir, ref);
    if (pushed === old) {
        out(`push log: nothing new on origin/${branch}`);
        return;
    }
    out(`push log: ${pushLine(appendPush({ project, branch, old, new: pushed, ...attribution }))}`);
}

/** Refuse unless origin has `branch` and it contains the local HEAD; `pushHint` names the push command to run. */
function requirePushed(dir: string, pushHint: string, branch: string): void {
    const remote = git(dir, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
    if (remote.code !== 0)
        throw new ToliError(`git ls-remote origin failed: ${(remote.stderr || remote.stdout).trim()}`);
    const remoteSha = remote.stdout.trim().split(/\s+/)[0] ?? "";
    const push = `run ${pushHint} first (only with ${persona().user}'s word to push, or the project's standing push grant)`;
    if (remoteSha === "") throw new ToliError(`refusing: branch ${branch} is not on origin; ${push}`);
    const head = headSha(dir);
    if (remoteSha !== head && git(dir, ["merge-base", "--is-ancestor", head, remoteSha]).code !== 0)
        throw new ToliError(`refusing: origin/${branch} does not contain local HEAD ${head.slice(0, 12)}; ${push}`);
}

function statusLines(pr: PrStatus): string[] {
    const mergeable = pr.mergeable === null ? "unknown" : pr.mergeable ? "yes" : "no";
    return [
        `#${pr.id} ${pr.title}`,
        `state: ${pr.state}${pr.draft ? " (draft)" : ""}`,
        `branches: ${pr.source} -> ${pr.target}`,
        `mergeable: ${mergeable}${pr.mergeDetail ? ` (${pr.mergeDetail})` : ""}`,
        `ci: ${pr.ci}`,
        ...pr.checks.map((check) => `  ${check.state} ${check.name}`),
        `url: ${pr.url}`,
    ];
}

function summaryLine(pr: PrSummary): string {
    return `#${pr.id}\t${pr.state}${pr.draft ? " (draft)" : ""}\t${pr.source} -> ${pr.target}\t${pr.title}\t${pr.url}`;
}

async function prCreate(argv: string[]): Promise<void> {
    const args = new Args(argv, { values: ["title", "body", "body-file", "base", TASK_FLAG], booleans: ["draft"] });
    args.maxPositional(1);
    const project = findProject(args.pos(0, "project"));
    const work = workDir(project.name, args.str(TASK_FLAG));
    const dir = work.dir;
    const title = args.str("title");
    if (!title) throw new ToliError("pr create needs --title <title>");
    const bodyText = args.str("body");
    const bodyFile = args.str("body-file");
    if ((bodyText === undefined) === (bodyFile === undefined))
        throw new ToliError("pr create needs exactly one of --body <text> or --body-file <file>");
    if (bodyFile !== undefined && !existsSync(bodyFile)) throw new ToliError(`--body-file ${bodyFile} does not exist`);
    const body = bodyText ?? readFileSync(bodyFile as string, "utf8");
    const branch = requireBranch(dir, "open a pull request");
    const target = projectForge(project);
    requirePushed(dir, `bin/toli push ${project.name}${work.task === null ? "" : ` --task ${work.task.id}`}`, branch);
    const base = args.str("base") ?? work.task?.workspace?.base ?? undefined;
    const url = await clientFor(target, dir).create({
        title,
        body,
        head: branch,
        draft: args.bool("draft"),
        ...(base === undefined ? {} : { base }),
    });
    out(url);
}

async function prStatus(argv: string[]): Promise<void> {
    const args = new Args(argv, { booleans: ["json"], values: [TASK_FLAG] });
    args.maxPositional(2);
    const project = findProject(args.pos(0, "project"));
    const { dir } = workDir(project.name, args.str(TASK_FLAG));
    const id = args.positional[1];
    const ref =
        id !== undefined ? { id } : { branch: requireBranch(dir, "find the pull request of the current branch") };
    const status = await clientFor(projectForge(project), dir).status(ref);
    if (args.bool("json")) printJson(status);
    else out(statusLines(status).join("\n"));
}

async function prList(argv: string[]): Promise<void> {
    const args = new Args(argv, { booleans: ["json"] });
    args.maxPositional(1);
    const project = findProject(args.pos(0, "project"));
    const prs = await clientFor(projectForge(project), projectCloneDir(project.name)).list();
    if (args.bool("json")) printJson(prs);
    else out(prs.length === 0 ? "no open pull requests" : prs.map(summaryLine).join("\n"));
}

async function prMerge(argv: string[]): Promise<void> {
    const args = new Args(argv, { values: ["method"] });
    args.maxPositional(2);
    const project = findProject(args.pos(0, "project"));
    const id = args.pos(1, "id");
    const method = args.str("method");
    if (method !== undefined && !(MERGE_METHODS as readonly string[]).includes(method))
        throw new ToliError(`--method must be one of ${MERGE_METHODS.join(", ")}`);
    const client = clientFor(projectForge(project), projectCloneDir(project.name));
    out(await client.merge(id, method as MergeMethod | undefined));
}

const PR_SUBCOMMANDS: Record<string, (argv: string[]) => Promise<void>> = {
    create: prCreate,
    status: prStatus,
    list: prList,
    merge: prMerge,
};

export async function prCommand(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    const handler = sub !== undefined && Object.hasOwn(PR_SUBCOMMANDS, sub) ? PR_SUBCOMMANDS[sub] : undefined;
    if (!handler) throw new ToliError("usage: toli pr create|status|list|merge <project> ...");
    await handler(rest);
}
