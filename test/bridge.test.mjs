import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker, { summarize } from "../worker/index.js";
function setup() {
  const db = new DatabaseSync(":memory:");
  for (const migration of readdirSync(new URL("../drizzle/", import.meta.url))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort()) {
    db.exec(
      readFileSync(new URL(`../drizzle/${migration}`, import.meta.url), "utf8"),
    );
  }
  return {
    ARK_API_KEY: "secret-test-only",
    ARK_AGENT_ID: "agent-fixed",
    ARK_ENVIRONMENT_ID: "env-fixed",
    GENERATION_ENABLED: "true",
    __db: db,
    DB: {
      async batch(statements) {
        db.exec("BEGIN");
        try {
          const result = statements.map((statement) => statement.__execute());
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
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
          async all() {
            return { results: db.prepare(sql).all(...values), success: true };
          },
          __execute() {
            const statement = db.prepare(sql);
            if (statement.columns().length) {
              return { results: statement.all(...values), success: true };
            }
            const r = statement.run(...values);
            return {
              success: true,
              meta: {
                changes: Number(r.changes),
                last_row_id: Number(r.lastInsertRowid),
              },
            };
          },
          async run() {
            return this.__execute();
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
    return Response.json({
      data: [{ id: "sevt-user-1", type: "user.message" }],
    });
  if (
    url.includes("/events?") ||
    (url.endsWith("/events") && init.method !== "POST")
  )
    return Response.json({ data: [] });
  if (url.includes("/files?"))
    return Response.json({ data: [], has_more: false });
  if (/\/sessions\/[^/]+$/.test(url))
    return Response.json({ id: "sesn-test", status: "idle" });
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
                filename: `${input.request_id}/${input.request_id}/done.jpg`,
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
    assert.equal(
      r.files[0].filename,
      `${input.request_id}/${input.request_id}/done.jpg`,
    );
  } finally {
    restore();
  }
});

const referencePng = readFileSync(
  new URL("./fixtures/reference.png", import.meta.url),
);
const fileInput = (
  fileId = "file-dots-001",
  url = "https://files.oaiusercontent.com/reference.png?sig=example-not-a-secret",
) => ({
  file_id: fileId,
  download_url: url,
  mime_type: "image/png",
  file_name: "reference.png",
});
const referenceInput = (referenceId = "reference_001", file = fileInput()) => ({
  reference_id: referenceId,
  file,
});
const withReferences = () => ({
  ...setup(),
  REFERENCE_ALLOWED_HOSTS: "files.oaiusercontent.com",
});
const header = (init, key) => new Headers(init.headers || {}).get(key);

// Stateful upstream model. No network call can escape this mock.
function backend() {
  const state = {
    calls: [],
    uploads: [],
    sends: [],
    sessions: [],
    resources: [],
    history: [],
    files: [],
    status: "idle",
    failSend: false,
    failUpload: false,
    download: () =>
      new Response(referencePng, { headers: { "content-type": "image/png" } }),
  };
  state.fetch = async (rawUrl, init = {}) => {
    const url = new URL(String(rawUrl));
    state.calls.push({ url: String(url), init });
    if (url.hostname !== "ark.cn-beijing.volces.com") {
      assert.equal(init.redirect, "manual");
      assert.equal(
        header(init, "authorization"),
        null,
        "Never send the Ark bearer to attachment storage",
      );
      assert.ok(
        init.signal instanceof AbortSignal,
        "Attachment downloads must have an abort signal",
      );
      return state.download(url, init);
    }
    assert.equal(init.redirect, "manual");
    if (url.pathname === "/api/v3/files" && init.method === "POST") {
      state.uploads.push(init);
      if (state.failUpload)
        throw new Error("uncertain upstream upload secret-test-only");
      return Response.json({
        id: `file-upload-${state.uploads.length}`,
        purpose: "agent",
        status: "active",
        filename: "reference.png",
        mime_type: "image/png",
        bytes: referencePng.length,
      });
    }
    if (url.pathname.startsWith("/api/v3/files/"))
      return Response.json({
        id: url.pathname.split("/").at(-1),
        purpose: "agent",
        status: "active",
        filename: "reference.png",
        mime_type: "image/png",
        bytes: referencePng.length,
      });
    if (url.pathname === "/api/v3/files")
      return Response.json({ data: state.files, has_more: false });
    if (url.pathname === "/api/v3/sessions" && init.method === "POST") {
      const body = JSON.parse(init.body);
      state.sessions.push(body);
      return Response.json({
        id: `sesn-${state.sessions.length}`,
        status: "idle",
        resources: [],
      });
    }
    if (url.pathname.endsWith("/resources") && init.method === "POST") {
      const body = JSON.parse(init.body);
      const resource = {
        id: `sesrsc-${state.resources.length + 1}`,
        type: "file",
        file_id: `file-mounted-${state.resources.length + 1}`,
        access: "read_only",
        mount_path: `/mnt/session/uploads/${body.mount_path || "reference.png"}`,
      };
      state.resources.push({ ...resource, request: body, url: String(url) });
      return Response.json(resource);
    }
    if (url.pathname.endsWith("/resources"))
      return Response.json({ data: state.resources });
    if (url.pathname.endsWith("/events/stream"))
      return defaults(String(url), init);
    if (url.pathname.endsWith("/events") && init.method === "POST") {
      const body = JSON.parse(init.body);
      const message = {
        ...body.events[0],
        id: `sevt-user-${state.sends.length + 1}`,
        processed_at: new Date().toISOString(),
      };
      state.sends.push({ url: String(url), body, message });
      state.history.push(message);
      state.status = "running";
      if (state.failSend) throw new Error("uncertain send secret-test-only");
      return Response.json({ data: [message] });
    }
    if (url.pathname.endsWith("/events"))
      return Response.json({ data: state.history });
    if (/\/sessions\/[^/]+$/.test(url.pathname))
      return Response.json({
        id: url.pathname.split("/").at(-1),
        status: state.status,
      });
    throw new Error(`Unexpected mocked endpoint: ${url.pathname}`);
  };
  state.complete = (text = "Current turn reply", extra = []) => {
    state.history.push(
      ...extra,
      {
        id: `sevt-reply-${state.sends.length}`,
        type: "agent.message",
        content: [{ type: "text", text }],
      },
      {
        id: `sevt-idle-${state.sends.length}`,
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
      },
    );
    state.status = "idle";
  };
  return state;
}

async function toolList(env) {
  const response = await worker.fetch(
    new Request("https://test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "oai-authenticated-user-id": "user-a",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    }),
    env,
  );
  return (await response.json()).result.tools;
}

test("reference upload declares the OpenAI file parameter contract", async () => {
  const tools = await toolList(setup());
  const upload = tools.find(
    (tool) => tool.name === "seedance_upload_reference",
  );
  assert.ok(upload, "Expose the upload operation to Dots");
  assert.deepEqual(upload._meta?.["openai/fileParams"], ["file"]);
  const schema = upload.inputSchema.properties.file;
  assert.equal(schema.type, "object");
  assert.deepEqual([...schema.required].sort(), ["download_url", "file_id"]);
  assert.equal(schema.properties.download_url.type, "string");
  assert.equal(schema.properties.file_id.type, "string");
  assert.ok(
    !schema.required.includes("mime_type") &&
      !schema.required.includes("file_name"),
  );
});

test("reference upload forwards validated bytes as purpose=agent and never forwards Ark auth to storage", async () => {
  const env = withReferences();
  const upstream = backend();
  const restore = mock(upstream.fetch);
  try {
    const result = await rpc(
      env,
      "seedance_upload_reference",
      referenceInput(),
    );
    assert.equal(result.error, undefined);
    assert.equal(upstream.uploads.length, 1);
    const form = upstream.uploads[0].body;
    assert.ok(form instanceof FormData);
    assert.equal(form.get("purpose"), "agent");
    assert.deepEqual(
      Buffer.from(await form.get("file").arrayBuffer()),
      referencePng,
    );
    assert.equal(form.get("file").type, "image/png");
    const rows = env.__db.prepare("SELECT * FROM reference_uploads").all();
    assert.ok(
      !JSON.stringify(rows).includes("sig=example"),
      "Do not persist temporary signed download URLs",
    );
    assert.ok(!JSON.stringify(result).includes(env.ARK_API_KEY));
  } finally {
    restore();
  }
});

test("reference ownership is enforced for reading and task attachment", async () => {
  const env = withReferences();
  const upstream = backend();
  const restore = mock(upstream.fetch);
  try {
    await rpc(env, "seedance_upload_reference", referenceInput());
    const before = upstream.calls.length;
    assert.ok(
      (
        await rpc(
          env,
          "seedance_get_reference",
          { reference_id: "reference_001" },
          "user-b",
        )
      ).error,
    );
    assert.ok(
      (
        await rpc(
          env,
          "seedance_create_task",
          { ...input, reference_ids: ["reference_001"] },
          "user-b",
        )
      ).error,
    );
    assert.equal(upstream.sends.length, 0);
    assert.equal(
      upstream.calls.length,
      before,
      "Reject cross-user references before contacting upstream",
    );
  } finally {
    restore();
  }
});

test("stable reference upload is idempotent across refreshed attachment URLs", async () => {
  const env = withReferences();
  const upstream = backend();
  const restore = mock(upstream.fetch);
  try {
    const first = await rpc(env, "seedance_upload_reference", referenceInput());
    assert.equal(first.error, undefined);
    const again = await rpc(
      env,
      "seedance_upload_reference",
      referenceInput(
        "reference_001",
        fileInput(
          "file-dots-001",
          "https://files.oaiusercontent.com/reference.png?sig=refreshed",
        ),
      ),
    );
    assert.equal(again.error, undefined);
    assert.equal(again.reused, true);
    assert.equal(upstream.uploads.length, 1);
    upstream.download = () =>
      new Response(
        readFileSync(new URL("./fixtures/reference-red.png", import.meta.url)),
        { headers: { "content-type": "image/png" } },
      );
    const conflict = await rpc(
      env,
      "seedance_upload_reference",
      referenceInput("reference_001", fileInput("file-dots-different")),
    );
    assert.ok(
      conflict.error,
      "Stable reference ID cannot silently bind different image bytes",
    );
    assert.equal(upstream.uploads.length, 1);
  } finally {
    restore();
  }
});

test("ambiguous reference upload failure is reserved and cannot automatically POST again", async () => {
  const env = withReferences();
  const upstream = backend();
  upstream.failUpload = true;
  const restore = mock(upstream.fetch);
  try {
    const first = await rpc(env, "seedance_upload_reference", referenceInput());
    assert.ok(first.error);
    const again = await rpc(env, "seedance_upload_reference", referenceInput());
    assert.equal(upstream.uploads.length, 1);
    assert.ok(again.error || again.phase === "needs_review");
    assert.ok(!JSON.stringify([first, again]).includes(env.ARK_API_KEY));
  } finally {
    restore();
  }
});

test("attachment source host allowlist is exact and rejects credentials and non-HTTPS URLs", async () => {
  for (const source of [
    "https://files.oaiusercontent.com.evil.example/reference.png",
    "https://evil.example/reference.png",
    "http://files.oaiusercontent.com/reference.png",
    "https://username:password@files.oaiusercontent.com/reference.png",
    "https://127.0.0.1/reference.png",
  ]) {
    const env = withReferences();
    const upstream = backend();
    const restore = mock(upstream.fetch);
    try {
      assert.ok(
        (
          await rpc(
            env,
            "seedance_upload_reference",
            referenceInput("reference_001", fileInput("file-dots-001", source)),
          )
        ).error,
        source,
      );
      assert.equal(upstream.calls.length, 0);
    } finally {
      restore();
    }
  }
});

test("missing attachment host configuration fails closed", async () => {
  const upstream = backend();
  const restore = mock(upstream.fetch);
  try {
    assert.ok(
      (await rpc(setup(), "seedance_upload_reference", referenceInput())).error,
    );
    assert.equal(upstream.calls.length, 0);
  } finally {
    restore();
  }
});

test("attachment redirect is rejected instead of followed", async () => {
  const env = withReferences();
  const upstream = backend();
  upstream.download = () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://evil.example/reference.png" },
    });
  const restore = mock(upstream.fetch);
  try {
    assert.ok(
      (await rpc(env, "seedance_upload_reference", referenceInput())).error,
    );
    assert.equal(upstream.uploads.length, 0);
    assert.equal(upstream.calls.length, 1);
  } finally {
    restore();
  }
});

test("reference MIME and magic validation rejects unsupported or mislabeled files", async () => {
  for (const [mime, bytes, claimedMime] of [
    ["image/svg+xml", Buffer.from("<svg/>"), "image/svg+xml"],
    ["image/png", Buffer.from("not an image"), "image/png"],
    ["image/jpeg", referencePng, "image/jpeg"],
    ["image/png", referencePng, "image/jpeg"],
  ]) {
    const env = withReferences();
    const upstream = backend();
    upstream.download = () =>
      new Response(bytes, { headers: { "content-type": mime } });
    const restore = mock(upstream.fetch);
    try {
      assert.ok(
        (
          await rpc(
            env,
            "seedance_upload_reference",
            referenceInput("reference_001", {
              ...fileInput(),
              mime_type: claimedMime,
            }),
          )
        ).error,
      );
      assert.equal(upstream.uploads.length, 0);
    } finally {
      restore();
    }
  }
});

test("attachment 10 MiB limit is enforced from both headers and streaming bytes", async () => {
  for (const declareSize of [true, false]) {
    const env = withReferences();
    const upstream = backend();
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
    referencePng.copy(oversized);
    upstream.download = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(oversized);
            controller.close();
          },
        }),
        {
          headers: {
            "content-type": "image/png",
            ...(declareSize
              ? { "content-length": String(oversized.length) }
              : {}),
          },
        },
      );
    const restore = mock(upstream.fetch);
    try {
      assert.ok(
        (await rpc(env, "seedance_upload_reference", referenceInput())).error,
      );
      assert.equal(upstream.uploads.length, 0);
    } finally {
      restore();
    }
  }
});

test("attachment download timeout does not reach Ark or leak source URLs", async () => {
  const env = withReferences();
  const upstream = backend();
  upstream.download = () => {
    throw new DOMException(
      "download secret-test-only sig=example-not-a-secret",
      "TimeoutError",
    );
  };
  const restore = mock(upstream.fetch);
  try {
    const result = await rpc(
      env,
      "seedance_upload_reference",
      referenceInput(),
    );
    assert.ok(result.error);
    assert.equal(upstream.uploads.length, 0);
    assert.ok(
      !JSON.stringify(result).includes("sig=example") &&
        !JSON.stringify(result).includes(env.ARK_API_KEY),
    );
  } finally {
    restore();
  }
});

const modification = (
  turnId = "modify_001",
  prompt = "Change the cup color to blue",
) => ({ ...input, turn_id: turnId, prompt });
const mediaFile = (id, filename = `${id}.png`) => ({
  id,
  filename,
  mime_type: "image/png",
  status: "active",
  created_at: 1234,
  download_url: `https://example.com/${id}`,
});

test("concurrent identical reference uploads perform one upstream upload", async () => {
  const env = withReferences();
  const upstream = backend();
  const restore = mock(upstream.fetch);
  try {
    const results = await Promise.all([
      rpc(env, "seedance_upload_reference", referenceInput()),
      rpc(env, "seedance_upload_reference", referenceInput()),
    ]);
    assert.equal(upstream.uploads.length, 1);
    assert.ok(results.some((item) => item.reused));
    assert.ok(results.some((item) => item.phase === "ready"));
  } finally {
    restore();
  }
});

test("reference dimensions must be nonzero before an upstream upload", async () => {
  const env = withReferences();
  const upstream = backend();
  const malformed = Buffer.from(referencePng);
  malformed.writeUInt32BE(0, 16);
  upstream.download = () =>
    new Response(malformed, { headers: { "content-type": "image/png" } });
  const restore = mock(upstream.fetch);
  try {
    assert.ok(
      (await rpc(env, "seedance_upload_reference", referenceInput())).error,
    );
    assert.equal(upstream.uploads.length, 0);
  } finally {
    restore();
  }
});

test("task references are mounted and image content uses the returned session file ID", async () => {
  const env = withReferences();
  const upstream = backend();
  const restore = mock(upstream.fetch);
  try {
    await rpc(env, "seedance_upload_reference", referenceInput());
    const result = await rpc(env, "seedance_create_task", {
      ...input,
      reference_ids: ["reference_001"],
    });
    assert.equal(result.error, undefined);
    assert.equal(result.turn_id, input.request_id);
    assert.equal(upstream.resources.length, 1);
    assert.equal(upstream.resources[0].request.type, "file");
    assert.equal(upstream.resources[0].request.file_id, "file-upload-1");
    const message = upstream.sends[0].body.events[0];
    assert.equal(message.type, "user.message");
    assert.deepEqual(
      message.content.filter((part) => part.type === "image"),
      [{ type: "image", source: { type: "file", file_id: "file-mounted-1" } }],
    );
    assert.ok(
      message.content.some(
        (part) =>
          part.type === "text" &&
          part.text.includes(upstream.resources[0].mount_path),
      ),
    );
  } finally {
    restore();
  }
});

test("same-session continuation reuses mounted references without mounting them again", async () => {
  const env = withReferences();
  const upstream = backend();
  const restore = mock(upstream.fetch);
  try {
    await rpc(env, "seedance_upload_reference", referenceInput());
    await rpc(env, "seedance_create_task", {
      ...input,
      reference_ids: ["reference_001"],
    });
    upstream.complete();
    const continued = await rpc(env, "seedance_continue_task", {
      ...modification(),
      reference_ids: ["reference_001"],
    });
    assert.equal(continued.phase, "submitted");
    assert.equal(upstream.sessions.length, 1);
    assert.equal(upstream.resources.length, 1);
    assert.equal(upstream.sends[1].url, upstream.sends[0].url);
    assert.deepEqual(
      upstream.sends[1].message.content.filter((part) => part.type === "image"),
      [{ type: "image", source: { type: "file", file_id: "file-mounted-1" } }],
    );
  } finally {
    restore();
  }
});

test("stable continuation turn ID prevents duplicate sends and rejects changed requirements", async () => {
  const env = setup();
  const upstream = backend();
  const restore = mock(upstream.fetch);
  try {
    await rpc(env, "seedance_create_task", input);
    upstream.complete();
    const first = await rpc(env, "seedance_continue_task", modification());
    assert.equal(first.phase, "submitted");
    assert.equal(first.turn_id, "modify_001");
    const repeated = await rpc(env, "seedance_continue_task", modification());
    assert.equal(repeated.reused, true);
    assert.equal(upstream.sends.length, 2);
    assert.equal(upstream.sessions.length, 1);
    const changed = await rpc(
      env,
      "seedance_continue_task",
      modification("modify_001", "Another change"),
    );
    assert.ok(changed.error);
    assert.equal(upstream.sends.length, 2);
    assert.ok(
      (await rpc(env, "seedance_continue_task", modification(input.request_id)))
        .error,
      "The initial turn ID cannot be overwritten",
    );
  } finally {
    restore();
  }
});

test("another user cannot continue or inspect a task turn", async () => {
  const env = setup();
  const upstream = backend();
  const restore = mock(upstream.fetch);
  try {
    await rpc(env, "seedance_create_task", input);
    upstream.complete();
    const before = upstream.calls.length;
    assert.ok(
      (await rpc(env, "seedance_continue_task", modification(), "user-b"))
        .error,
    );
    assert.ok(
      (
        await rpc(
          env,
          "seedance_get_task",
          { request_id: input.request_id, turn_id: input.request_id },
          "user-b",
        )
      ).error,
    );
    assert.ok(
      (
        await rpc(
          env,
          "seedance_get_outputs",
          { request_id: input.request_id, turn_id: input.request_id },
          "user-b",
        )
      ).error,
    );
    assert.equal(upstream.calls.length, before);
  } finally {
    restore();
  }
});

test("concurrent different modification turns cannot both submit", async () => {
  const env = setup();
  const upstream = backend();
  const restore = mock(upstream.fetch);
  try {
    await rpc(env, "seedance_create_task", input);
    upstream.complete();
    const results = await Promise.all([
      rpc(env, "seedance_continue_task", modification("modify_001")),
      rpc(
        env,
        "seedance_continue_task",
        modification("modify_002", "Another modification"),
      ),
    ]);
    assert.equal(
      upstream.sends.length,
      2,
      "One initial message plus at most one modification",
    );
    assert.equal(
      results.filter((result) => result.phase === "submitted").length,
      1,
    );
    assert.equal(results.filter((result) => result.error).length, 1);
    assert.equal(upstream.sessions.length, 1);
  } finally {
    restore();
  }
});

test("running, requires_action and terminated sessions refuse a new turn", async () => {
  for (const [status, stopReason] of [
    ["running", "end_turn"],
    ["idle", "requires_action"],
    ["terminated", "end_turn"],
  ]) {
    const env = setup();
    const upstream = backend();
    const restore = mock(upstream.fetch);
    try {
      await rpc(env, "seedance_create_task", input);
      upstream.history.push({
        id: "sevt-stop",
        type: "session.status_idle",
        stop_reason: { type: stopReason, event_ids: ["sevt-tool"] },
      });
      upstream.status = status;
      assert.ok(
        (await rpc(env, "seedance_continue_task", modification())).error,
        `${status}/${stopReason}`,
      );
      assert.equal(upstream.sends.length, 1);
    } finally {
      restore();
    }
  }
});

test("a new turn does not inherit the old end_turn, old tool errors or old reply", async () => {
  const env = setup();
  const upstream = backend();
  const restore = mock(upstream.fetch);
  try {
    await rpc(env, "seedance_create_task", input);
    upstream.complete("Reply from the previous turn", [
      {
        id: "sevt-old-error",
        type: "agent.tool_result",
        is_error: true,
        tool_use_id: "old-tool",
      },
    ]);
    await rpc(env, "seedance_continue_task", modification());
    const current = await rpc(env, "seedance_get_task", {
      request_id: input.request_id,
    });
    assert.equal(current.turn_id, "modify_001");
    assert.equal(current.turn_completed, false);
    assert.deepEqual(current.tool_errors, []);
    assert.ok(
      !JSON.stringify(current).includes("Reply from the previous turn"),
    );
    upstream.complete("Reply from the current turn");
    const done = await rpc(env, "seedance_get_task", {
      request_id: input.request_id,
    });
    assert.equal(done.turn_completed, true);
    assert.ok(JSON.stringify(done).includes("Reply from the current turn"));
    assert.ok(!JSON.stringify(done).includes("Reply from the previous turn"));
  } finally {
    restore();
  }
});

test("ambiguous continuation is not sent again and can be reconciled from event history", async () => {
  const env = setup();
  const upstream = backend();
  const restore = mock(upstream.fetch);
  try {
    await rpc(env, "seedance_create_task", input);
    upstream.complete();
    upstream.failSend = true;
    const uncertain = await rpc(env, "seedance_continue_task", modification());
    assert.ok(uncertain.error);
    const again = await rpc(env, "seedance_continue_task", modification());
    assert.equal(again.reused, true);
    assert.equal(again.phase, "needs_review");
    assert.equal(upstream.sends.length, 2);
    upstream.complete("The accepted modification finished");
    const current = await rpc(env, "seedance_get_task", {
      request_id: input.request_id,
    });
    assert.equal(
      current.turn_completed,
      true,
      "Lost ACK can be reconciled with the recorded message content",
    );
    assert.equal(upstream.sends.length, 2);
  } finally {
    restore();
  }
});

test("latest-turn outputs exclude previous media and earlier turn queries exclude later media", async () => {
  const env = setup();
  const upstream = backend();
  const restore = mock(upstream.fetch);
  try {
    await rpc(env, "seedance_create_task", input);
    upstream.complete();
    const old = mediaFile(
      "file-output-old",
      `${input.request_id}/${input.request_id}/old.png`,
    );
    upstream.files = [old];
    assert.deepEqual(
      (
        await rpc(env, "seedance_get_outputs", { request_id: input.request_id })
      ).files.map((file) => file.id),
      [old.id],
    );
    await rpc(env, "seedance_continue_task", modification());
    const pending = await rpc(env, "seedance_get_outputs", {
      request_id: input.request_id,
    });
    assert.equal(pending.turn_id, "modify_001");
    assert.deepEqual(pending.files, []);
    const fresh = mediaFile(
      "file-output-new",
      `${input.request_id}/modify_001/new.png`,
    );
    upstream.files = [old, fresh];
    upstream.complete();
    assert.deepEqual(
      (
        await rpc(env, "seedance_get_outputs", { request_id: input.request_id })
      ).files.map((file) => file.id),
      [fresh.id],
    );
    assert.deepEqual(
      (
        await rpc(env, "seedance_get_outputs", {
          request_id: input.request_id,
          turn_id: input.request_id,
        })
      ).files.map((file) => file.id),
      [old.id],
    );
  } finally {
    restore();
  }
});

test("Files pagination follows after/has_more and preserves every registered media file", async () => {
  const env = setup();
  const upstream = backend();
  let output = false;
  const pages = [];
  const fetch = async (rawUrl, init) => {
    const url = new URL(String(rawUrl));
    if (
      url.pathname === "/api/v3/files" &&
      (!init.method || init.method === "GET") &&
      output
    ) {
      pages.push(url.searchParams);
      assert.equal(url.searchParams.get("purpose"), "agent");
      assert.equal(url.searchParams.get("scope_id"), "sesn-1");
      assert.equal(url.searchParams.has("page"), false);
      if (!url.searchParams.has("after"))
        return Response.json({
          data: [
            mediaFile(
              "output-one",
              `${input.request_id}/${input.request_id}/one.png`,
            ),
          ],
          has_more: true,
          last_id: "output-one",
        });
      assert.equal(url.searchParams.get("after"), "output-one");
      return Response.json({
        data: [
          mediaFile(
            "output-two",
            `${input.request_id}/${input.request_id}/two.png`,
          ),
        ],
        has_more: false,
        last_id: "output-two",
      });
    }
    return upstream.fetch(rawUrl, init);
  };
  const restore = mock(fetch);
  try {
    await rpc(env, "seedance_create_task", input);
    output = true;
    const result = await rpc(env, "seedance_get_outputs", {
      request_id: input.request_id,
    });
    assert.deepEqual(
      result.files.map((file) => file.id),
      ["output-one", "output-two"],
    );
    assert.equal(pages.length, 2);
  } finally {
    restore();
  }
});

test("v0.1 jobs without turn records remain readable and can continue in the original session", async () => {
  const env = setup();
  const upstream = backend();
  env.__db
    .prepare(
      "INSERT INTO jobs (owner, request_key, prompt_hash, phase, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      "user-a",
      "legacy_001",
      "legacy-prompt-hash",
      "submitted",
      "sesn-legacy",
      1,
    );
  upstream.history = [
    {
      id: "sevt-legacy-user",
      type: "user.message",
      content: [{ type: "text", text: "Old task" }],
    },
    {
      id: "sevt-legacy-reply",
      type: "agent.message",
      content: [{ type: "text", text: "Legacy reply" }],
    },
    {
      id: "sevt-legacy-idle",
      type: "session.status_idle",
      stop_reason: { type: "end_turn" },
    },
  ];
  upstream.files = [mediaFile("legacy-output")];
  const restore = mock(upstream.fetch);
  try {
    const task = await rpc(env, "seedance_get_task", {
      request_id: "legacy_001",
    });
    assert.equal(task.error, undefined);
    assert.equal(task.session_id, "sesn-legacy");
    const files = await rpc(env, "seedance_get_outputs", {
      request_id: "legacy_001",
    });
    assert.equal(
      files.legacy_unscoped,
      true,
      "Legacy file attribution must be explicit",
    );
    assert.deepEqual(
      files.files.map((file) => file.id),
      ["legacy-output"],
    );
    const continued = await rpc(env, "seedance_continue_task", {
      ...modification(),
      request_id: "legacy_001",
    });
    assert.equal(continued.phase, "submitted");
    assert.equal(continued.session_id, "sesn-legacy");
    assert.equal(upstream.sessions.length, 0);
    assert.ok(upstream.sends[0].url.includes("/sessions/sesn-legacy/events"));
    const modifiedFile = mediaFile(
      "legacy-modified",
      "legacy_001/modify_001/modified.png",
    );
    upstream.files.push(modifiedFile);
    upstream.complete("Modified legacy task");
    assert.deepEqual(
      (
        await rpc(env, "seedance_get_outputs", { request_id: "legacy_001" })
      ).files.map((file) => file.id),
      [modifiedFile.id],
    );
    const rootOutputs = await rpc(env, "seedance_get_outputs", {
      request_id: "legacy_001",
      turn_id: "legacy_001",
    });
    assert.deepEqual(
      rootOutputs.files.map((file) => file.id),
      ["legacy-output"],
      "The frozen v0.1 root turn must not include later modification files",
    );
    assert.equal(rootOutputs.legacy_unscoped, undefined);
  } finally {
    restore();
  }
});

test("late registration of a prior turn is not claimed by the latest turn", async () => {
  const env = setup();
  const upstream = backend();
  const restore = mock(upstream.fetch);
  try {
    await rpc(env, "seedance_create_task", input);
    upstream.complete();
    await rpc(env, "seedance_continue_task", modification());
    const lateOld = mediaFile(
      "old-registered-late",
      `${input.request_id}/${input.request_id}/late.png`,
    );
    const current = mediaFile(
      "current-registered",
      `${input.request_id}/modify_001/current.png`,
    );
    const unattributed = mediaFile("unattributed", "unknown-name.png");
    upstream.files = [lateOld, current, unattributed];
    const result = await rpc(env, "seedance_get_outputs", {
      request_id: input.request_id,
    });
    assert.deepEqual(
      result.files.map((file) => file.id),
      [current.id],
    );
    assert.equal(
      result.attribution_uncertain,
      true,
      "Unattributed media must be reported rather than silently assigned to the current turn",
    );
    const earlier = await rpc(env, "seedance_get_outputs", {
      request_id: input.request_id,
      turn_id: input.request_id,
    });
    assert.deepEqual(
      earlier.files.map((file) => file.id),
      [lateOld.id],
    );
  } finally {
    restore();
  }
});

test("continuation generation gate rejects before any upstream request", async () => {
  const env = setup();
  const upstream = backend();
  const restore = mock(upstream.fetch);
  try {
    await rpc(env, "seedance_create_task", input);
    upstream.complete();
    const before = upstream.calls.length;
    env.GENERATION_ENABLED = "false";
    assert.ok((await rpc(env, "seedance_continue_task", modification())).error);
    assert.equal(upstream.calls.length, before);
  } finally {
    restore();
  }
});

for (const [extension, mime] of [
  ["jpg", "image/jpeg"],
  ["webp", "image/webp"],
]) {
  test(`valid ${mime} reference uploads preserve the validated format and bytes`, async () => {
    const env = withReferences();
    const upstream = backend();
    const bytes = readFileSync(
      new URL(`./fixtures/reference.${extension}`, import.meta.url),
    );
    upstream.download = () =>
      new Response(bytes, { headers: { "content-type": mime } });
    const restore = mock(upstream.fetch);
    try {
      const file = {
        ...fileInput(),
        mime_type: mime,
        file_name: `reference.${extension}`,
      };
      const result = await rpc(
        env,
        "seedance_upload_reference",
        referenceInput("reference_001", file),
      );
      assert.equal(result.error, undefined);
      assert.equal(result.phase, "ready");
      assert.equal(result.mime_type, mime);
      assert.equal(result.bytes, bytes.length);
      assert.equal(upstream.uploads.length, 1);
      const body = upstream.uploads[0].body;
      assert.equal(body.get("purpose"), "agent");
      assert.equal(body.get("file").type, mime);
      assert.deepEqual(
        Buffer.from(await body.get("file").arrayBuffer()),
        bytes,
      );
    } finally {
      restore();
    }
  });
}

test("MCP accepts a valid 12000-character Chinese prompt under the 64 KiB request budget", async () => {
  const env = setup();
  const upstream = backend();
  const restore = mock(upstream.fetch);
  try {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "seedance_create_task",
        arguments: { ...input, prompt: "茶".repeat(12000) },
      },
    });
    assert.ok(
      Buffer.byteLength(body) > 20000 && Buffer.byteLength(body) < 65536,
    );
    const response = await worker.fetch(
      new Request("https://test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "oai-authenticated-user-id": "user-a",
        },
        body,
      }),
      env,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.ok(!payload.result.isError, JSON.stringify(payload));
    assert.equal(JSON.parse(payload.result.content[0].text).phase, "submitted");
    assert.equal(upstream.sends.length, 1);
  } finally {
    restore();
  }
});

test("MCP rejects UTF-8 bodies over 64 KiB with and without a Content-Length header", async () => {
  for (const includeLength of [true, false]) {
    const env = setup();
    const upstream = backend();
    const restore = mock(upstream.fetch);
    try {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "seedance_create_task",
          arguments: { ...input, prompt: "茶".repeat(22000) },
        },
      });
      assert.ok(Buffer.byteLength(body) > 65536);
      const request = new Request("https://test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "oai-authenticated-user-id": "user-a",
          ...(includeLength
            ? { "content-length": String(Buffer.byteLength(body)) }
            : {}),
        },
        body,
      });
      if (!includeLength)
        assert.equal(request.headers.has("content-length"), false);
      const response = await worker.fetch(request, env);
      assert.equal(response.status, 413);
      assert.equal(upstream.calls.length, 0);
    } finally {
      restore();
    }
  }
});
