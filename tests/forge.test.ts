import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRemote } from "../src/forge.ts";
import { type Sandbox, sandbox, withProject } from "./helpers.ts";

const REAL_GIT = Bun.which("git") as string;

const GLAB_CONFIG = `git_protocol: ssh
host: gitlab.com
hosts:
    gitlab.com:
        api_protocol: https
        token: not-a-real-token
    gitlab.corp.example:
        api_protocol: https
        ssh_host: gitlab-ssh.corp.example
        token: not-a-real-token
    code.example.net:
        ssh_host: code-ssh.example.net
`;

type ForgeBox = { box: Sandbox; dir: string; log: string; env: Record<string, string> };

/**
 * A registered project "app" whose origin URL is `url` (rewritten to a local bare repo via insteadOf), with stub
 * `ssh -G` (alias gh-alias -> github.com), stub gh/glab logging their argv, and an isolated glab config.
 */
function forgeBox(url: string): ForgeBox {
    const box = sandbox();
    box.ok(["init", "--name", "m1", "--role", "coordinator"]);
    const dir = withProject(box, "app");
    const bare = join(box.root, ".origin", "app.git");
    box.git(dir, ["remote", "set-url", "origin", url]);
    box.git(dir, ["config", `url.${bare}.insteadOf`, url]);
    const glabDir = join(box.root, ".glab");
    mkdirSync(glabDir);
    writeFileSync(join(glabDir, "config.yml"), GLAB_CONFIG);
    const log = join(box.root, "stub.log");
    box.stub(
        "ssh",
        'if [ "$1" = "-G" ]; then case "$2" in gh-alias) echo "hostname github.com";; *) echo "hostname $2";; esac; exit 0; fi; exit 1',
    );
    const logArgs = `{ printf '%s\\n' "$(basename "$0")" "$@"; echo "GITLAB_HOST=$GITLAB_HOST"; echo ---; } >> "${log}"`;
    box.stub(
        "gh",
        `${logArgs}
case "$1 $2" in
    "auth status") exit 0;;
    "pr create") echo "https://github.com/acme/app/pull/12";;
    "pr view") cat "${join(box.root, "gh-view.json")}";;
    "pr list") echo '[{"number":12,"title":"T","state":"OPEN","isDraft":false,"headRefName":"feature","baseRefName":"main","url":"https://github.com/acme/app/pull/12"}]';;
esac`,
    );
    box.stub(
        "glab",
        `${logArgs}
case "$1 $2" in
    "auth status") exit 0;;
    "mr create") printf 'Creating merge request for feature into main\\nhttps://gitlab.corp.example/team/sub/app/-/merge_requests/7\\n';;
    "mr view") cat "${join(box.root, "glab-view.json")}";;
esac`,
    );
    const env = { GLAB_CONFIG_DIR: glabDir, BITBUCKET_USERNAME: "", BITBUCKET_API_TOKEN: "", GIT_LOG: "" };
    return { box, dir, log, env };
}

/** Each logged stub invocation as its argv lines (program first, GITLAB_HOST last). */
function invocations(log: string): string[][] {
    if (!existsSync(log)) return [];
    return readFileSync(log, "utf8")
        .split("---\n")
        .filter((chunk) => chunk !== "")
        .map((chunk) => chunk.trimEnd().split("\n"));
}

function forgeJson(fb: ForgeBox): Record<string, string> {
    return JSON.parse(fb.box.ok(["forge", "app", "--json"], { env: fb.env }));
}

describe("parseRemote", () => {
    test("reads scp, ssh:// and https remotes", () => {
        expect(parseRemote("git@github.com:acme/app.git")).toEqual({ host: "github.com", path: "acme/app", ssh: true });
        expect(parseRemote("ssh://git@gitlab-ssh.corp.example:2222/team/sub/app.git")).toEqual({
            host: "gitlab-ssh.corp.example",
            path: "team/sub/app",
            ssh: true,
        });
        expect(parseRemote("https://user@bitbucket.org/ws/app.git/")).toEqual({
            host: "bitbucket.org",
            path: "ws/app",
            ssh: false,
        });
        expect(parseRemote("/local/path/app.git")).toBeNull();
    });
});

describe("toli forge detection", () => {
    test("github over https and through an ssh alias", () => {
        const https = forgeBox("https://github.com/acme/app.git");
        expect(forgeJson(https)).toMatchObject({ forge: "github", host: "github.com", repo: "acme/app", ready: true });
        const alias = forgeBox("git@gh-alias:acme/app.git");
        expect(forgeJson(alias)).toMatchObject({ forge: "github", host: "github.com", remoteHost: "gh-alias" });
    });

    test("self-hosted gitlab: ssh endpoint maps to the glab host; unknown https hosts use the origin host", () => {
        const ssh = forgeBox("git@gitlab-ssh.corp.example:team/sub/app.git");
        expect(forgeJson(ssh)).toMatchObject({
            forge: "gitlab",
            host: "gitlab.corp.example",
            hostSource: "glab config",
            repo: "team/sub/app",
            ready: true,
        });
        const glabAuth = invocations(ssh.log).find((argv) => argv[0] === "glab");
        expect(glabAuth?.slice(1, 5)).toEqual(["auth", "status", "--hostname", "gitlab.corp.example"]);
        const https = forgeBox("https://gitlab.corp.example/team/app.git");
        expect(forgeJson(https)).toMatchObject({
            forge: "gitlab",
            host: "gitlab.corp.example",
            hostSource: "glab config",
        });
        const other = forgeBox("https://gitlab.other.example/team/app.git");
        expect(forgeJson(other)).toMatchObject({ forge: "gitlab", host: "gitlab.other.example", hostSource: "origin" });
        const unnamed = forgeBox("git@code-ssh.example.net:team/app.git");
        expect(forgeJson(unnamed)).toMatchObject({ forge: "gitlab", host: "code.example.net" });
    });

    test("bitbucket over ssh and https, never printing secrets", () => {
        for (const url of ["git@bitbucket.org:ws/app.git", "https://someone@bitbucket.org/ws/app.git"]) {
            const fb = forgeBox(url);
            const env = { ...fb.env, BITBUCKET_USERNAME: "bob", BITBUCKET_API_TOKEN: "s3cret-token" };
            const output = fb.box.ok(["forge", "app"], { env });
            expect(output).toContain("forge: bitbucket");
            expect(output).toContain("repo: ws/app");
            expect(output).toContain("ready: credentials from environment (user bob)");
            expect(output).not.toContain("s3cret-token");
        }
    });

    test("overrides win over detection; unknown hosts need --forge", () => {
        const fb = forgeBox("git@git.example.org:team/app.git");
        const unknown = fb.box.toli(["forge", "app"], { env: fb.env });
        expect(unknown.code).toBe(1);
        expect(unknown.stderr).toContain("--forge github|gitlab|bitbucket");
        fb.box.ok(["project", "set", "app", "--forge", "gitlab", "--forge-host", "gitlab.example.org"]);
        expect(forgeJson(fb)).toMatchObject({ forge: "gitlab", host: "gitlab.example.org", hostSource: "forgeHost" });

        const gl = forgeBox("git@gitlab-ssh.corp.example:team/app.git");
        gl.box.ok(["project", "set", "app", "--forge-host", "other.example"]);
        expect(forgeJson(gl)).toMatchObject({ forge: "gitlab", host: "other.example", hostSource: "forgeHost" });
        gl.box.ok(["project", "set", "app", "--forge", "github", "--forge-host", "none"]);
        expect(forgeJson(gl)).toMatchObject({ forge: "github", host: "gitlab-ssh.corp.example" });
        expect(gl.box.toli(["project", "set", "app", "--forge", "svn"]).code).toBe(1);
    });
});

describe("toli push and pr create", () => {
    test("push refuses a detached HEAD and pushes only the current branch, never forced", () => {
        const fb = forgeBox("https://github.com/acme/app.git");
        const gitLog = join(fb.box.root, "git.log");
        fb.box.stub("git", `printf '%s ' "$@" >> "${gitLog}"; echo >> "${gitLog}"; exec "${REAL_GIT}" "$@"`);
        fb.box.git(fb.dir, ["checkout", "--detach"]);
        const detached = fb.box.toli(["push", "app"], { env: fb.env });
        expect(detached.code).toBe(1);
        expect(detached.stderr).toContain("detached HEAD");

        fb.box.git(fb.dir, ["switch", "-c", "feature"]);
        fb.box.ok(["push", "app"], { env: fb.env });
        const pushes = readFileSync(gitLog, "utf8")
            .split("\n")
            .filter((line) => line.includes(" push "));
        expect(pushes).toEqual([`-C ${fb.dir} push -u origin refs/heads/feature:refs/heads/feature `]);
        expect(pushes.join(" ")).not.toMatch(/--force|\s-f\s|\+refs/);
        const bare = join(fb.box.root, ".origin", "app.git");
        expect(fb.box.git(bare, ["rev-parse", "feature"])).toBe(fb.box.git(fb.dir, ["rev-parse", "HEAD"]));
    });

    test("pr create refuses until the branch is on origin, then calls gh with the right arguments", () => {
        const fb = forgeBox("https://github.com/acme/app.git");
        fb.box.git(fb.dir, ["switch", "-c", "feature"]);
        writeFileSync(join(fb.dir, "a.txt"), "a\n");
        fb.box.ok(["commit", "app", "-m", "add a", "--", "a.txt"]);
        const create = ["pr", "create", "app", "--title", "Add a", "--body", "Adds a.", "--base", "main", "--draft"];
        const refused = fb.box.toli(create, { env: fb.env });
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("branch feature is not on origin");
        expect(refused.stderr).toContain("bin/toli push app");
        expect(invocations(fb.log).filter((argv) => argv[1] === "pr")).toEqual([]);

        fb.box.ok(["push", "app"], { env: fb.env });
        writeFileSync(join(fb.dir, "b.txt"), "b\n");
        fb.box.ok(["commit", "app", "-m", "add b", "--", "b.txt"]);
        const behind = fb.box.toli(create, { env: fb.env });
        expect(behind.code).toBe(1);
        expect(behind.stderr).toContain("does not contain local HEAD");

        fb.box.ok(["push", "app"], { env: fb.env });
        expect(fb.box.ok(create, { env: fb.env })).toBe("https://github.com/acme/app/pull/12");
        const call = invocations(fb.log).find((argv) => argv[1] === "pr");
        expect(call).toEqual([
            "gh",
            "pr",
            "create",
            "--head",
            "feature",
            "--title",
            "Add a",
            "--body",
            "Adds a.",
            "--base",
            "main",
            "--draft",
            "-R",
            "acme/app",
            "GITLAB_HOST=",
        ]);
    });

    test("gh pr status and list are normalized", () => {
        const fb = forgeBox("https://github.com/acme/app.git");
        writeFileSync(
            join(fb.box.root, "gh-view.json"),
            JSON.stringify({
                number: 12,
                title: "Add a",
                state: "OPEN",
                isDraft: false,
                headRefName: "feature",
                baseRefName: "main",
                url: "https://github.com/acme/app/pull/12",
                mergeable: "MERGEABLE",
                mergeStateStatus: "BLOCKED",
                statusCheckRollup: [
                    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
                    { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: "" },
                    { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS" },
                ],
            }),
        );
        const status = JSON.parse(fb.box.ok(["pr", "status", "app", "12", "--json"], { env: fb.env }));
        expect(status).toMatchObject({
            id: "12",
            state: "open",
            mergeable: true,
            mergeDetail: "blocked",
            ci: "pending",
        });
        expect(status.checks).toEqual([
            { name: "test", state: "success" },
            { name: "lint", state: "pending" },
            { name: "ci/legacy", state: "success" },
        ]);
        const view = invocations(fb.log).find((argv) => argv[1] === "pr" && argv[2] === "view");
        expect(view?.slice(0, 4)).toEqual(["gh", "pr", "view", "12"]);
        expect(view?.slice(-3)).toEqual(["-R", "acme/app", "GITLAB_HOST="]);

        // Without an id the current branch selects the PR.
        fb.box.ok(["pr", "status", "app"], { env: fb.env });
        expect(invocations(fb.log).filter((argv) => argv[2] === "view")[1]?.[3]).toBe("main");
        const list = fb.box.ok(["pr", "list", "app"], { env: fb.env });
        expect(list).toBe("#12\topen\tfeature -> main\tT\thttps://github.com/acme/app/pull/12");
    });

    test("glab mr create and view target the mapped host with GITLAB_HOST and --repo", () => {
        const fb = forgeBox("git@gitlab-ssh.corp.example:team/sub/app.git");
        fb.box.git(fb.dir, ["switch", "-c", "feature"]);
        fb.box.ok(["push", "app"], { env: fb.env });
        const bodyFile = join(fb.box.root, "body.md");
        writeFileSync(bodyFile, "Body from file\n");
        const url = fb.box.ok(["pr", "create", "app", "--title", "T", "--body-file", bodyFile], { env: fb.env });
        expect(url).toBe("https://gitlab.corp.example/team/sub/app/-/merge_requests/7");
        const create = invocations(fb.log).find((argv) => argv[1] === "mr");
        expect(create).toEqual([
            "glab",
            "mr",
            "create",
            "--source-branch",
            "feature",
            "--title",
            "T",
            "--description",
            "Body from file",
            "",
            "--yes",
            "-R",
            "team/sub/app",
            "GITLAB_HOST=gitlab.corp.example",
        ]);

        writeFileSync(
            join(fb.box.root, "glab-view.json"),
            JSON.stringify({
                iid: 7,
                title: "T",
                state: "opened",
                draft: false,
                source_branch: "feature",
                target_branch: "main",
                web_url: url,
                detailed_merge_status: "mergeable",
                head_pipeline: { id: 99, status: "failed" },
            }),
        );
        const status = fb.box.ok(["pr", "status", "app"], { env: fb.env });
        expect(status).toContain("state: open");
        expect(status).toContain("mergeable: yes (mergeable)");
        expect(status).toContain("ci: failure");
        expect(status).toContain("  failure pipeline 99");
        const view = invocations(fb.log).find((argv) => argv[2] === "view");
        expect(view).toEqual([
            "glab",
            "mr",
            "view",
            "feature",
            "-F",
            "json",
            "-R",
            "team/sub/app",
            "GITLAB_HOST=gitlab.corp.example",
        ]);
    });

    test("pr create needs exactly one body source", () => {
        const fb = forgeBox("https://github.com/acme/app.git");
        const neither = fb.box.toli(["pr", "create", "app", "--title", "T"], { env: fb.env });
        expect(neither.code).toBe(1);
        expect(neither.stderr).toContain("exactly one of --body");
    });
});
