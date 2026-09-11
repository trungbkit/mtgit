#!/usr/bin/env node
/**
 * Invariant 1: a Tauri command touches four places — `commands.rs`, the
 * `invoke_handler![]` list in `lib.rs`, `src/ipc/commands.ts`, and
 * `src/ipc/types.ts`.
 *
 * Forgetting `lib.rs` still compiles, still typechecks, and fails only at
 * runtime with "command not found" from `invoke` — which no test in either
 * suite can see, because the Rust tests call `core::` directly and the
 * frontend tests mock the IPC layer. This script is the only thing that looks
 * at all three files at once.
 *
 * It cannot check `types.ts`: the mirroring there is structural, and a wrong
 * field type is a lie no amount of grep will catch.
 */
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const commands = read("src-tauri/src/commands.rs");
const lib = read("src-tauri/src/lib.rs");
const ts = read("src/ipc/commands.ts");

const declared = [...commands.matchAll(/#\[tauri::command\]\s*\npub fn (\w+)/g)].map((m) => m[1]);
const registered = new Set([...lib.matchAll(/commands::(\w+)/g)].map((m) => m[1]));
const invoked = new Set([...ts.matchAll(/invoke(?:<[^>]*>)?\(\s*"(\w+)"/g)].map((m) => m[1]));

const problems = [];
const report = (label, names) => {
  if (names.length) problems.push(`${label}:\n  ${names.join("\n  ")}`);
};

report(
  "Declared in commands.rs but missing from invoke_handler! in lib.rs\n" +
    '  (compiles and typechecks; fails at runtime with "command not found")',
  declared.filter((name) => !registered.has(name)),
);
report(
  "Listed in invoke_handler! but not declared in commands.rs",
  [...registered].filter((name) => !declared.includes(name)),
);
report(
  "Invoked from src/ipc/commands.ts but not declared in commands.rs",
  [...invoked].filter((name) => !declared.includes(name)),
);
report(
  "Declared but never invoked from the frontend (dead command, or a missing wrapper)",
  declared.filter((name) => !invoked.has(name)),
);

if (problems.length) {
  console.error(`IPC surface is inconsistent.\n\n${problems.join("\n\n")}\n`);
  process.exit(1);
}
console.log(`IPC surface consistent: ${declared.length} commands across commands.rs, lib.rs and ipc/commands.ts.`);
