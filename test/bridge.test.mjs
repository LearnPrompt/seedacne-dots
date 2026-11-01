import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker, { summarize } from "../worker/index.js";
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(new URL("../drizzle/0000_jobs.sql", import.meta.url), "utf8"),
  );
  return {
    ARK_API_KEY: "secret-test-only",
    ARK_AGENT_ID: "agent-fixed",
    ARK_ENVIRONMENT_ID: "env-fixed",
    GENERATION_ENABLED: "true",
    DB: {
      prepare(sql) {
        let values = [];
        return {
          bind(...v) {
            values = v;
            return this;
          },
          async first() {
            return db.prepare(sql).get(...values) || null;
          },
          async run() {
            const r = db.prepare(sql).run(...values);
            return { meta: { changes: r.changes } };
          },
        };
      },
    },
  };
}
async function rpc(env, name, args = {}, owner = "user-a") {
  const r = await worker.fetch(
    new Request("https://test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(owner ? { "oai-authenticated-user-id": owner } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
  );
  const b = await r.json();
  return b.result?.isError
    ? { error: b.result.content[0].text }
    : b.result
      ? JSON.parse(b.result.content[0].text)
      : b;
}
const input = {
  request_id: "request_001",
  prompt: "Create a coffee image",
  output_kind: "image",
};
function mock(fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return () => (globalThis.fetch = original);
}
function defaults(url, init) {
  assert.equal(init.redirect, "manual", "Workers requires manual redirects");
  if (url.endsWith("/sessions")) return Response.json({ id: "sesn-test" });
  if (url.endsWith("/events/stream"))
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(": ready\n\n"));
        },
      }),
    );
  if (url.endsWith("/events") && init.method === "POST")
    return Response.json({ data: [{ id: "evt-test" }] });
  throw new Error("Unexpected request");
}
test("private routes reject missing identity", async () => {
  const r = await worker.fetch(new Request("https://test/api/status"), setup());
  assert.equal(r.status, 401);
});
test("configuration never exposes the key", async () => {
  const env = setup();
  const r = await rpc(env, "seedance_connection_status");
  assert.equal(r.configured, true);
  assert.equal(JSON.stringify(r).includes(env.ARK_API_KEY), false);
  const missing = await rpc({}, "seedance_connection_status");
  assert.equal(missing.configured, false);
});
test("generation disabled before any remote request", async () => {
  const env = setup();
  env.GENERATION_ENABLED = "false";
  let calls = 0;
  const restore = mock(() => {
    calls++;
    throw Error();
  });
  try {
    assert.match(
      (await rpc(env, "seedance_create_task", input)).error,
      /尚未启用/,
    );
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});
test("remote verification is read-only and pinned to configured resources", async () => {
  const calls = [];
  const restore = mock(async (url, init) => {
    assert.equal(init.redirect, "manual");
    calls.push([url, init.method]);
    return Response.json(
      url.includes("/agents/")
        ? { base_agent: "ultra_vision_agent_preview", name: "DotsSeedance" }
        : { name: "dots-env" },
    );
  });
  try {
    const r = await rpc(setup(), "seedance_connection_status", {
      verify_remote: true,
    });
    assert.equal(r.remote_verified, true);
    assert.equal(calls.length, 2);
    assert.ok(
      calls.every(
        ([u, m]) =>
          u.startsWith("https://ark.cn-beijing.volces.com/api/v3/") && !m,
      ),
    );
  } finally {
    restore();
  }
});
test("concurrent duplicate requests create and submit once", async () => {
  const env = setup();
  const calls = [];
  const restore = mock(async (u, i) => {
    calls.push([u, i]);
    return defaults(u, i);
  });
  try {
    const a = await Promise.all([
      rpc(env, "seedance_create_task", input),
      rpc(env, "seedance_create_task", input),
    ]);
    assert.equal(calls.filter(([u]) => u.endsWith("/sessions")).length, 1);
    assert.equal(
      calls.filter(([u, i]) => u.endsWith("/events") && i.method === "POST")
        .length,
      1,
    );
    assert.ok(a.some((x) => x.reused));
    assert.ok(a.some((x) => x.phase === "submitted"));
    const again = await rpc(env, "seedance_create_task", input);
    assert.equal(again.reused, true);
  } finally {
    restore();
  }
});
test("ambiguous submission failure remains reserved and cannot automatically resubmit", async () => {
  const env = setup();
  let writes = 0;
  const restore = mock(async (u, i) => {
    if (u.endsWith("/events") && i.method === "POST") {
      writes++;
      throw new Error("network secret-test-only");
    }
    return defaults(u, i);
  });
  try {
    const first = await rpc(env, "seedance_create_task", input);
    assert.match(first.error, /需核验/);
    assert.ok(!first.error.includes(env.ARK_API_KEY));
    const again = await rpc(env, "seedance_create_task", input);
    assert.equal(again.phase, "needs_review");
    assert.equal(writes, 1);
  } finally {
    restore();
  }
});
test("request identifier cannot be repurposed for another prompt", async () => {
  const env = setup();
  const restore = mock(async (u, i) => defaults(u, i));
  try {
    await rpc(env, "seedance_create_task", input);
    assert.match(
      (
        await rpc(env, "seedance_create_task", {
          ...input,
          prompt: "different",
        })
      ).error,
      /另一需求/,
    );
  } finally {
    restore();
  }
});
test("one user cannot query another user task", async () => {
  const env = setup();
  const restore = mock(async (u, i) => defaults(u, i));
  try {
    await rpc(env, "seedance_create_task", input);
    assert.match(
      (
        await rpc(
          env,
          "seedance_get_task",
          { request_id: input.request_id },
          "user-b",
        )
      ).error,
      /未找到/,
    );
  } finally {
    restore();
  }
});
test("idle requiring action is not reported as completed", () => {
  const s = summarize([
    { type: "session.status_idle", stop_reason: { type: "requires_action" } },
    { type: "agent.tool_result", is_error: true, tool_use_id: "t1" },
  ]);
  assert.equal(s.turn_completed, false);
  assert.equal(s.requires_action, true);
  assert.equal(s.tool_errors.length, 1);
  assert.equal(
    summarize([
      { type: "session.status_idle", stop_reason: { type: "end_turn" } },
    ]).turn_completed,
    true,
  );
});
test("output discovery returns only actual registered media", async () => {
  const env = setup();
  let output = false;
  const restore = mock(async (u, i) => {
    if (u.includes("/files?"))
      return Response.json({
        data: output
          ? [
              {
                id: "f1",
                filename: "done.jpg",
                mime_type: "image/jpeg",
                download_url: "https://example.com/temporary",
              },
              { id: "f2", filename: "notes.txt", mime_type: "text/plain" },
            ]
          : [],
      });
    return defaults(u, i);
  });
  try {
    await rpc(env, "seedance_create_task", input);
    assert.deepEqual(
      (await rpc(env, "seedance_get_outputs", { request_id: input.request_id }))
        .files,
      [],
    );
    output = true;
    const r = await rpc(env, "seedance_get_outputs", {
      request_id: input.request_id,
    });
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0].filename, "done.jpg");
  } finally {
    restore();
  }
});
test("output discovery follows the official has_more cursor", async () => {
  const env = setup();
  const pages = [];
  const restore = mock(async (u, i) => {
    if (u.includes("/files?")) {
      const after = new URL(u).searchParams.get("after");
      pages.push(after);
      return Response.json(
        after
          ? {
              data: [
                {
                  id: "f2",
                  filename: "second.mp4",
                  mime_type: "video/mp4",
                  status: "active",
                  download_url: "https://example.com/second",
                },
              ],
              last_id: "f2",
              has_more: false,
            }
          : {
              data: [
                {
                  id: "f1",
                  filename: "first.jpg",
                  mime_type: "image/jpeg",
                  status: "active",
                  download_url: "https://example.com/first",
                },
              ],
              last_id: "f1",
              has_more: true,
            },
      );
    }
    return defaults(u, i);
  });
  try {
    await rpc(env, "seedance_create_task", input);
    const r = await rpc(env, "seedance_get_outputs", {
      request_id: input.request_id,
    });
    assert.deepEqual(pages, [null, "f1"]);
    assert.deepEqual(
      r.files.map((x) => x.id),
      ["f1", "f2"],
    );
  } finally {
    restore();
  }
});
test("unfinished or undownloadable media is reported, not delivered", async () => {
  const env = setup();
  const restore = mock(async (u, i) => {
    if (u.includes("/files?"))
      return Response.json({
        data: [
          {
            id: "f1",
            filename: "done.mp4",
            mime_type: "video/mp4",
            status: "active",
            download_url: "https://example.com/done",
          },
          {
            id: "f2",
            filename: "pending.mp4",
            mime_type: "video/mp4",
            status: "processing",
          },
          {
            id: "f3",
            filename: "broken.mp4",
            mime_type: "video/mp4",
            status: "failed",
            download_url: "https://example.com/broken",
          },
        ],
        has_more: false,
      });
    return defaults(u, i);
  });
  try {
    await rpc(env, "seedance_create_task", input);
    const r = await rpc(env, "seedance_get_outputs", {
      request_id: input.request_id,
    });
    assert.deepEqual(
      r.files.map((x) => x.id),
      ["f1"],
    );
    assert.deepEqual(r.not_ready, [
      { id: "f2", filename: "pending.mp4", status: "processing" },
      { id: "f3", filename: "broken.mp4", status: "failed" },
    ]);
  } finally {
    restore();
  }
});
test("body limit admits the declared maximum prompt in Chinese", async () => {
  const env = setup();
  env.GENERATION_ENABLED = "false";
  const post = (prompt) => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "seedance_create_task",
        arguments: { ...input, prompt, output_kind: "video" },
      },
    });
    return worker.fetch(
      new Request("https://test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(new TextEncoder().encode(body).length),
          "oai-authenticated-user-id": "user-a",
        },
        body,
      }),
      env,
    );
  };
  const atLimit = await post("奶".repeat(12000));
  assert.equal(atLimit.status, 200);
  assert.match((await atLimit.json()).result.content[0].text, /尚未启用/);
  assert.equal((await post("奶".repeat(14000))).status, 413);
});
