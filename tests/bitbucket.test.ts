import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BitbucketClient, bitbucketCredentials, parseDotenv } from "../src/forge/bitbucket.ts";

type Recorded = { method: string; path: string; auth: string | null; body: unknown };

const ENV_KEYS = ["BITBUCKET_USERNAME", "BITBUCKET_API_TOKEN", "TOLI_BITBUCKET_API", "TOLI_ROOT"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const requests: Recorded[] = [];
let server: Bun.Server<undefined>;
let api = "";

function pr(id: number, branch: string) {
    return {
        id,
        title: `PR ${id}`,
        state: "OPEN",
        draft: false,
        source: { branch: { name: branch }, commit: { hash: "abc123" } },
        destination: { branch: { name: "main" } },
        links: { html: { href: `https://bitbucket.org/ws/app/pull-requests/${id}` } },
    };
}

beforeAll(() => {
    server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
            const url = new URL(request.url);
            const text = await request.text();
            requests.push({
                method: request.method,
                path: `${url.pathname}${url.search}`,
                auth: request.headers.get("authorization"),
                body: text === "" ? null : JSON.parse(text),
            });
            const repo = "/2.0/repositories/ws/app";
            if (request.method === "POST" && url.pathname === `${repo}/pullrequests`)
                return Response.json(pr(5, "feature"));
            if (url.pathname === `${repo}/pullrequests/5`) return Response.json(pr(5, "feature"));
            if (url.pathname === `${repo}/pullrequests/404`)
                return Response.json({ error: { message: "Not found" } }, { status: 404 });
            if (url.pathname === `${repo}/commit/abc123/statuses` && url.searchParams.get("page") === "2")
                return Response.json({ values: [{ key: "lint", name: "lint", state: "INPROGRESS" }] });
            if (url.pathname === `${repo}/commit/abc123/statuses`)
                return Response.json({
                    values: [{ key: "build", name: "build", state: "SUCCESSFUL" }],
                    next: `${api}/repositories/ws/app/commit/abc123/statuses?pagelen=100&page=2`,
                });
            if (url.pathname === `${repo}/pullrequests` && url.searchParams.get("q"))
                return Response.json({ values: [pr(5, "feature")] });
            if (url.pathname === `${repo}/pullrequests`)
                return Response.json({ values: [pr(5, "feature"), pr(6, "fix")] });
            return Response.json({ error: { message: "unexpected" } }, { status: 500 });
        },
    });
    api = `http://127.0.0.1:${server.port}/2.0`;
});

afterAll(() => {
    server.stop(true);
});

afterEach(() => {
    requests.length = 0;
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
});

function useStub(): void {
    process.env.TOLI_BITBUCKET_API = api;
    process.env.BITBUCKET_USERNAME = "bob";
    process.env.BITBUCKET_API_TOKEN = "tok";
}

const BASIC = `Basic ${Buffer.from("bob:tok").toString("base64")}`;

describe("Bitbucket Cloud client", () => {
    test("creates a pull request with env credentials and returns its URL", async () => {
        useStub();
        const url = await new BitbucketClient("ws/app").create({
            title: "Add a",
            body: "Adds a.",
            head: "feature",
            base: "main",
            draft: true,
        });
        expect(url).toBe("https://bitbucket.org/ws/app/pull-requests/5");
        expect(requests).toEqual([
            {
                method: "POST",
                path: "/2.0/repositories/ws/app/pullrequests",
                auth: BASIC,
                body: {
                    title: "Add a",
                    description: "Adds a.",
                    source: { branch: { name: "feature" } },
                    destination: { branch: { name: "main" } },
                    draft: true,
                },
            },
        ]);
    });

    test("status reads the PR, then every page of its commit statuses", async () => {
        useStub();
        const status = await new BitbucketClient("ws/app").status({ id: "5" });
        expect(status).toMatchObject({ id: "5", state: "open", source: "feature", target: "main", ci: "pending" });
        expect(status.mergeable).toBeNull();
        expect(status.checks).toEqual([
            { name: "build", state: "success" },
            { name: "lint", state: "pending" },
        ]);
        expect(requests.map((request) => request.path)).toEqual([
            "/2.0/repositories/ws/app/pullrequests/5",
            "/2.0/repositories/ws/app/commit/abc123/statuses?pagelen=100",
            "/2.0/repositories/ws/app/commit/abc123/statuses?pagelen=100&page=2",
        ]);
        expect(requests.every((request) => request.auth === BASIC)).toBe(true);
    });

    test("status by branch queries open PRs from that branch", async () => {
        useStub();
        const status = await new BitbucketClient("ws/app").status({ branch: "feature" });
        expect(status.id).toBe("5");
        const query = new URL(`http://x${requests[0]?.path}`).searchParams.get("q");
        expect(query).toBe('source.branch.name="feature" AND state="OPEN"');
    });

    test("lists open pull requests", async () => {
        useStub();
        const prs = await new BitbucketClient("ws/app").list();
        expect(prs.map((entry) => [entry.id, entry.source, entry.url])).toEqual([
            ["5", "feature", "https://bitbucket.org/ws/app/pull-requests/5"],
            ["6", "fix", "https://bitbucket.org/ws/app/pull-requests/6"],
        ]);
        expect(requests[0]?.path).toBe("/2.0/repositories/ws/app/pullrequests?state=OPEN&pagelen=50");
    });

    test("API errors carry the HTTP status and message", async () => {
        useStub();
        await expect(new BitbucketClient("ws/app").status({ id: "404" })).rejects.toThrow("HTTP 404 Not found");
    });

    test("missing credentials fail with the setup hint", () => {
        expect(() => new BitbucketClient("ws/app", null)).toThrow("BITBUCKET_USERNAME and BITBUCKET_API_TOKEN");
    });

    test("credentials come from env first, then the repo-root .env", () => {
        const root = mkdtempSync(join(tmpdir(), "toli-bb-"));
        writeFileSync(
            join(root, ".env"),
            '# comment\nexport BITBUCKET_USERNAME="dot"\nBITBUCKET_API_TOKEN=dottok # trailing\n',
        );
        process.env.TOLI_ROOT = root;
        delete process.env.BITBUCKET_USERNAME;
        delete process.env.BITBUCKET_API_TOKEN;
        expect(bitbucketCredentials()).toEqual({ username: "dot", token: "dottok", source: ".env" });
        process.env.BITBUCKET_USERNAME = "envuser";
        process.env.BITBUCKET_API_TOKEN = "envtok";
        expect(bitbucketCredentials()).toEqual({ username: "envuser", token: "envtok", source: "environment" });
    });

    test("parseDotenv handles quotes and comments", () => {
        expect(parseDotenv("A=1\n#B=2\nC='x y'\nexport D=\"q\"\nE=v # c\n")).toEqual({
            A: "1",
            C: "x y",
            D: "q",
            E: "v",
        });
    });
});
