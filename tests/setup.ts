// Preloaded by bunfig.toml: a top-level hook here runs once, after every test file.
import { afterAll } from "bun:test";
import { removeTempDirs } from "./helpers.ts";

afterAll(removeTempDirs);
