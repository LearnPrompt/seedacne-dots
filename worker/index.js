const BASE = "https://ark.cn-beijing.volces.com/api/v3";
const tools = [
  {
    name: "seedance_connection_status",
    description:
      "检查 Seedance 连接配置与固定 Agent/Environment，可选只读验证方舟权限。不生成素材。",
    inputSchema: {
      type: "object",
      properties: { verify_remote: { type: "boolean", default: false } },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "seedance_create_task",
    description:
      "按用户明确授权的创作需求提交一次图片或视频任务，会产生方舟用量费用。request_id 必须稳定；超时后用同一编号查询，禁止换编号重发。",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 8, maxLength: 100 },
        prompt: { type: "string", minLength: 1, maxLength: 12000 },
        output_kind: { type: "string", enum: ["image", "video"] },
      },
      required: ["request_id", "prompt", "output_kind"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "seedance_get_task",
    description:
      "查询本用户任务的方舟状态、完整回复和停止原因；idle 本身不等于创作成功。",
    inputSchema: {
      type: "object",
      properties: { request_id: { type: "string" } },
      required: ["request_id"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "seedance_get_outputs",
    description:
      "查询任务已注册的图片/视频产物，返回临时下载地址。请及时下载；空列表不能当作成功。",
    inputSchema: {
      type: "object",
      properties: { request_id: { type: "string" } },
      required: ["request_id"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
];
class SafeError extends Error {}
const json = (x, status = 200) =>
  Response.json(x, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
const result = (x) => ({
  content: [{ type: "text", text: JSON.stringify(x) }],
});
const required = ["ARK_API_KEY", "ARK_AGENT_ID", "ARK_ENVIRONMENT_ID"];
function check(env) {
  const missing = required.filter((k) => !env[k]);
  if (missing.length)
    throw new SafeError(`缺少服务端配置：${missing.join(", ")}`);
}
async function ark(env, path, options = {}) {
  check(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let response;
  try {
    response = await fetch(BASE + path, {
      ...options,
      signal: controller.signal,
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${env.ARK_API_KEY}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SafeError(
        `方舟请求失败 HTTP ${response.status}，请检查权限/余额/配置。写请求禁止自动重试。`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new SafeError(
        `方舟响应格式异常（HTTP ${response.status}），尚未验证成功。`,
      );
    }
  } catch (e) {
    if (e instanceof SafeError) throw e;
    const kind = ["TypeError", "AbortError", "TimeoutError"].includes(e?.name)
      ? e.name
      : "NetworkError";
    const detail = String(e?.message || "")
      .split(env.ARK_API_KEY)
      .join("[redacted]")
      .slice(0, 180);
    throw new SafeError(`方舟连接失败（${kind}）：${detail}。尚未验证成功。`);
  } finally {
    clearTimeout(timer);
  }
}
function validateId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(value))
    throw new SafeError(
      "request_id 需为 8–100 位英文字母、数字、下划线或短横线。",
    );
  return value;
}
async function digest(text) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
async function job(env, owner, key) {
  if (!env.DB) throw new SafeError("任务存储尚未就绪。");
  const row = await env.DB.prepare(
    "SELECT * FROM jobs WHERE owner = ? AND request_key = ?",
  )
    .bind(owner, validateId(key))
    .first();
  if (!row) throw new SafeError("未找到当前用户的任务。");
  return row;
}
async function history(env, sid) {
  const events = [];
  let page = "";
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({ limit: "200", order: "asc" });
    if (page) q.set("page", page);
    const r = await ark(
      env,
      `/sessions/${encodeURIComponent(sid)}/events?${q}`,
    );
    events.push(...(r.data || []));
    if (!r.next_page) return events;
    page = r.next_page;
  }
  throw new SafeError("事件历史超过本次查询上限，请人工检查，勿重新提交。");
}
function summarize(events) {
  const idle = events.filter((x) => x.type === "session.status_idle").at(-1);
  const stop = idle?.stop_reason?.type || null;
  return {
    stop_reason: stop,
    turn_completed: stop === "end_turn",
    requires_action: stop === "requires_action",
    messages: events
      .filter((x) => x.type === "agent.message")
      .map((x) =>
        (x.content || [])
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n"),
      )
      .slice(-5),
    tool_errors: events
      .filter((x) => x.type === "agent.tool_result" && x.is_error === true)
      .map((x) => ({ tool_use_id: x.tool_use_id, is_error: true })),
    errors: events
      .filter((x) => x.type === "session.error")
      .map((x) => ({
        type: x.error?.type,
        retry_status: x.error?.retry_status?.type,
      })),
  };
}
async function openReady(env, sid) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(
      BASE + `/sessions/${encodeURIComponent(sid)}/events/stream`,
      {
        signal: ctl.signal,
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${env.ARK_API_KEY}`,
          Accept: "text/event-stream",
        },
      },
    );
    if (!r.ok || !r.body)
      throw new SafeError(`无法打开事件流 HTTP ${r.status}`);
    const reader = r.body.getReader();
    let buffer = "";
    const decoder = new TextDecoder();
    while (buffer.length < 65536) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.split(/\r?\n/).some((line) => /^:\s*ready\s*$/.test(line))) {
        clearTimeout(timer);
        return {
          close: () => {
            ctl.abort();
            return reader.cancel().catch(() => {});
          },
        };
      }
    }
    throw new SafeError("事件流未就绪，未发送生成需求。");
  } catch (e) {
    ctl.abort();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
async function call(name, args, env, owner) {
  if (name === "seedance_connection_status") {
    const missing = required.filter((k) => !env[k]);
    const config = {
      configured: !missing.length,
      missing,
      generation_enabled: env.GENERATION_ENABLED === "true",
      agent_id: env.ARK_AGENT_ID || null,
      environment_id: env.ARK_ENVIRONMENT_ID || null,
      storage_configured: !!env.DB,
    };
    if (args.verify_remote) {
      check(env);
      const [a, e] = await Promise.all([
        ark(env, `/agents/${encodeURIComponent(env.ARK_AGENT_ID)}`),
        ark(env, `/environments/${encodeURIComponent(env.ARK_ENVIRONMENT_ID)}`),
      ]);
      config.remote_verified = true;
      config.agent_type = a.base_agent;
      config.agent_name = a.name;
      config.environment_name = e.name;
    }
    return config;
  }
  if (name === "seedance_create_task") {
    check(env);
    if (env.GENERATION_ENABLED !== "true")
      throw new SafeError("生成尚未启用；需先确认付费用量授权。");
    if (!env.DB) throw new SafeError("任务存储尚未就绪。");
    const key = validateId(args.request_id);
    if (
      typeof args.prompt !== "string" ||
      !args.prompt.trim() ||
      args.prompt.length > 12000 ||
      !["image", "video"].includes(args.output_kind)
    )
      throw new SafeError("请提供有效 prompt 和 output_kind。");
    const hash = await digest(args.prompt + "\n" + args.output_kind);
    const insert = await env.DB.prepare(
      "INSERT INTO jobs (owner, request_key, prompt_hash, phase, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner,request_key) DO NOTHING",
    )
      .bind(owner, key, hash, "reserved", Date.now())
      .run();
    if (!insert.meta.changes) {
      const old = await job(env, owner, key);
      if (old.prompt_hash !== hash)
        throw new SafeError("该 request_id 已绑定另一需求；不允许覆盖。");
      return {
        request_id: key,
        session_id: old.session_id,
        phase: old.phase,
        reused: true,
        instruction: "继续查询原任务，不要用新编号重发。",
      };
    }
    let sid = null,
      stream;
    try {
      const s = await ark(env, "/sessions", {
        method: "POST",
        body: JSON.stringify({
          agent: env.ARK_AGENT_ID,
          environment_id: env.ARK_ENVIRONMENT_ID,
          title: `Dots ${key}`,
        }),
      });
      sid = s.id;
      if (typeof sid !== "string" || !sid.startsWith("sesn-"))
        throw new SafeError("Session 创建结果缺少有效 ID，需人工核验。");
      await env.DB.prepare(
        "UPDATE jobs SET session_id = ?, phase = ? WHERE owner = ? AND request_key = ?",
      )
        .bind(sid, "session_created", owner, key)
        .run();
      stream = await openReady(env, sid);
      await env.DB.prepare(
        "UPDATE jobs SET phase = ? WHERE owner = ? AND request_key = ?",
      )
        .bind("submitting", owner, key)
        .run();
      const instruction = `\n交付要求：只制作一个最终${args.output_kind === "image" ? "图片" : "视频"}文件，保存在 /mnt/session/outputs/。不要额外制作候选版本；不要发布或发送给第三方。完成后给出文件名和结果。`;
      await ark(env, `/sessions/${encodeURIComponent(sid)}/events`, {
        method: "POST",
        body: JSON.stringify({
          events: [
            {
              type: "user.message",
              content: [{ type: "text", text: args.prompt + instruction }],
            },
          ],
        }),
      });
      await env.DB.prepare(
        "UPDATE jobs SET phase = ? WHERE owner = ? AND request_key = ?",
      )
        .bind("submitted", owner, key)
        .run();
      return {
        request_id: key,
        session_id: sid,
        phase: "submitted",
        instruction:
          "已受理不代表生成成功。用 seedance_get_task 查询，再取产物。",
      };
    } catch (e) {
      await env.DB.prepare(
        "UPDATE jobs SET phase = ? WHERE owner = ? AND request_key = ?",
      )
        .bind("needs_review", owner, key)
        .run();
      throw new SafeError(
        `任务需核验（request_id=${key}${sid ? ", session_id=" + sid : ""}）。${e instanceof SafeError ? e.message : "网络或存储请求异常。"} 请查询原任务，不要重新生成。`,
      );
    } finally {
      await stream?.close();
    }
  }
  if (name === "seedance_get_task" || name === "seedance_get_outputs") {
    const j = await job(env, owner, args.request_id);
    if (!j.session_id)
      return {
        request_id: j.request_key,
        phase: j.phase,
        needs_review: true,
        instruction:
          "未确认 Session ID；勿重发，请在方舟控制台按 Dots 和任务编号查找。",
      };
    if (name === "seedance_get_outputs") {
      const files = [];
      let page = "";
      for (let i = 0; i < 20; i++) {
        const q = new URLSearchParams({ scope_id: j.session_id });
        if (page) q.set("page", page);
        const f = await ark(env, `/files?${q}`);
        files.push(...(f.data || []));
        if (!f.next_page)
          return {
            request_id: j.request_key,
            session_id: j.session_id,
            files: files
              .filter((x) => /^(image|video)\//.test(x.mime_type || ""))
              .map((x) => ({
                id: x.id,
                filename: x.filename,
                mime_type: x.mime_type,
                download_url: x.download_url,
              })),
            instruction:
              "下载地址有时效，请及时下载；未返回预期文件时继续查询。",
          };
        page = f.next_page;
      }
      throw new SafeError("文件分页超过查询上限。");
    }
    const [s, events] = await Promise.all([
      ark(env, `/sessions/${encodeURIComponent(j.session_id)}`),
      history(env, j.session_id),
    ]);
    return {
      request_id: j.request_key,
      session_id: j.session_id,
      submission_phase: j.phase,
      status: s.status,
      usage: s.usage,
      ...summarize(events),
    };
  }
  throw new SafeError("未知工具。");
}
const instructions =
  "为用户调用 Seedance Managed Agent。首次使用先检查 connection_status。创建任务会产生费用，必须有用户授权；同一次需求固定一个 request_id，遇到超时/needs_review 必须查询原任务，禁止自动重新生成。生成时可能需要数分钟，分次查询；只有 end_turn 且无工具错误并取得实际产物，才能报告完成。不得把密钥放进任何工具参数。";
async function rpc(body, env, owner) {
  const id = body.id ?? null;
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string")
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "Invalid request" },
    };
  let value;
  if (body.method === "server/discover")
    value = {
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
      serverInfo: { name: "seedacne-dots", version: "0.1.0" },
      instructions,
    };
  else if (body.method === "initialize")
    value = {
      protocolVersion:
        body.params?.protocolVersion === "2026-07-28"
          ? "2026-07-28"
          : "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "seedacne-dots", version: "0.1.0" },
      instructions,
    };
  else if (body.method === "tools/list") value = { tools };
  else if (body.method === "ping") value = {};
  else if (body.method.startsWith("notifications/")) return null;
  else if (body.method === "tools/call") {
    try {
      value = result(
        await call(body.params?.name, body.params?.arguments || {}, env, owner),
      );
    } catch (e) {
      value = {
        isError: true,
        content: [
          {
            type: "text",
            text:
              e instanceof SafeError
                ? e.message
                : "服务请求失败，请检查配置或查询原任务。",
          },
        ],
      };
    }
  } else
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found" },
    };
  return { jsonrpc: "2.0", id, result: value };
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const owner = request.headers.get("oai-authenticated-user-id");
    // Sites authenticates and authorizes the caller before forwarding requests.
    if (!owner) return json({ error: "Authentication required" }, 401);
    if (url.pathname === "/mcp") {
      if (request.method === "GET")
        return new Response(null, { status: 405, headers: { Allow: "POST" } });
      if (request.method !== "POST")
        return new Response(null, { status: 405, headers: { Allow: "POST" } });
      if (Number(request.headers.get("content-length") || 0) > 20000)
        return json({ error: "Request too large" }, 413);
      let body;
      try {
        const raw = await request.text();
        if (raw.length > 20000)
          return json({ error: "Request too large" }, 413);
        body = JSON.parse(raw);
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (Array.isArray(body) || !body || typeof body !== "object")
        return json({ error: "Invalid request" }, 400);
      const r = await rpc(body, env, owner);
      return r === null ? new Response(null, { status: 202 }) : json(r);
    }
    if (url.pathname === "/api/status" && request.method === "GET")
      return json(await call("seedance_connection_status", {}, env, owner));
    if (url.pathname !== "/" || request.method !== "GET")
      return json({ error: "Not found" }, 404);
    const ready = required.every((k) => !!env[k]);
    return new Response(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Seedacne · Dots 视觉创作</title><style>body{margin:0;background:#f5f3ee;color:#222;font:16px system-ui;line-height:1.7}main{max-width:760px;margin:10vh auto;padding:32px}small{color:#766553;letter-spacing:.14em}h1{font-size:44px;line-height:1.2;margin:16px 0}article{background:#fff;padding:28px;border:1px solid #ded9d0;border-radius:16px;margin:24px 0}b{color:#8c482a}code{overflow-wrap:anywhere}li{margin:8px 0}</style><main><small>SEEDANCE × DOTS</small><h1>把创作需求，交给视觉 Agent。</h1><p>这是你的私有接入服务。由 Dots 提交任务、查询进度，再交付图片与视频。</p><article><b>${ready ? "服务端配置已就绪" : "等待服务端凭据配置"}</b><p>生成调用：${env.GENERATION_ENABLED === "true" ? "已启用，按方舟用量计费" : "尚未启用"}</p><p>连接检查：<a href="/api/status">查看状态</a></p></article><article><h2>在 Dots 中使用</h2><ol><li>安装此站点对应的私有插件。</li><li>向 Dots 描述用途、主体、画幅和风格。</li><li>确认创作需求后提交；生成过程中可继续查询原任务。</li></ol><p>成品以实际返回的图片与视频文件为准。</p></article></main></html>`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self' https://chatgpt.com",
        },
      },
    );
  },
};
export { summarize, tools };
