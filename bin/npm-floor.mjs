#!/usr/bin/env node
// 入口。Node の版を先に見てから本体を読む（古い Node でも読める文で止まるように）。
const major = Number(process.versions.node.split(".")[0]);
if (!(major >= 20)) {
  console.error(`error: Node.js 20 or newer is required (this is ${process.versions.node}) / Node.js 20 以上が必要です`);
  process.exit(1);
}
const { runCli } = await import("../lib/cli.mjs");
const code = await runCli(process.argv.slice(2));
if (process.stdout.writableLength > 0) process.stdout.write("", () => process.exit(code));
else process.exit(code);
