import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const excluded = new Set([".git", "dist", "node_modules", ".wrangler"]);
const binary = new Set([".png", ".jpg", ".jpeg", ".mp4"]);
const findings = [];
const privatePatterns = [
  /(?:ghp_|github_pat_)[A-Za-z0-9_]{25,}/,
  /sk-[A-Za-z0-9_-]{24,}/,
  /appg(?:prj|dep|ver)_[a-f0-9]{16,}/,
  /plugin_asdk_app_sites_[a-f0-9]{16,}/,
  /\b(?:agent|env)-\d{8,}-[A-Za-z0-9]{5,}/,
  /https?:\/\/[a-z0-9-]+\.chatgpt\.site\b/i,
  /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//,
];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const path = resolve(dir, entry.name);
    const name = relative(root, path);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (/^(?:\.env(?:\..*)?|\.dev\.vars.*)$/.test(entry.name) && entry.name !== ".env.example") {
      findings.push(`Credential file must not be published: ${name}`);
      continue;
    }
    if (binary.has(extname(path))) continue;
    const source = await readFile(path, "utf8");
    if (privatePatterns.some((pattern) => pattern.test(source))) {
      // Never print matched contents: they might contain a credential.
      findings.push(`Possible private value in ${name}`);
    }
    if (extname(path) !== ".md") continue;
    for (const match of source.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].replace(/^<|>$/g, "");
      if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("#")) continue;
      const link = decodeURIComponent(target.split(/[?#]/)[0]);
      try {
        await stat(resolve(dirname(path), link));
      } catch {
        findings.push(`Broken relative link in ${name}: ${link}`);
      }
    }
  }
}

await walk(root);
const manifest = JSON.parse(await readFile(resolve(root, ".openai/hosting.json"), "utf8"));
assert.equal(manifest.project_id, undefined, "Public template must not contain a Site project ID");
assert.equal(manifest.d1, "DB");
assert.ok(manifest.capabilities.includes("mcp"));

const media = JSON.parse(await readFile(resolve(root, "assets/media-metadata.json"), "utf8"));
for (const entry of [media.video, media.screenshot]) {
  const data = await readFile(resolve(root, entry.path));
  assert.equal(data.length, entry.bytes, `Media size changed: ${entry.path}`);
  assert.equal(createHash("sha256").update(data).digest("hex"), entry.sha256, `Media hash changed: ${entry.path}`);
}
assert.deepEqual(findings, [], findings.join("\n"));
console.log("Public template, relative links, privacy patterns and original media hashes passed");
