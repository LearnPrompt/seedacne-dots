const BASE = "https://ark.cn-beijing.volces.com/api/v3";
const VERSION = "0.2.2";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const idSchema = { type: "string", minLength: 8, maxLength: 100 };
const referencesSchema = {
  type: "array",
  items: idSchema,
  maxItems: 6,
  uniqueItems: true,
};
const taskProperties = {
  request_id: idSchema,
  prompt: { type: "string", minLength: 1, maxLength: 12000 },
  output_kind: { type: "string", enum: ["image", "video"] },
  reference_ids: referencesSchema,
};
function descriptor(
  name,
  description,
  properties,
  required,
  readOnly = false,
  extra = {},
) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: false,
      openWorldHint: true,
    },
    ...extra,
  };
}
const tools = [
  descriptor(
    "seedance_connection_status",
    "检查固定 Agent/Environment、参考图上传配置和版本；verify_remote 仅做只读核验，不生成。",
    { verify_remote: { type: "boolean", default: false } },
    [],
    true,
  ),
  descriptor(
    "seedance_upload_reference",
    "将用户附件上传为本人可用的参考图，不生成素材。仅 JPEG/PNG/WebP、最大10MiB。reference_id固定；结果不明先查原编号，不重新上传。",
    {
      reference_id: idSchema,
      file: {
        type: "object",
        properties: {
          download_url: { type: "string" },
          file_id: { type: "string" },
          mime_type: { type: "string" },
          file_name: { type: "string" },
        },
        required: ["download_url", "file_id"],
        additionalProperties: false,
      },
    },
    ["reference_id", "file"],
    false,
    { _meta: { "openai/fileParams": ["file"] } },
  ),
  descriptor(
    "seedance_get_reference",
    "只读查询本人参考图的上传结果；不返回附件临时下载地址或密钥。",
    { reference_id: idSchema },
    ["reference_id"],
    true,
  ),
  descriptor(
    "seedance_create_task",
    "按授权新建一次图片或视频任务，可引用已上传reference_ids。会产生用量费用；同一需求固定request_id。",
    taskProperties,
    ["request_id", "prompt", "output_kind"],
  ),
  descriptor(
    "seedance_continue_task",
    "在原任务的同一Session继续修改，保留上文和原素材。会产生用量费用；request_id是根任务，turn_id是本次修改的新稳定编号。模糊失败查原轮，禁止换号重发。",
    { ...taskProperties, turn_id: idSchema },
    ["request_id", "turn_id", "prompt", "output_kind"],
  ),
  descriptor(
    "seedance_get_task",
    "查询本人任务当前轮的状态、回复和错误；可用turn_id查指定轮。旧轮end_turn不能证明新轮完成。",
    { request_id: idSchema, turn_id: idSchema },
    ["request_id"],
    true,
  ),
  descriptor(
    "seedance_get_outputs",
    "查询当前轮实际注册的图片/视频产物；可指定turn_id。不会把上一轮产物冒充本轮结果。下载地址有时效。",
    { request_id: idSchema, turn_id: idSchema },
    ["request_id"],
    true,
  ),
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
function storage(env) {
  if (!env.DB) throw new SafeError("任务存储尚未就绪。");
}
async function first(env, sql, ...values) {
  return env.DB.prepare(sql)
    .bind(...values)
    .first();
}
async function run(env, sql, ...values) {
  return env.DB.prepare(sql)
    .bind(...values)
    .run();
}
async function ark(env, path, options = {}) {
  check(env);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const response = await fetch(BASE + path, {
      ...options,
      signal: ctl.signal,
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${env.ARK_API_KEY}`,
        ...(options.body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
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
    // Fetch errors can contain signed URLs or credentials: never echo their messages.
    throw new SafeError(
      "方舟连接失败或超时。写入结果需查询原编号核验，不能自动重试。",
    );
  } finally {
    clearTimeout(timer);
  }
}
function validateId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(value))
    throw new SafeError("编号需为 8–100 位英文字母、数字、下划线或短横线。");
  return value;
}
async function digest(value) {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
async function job(env, owner, key) {
  storage(env);
  const row = await first(
    env,
    "SELECT * FROM jobs WHERE owner = ? AND request_key = ?",
    owner,
    validateId(key),
  );
  if (!row) throw new SafeError("未找到当前用户的任务。");
  return row;
}
async function reference(env, owner, key) {
  storage(env);
  const row = await first(
    env,
    "SELECT * FROM reference_uploads WHERE owner = ? AND reference_key = ?",
    owner,
    validateId(key),
  );
  if (!row) throw new SafeError("未找到当前用户的参考图。");
  return row;
}
function referenceResult(row, reused = false) {
  return {
    reference_id: row.reference_key,
    phase: row.phase,
    file_id: row.file_id,
    filename: row.filename,
    mime_type: row.mime_type,
    bytes: row.bytes,
    sha256: row.content_hash,
    reused,
    needs_review: row.phase === "needs_review",
  };
}
function allowedSource(value, env) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SafeError("附件下载地址无效。");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    /^[\d.]+$/.test(host) ||
    host.includes(":") ||
    host === "localhost" ||
    /\.(?:localhost|local|internal|lan)$/.test(host)
  )
    throw new SafeError(
      "附件来源必须是已配置的 HTTPS 公网文件主机，不能使用私网、IP、凭据或其他端口。",
    );
  const allowed = String(env.REFERENCE_ALLOWED_HOSTS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(host))
    throw new SafeError(
      `附件主机 ${host} 尚未获准。请维护者将这个准确主机名配置到服务端 REFERENCE_ALLOWED_HOSTS；不要把临时下载地址或令牌写入配置。`,
    );
  return url;
}
async function downloadImage(file, env) {
  if (
    !file ||
    typeof file.download_url !== "string" ||
    typeof file.file_id !== "string" ||
    !file.file_id ||
    file.file_id.length > 256
  )
    throw new SafeError(
      "请提供运行时附件 file 对象，包含 download_url 和 file_id；本地路径不能作为云端附件。",
    );
  const url = allowedSource(file.download_url, env);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  let reader;
  try {
    const response = await fetch(url.href, {
      redirect: "manual",
      signal: ctl.signal,
      headers: { Accept: "image/png,image/jpeg,image/webp" },
    });
    if (!response.ok || !response.body)
      throw new SafeError(
        `附件下载失败 HTTP ${response.status}；可能已过期，请重新附加文件。不会跟随重定向。`,
      );
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_IMAGE_BYTES)
      throw new SafeError("参考图超过10MiB限制。");
    reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_IMAGE_BYTES)
        throw new SafeError("参考图超过10MiB限制。");
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    const meta = imageInfo(bytes);
    if (file.mime_type && file.mime_type !== meta.mime_type)
      throw new SafeError("附件声明的类型与图片内容不一致。");
    return { bytes, ...meta };
  } catch (e) {
    if (e instanceof SafeError) throw e;
    throw new SafeError("附件下载失败或超时，请重新附加文件；未向方舟上传。");
  } finally {
    clearTimeout(timer);
    ctl.abort();
    await reader?.cancel().catch(() => {});
  }
}
function imageInfo(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let mime_type, width, height;
  const ascii = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
  if (
    bytes.length >= 33 &&
    view.getUint32(8) === 13 &&
    bytes[0] === 137 &&
    ascii(1, 3) === "PNG" &&
    bytes[4] === 13 &&
    bytes[5] === 10 &&
    bytes[6] === 26 &&
    bytes[7] === 10 &&
    ascii(12, 4) === "IHDR"
  ) {
    mime_type = "image/png";
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216) {
    mime_type = "image/jpeg";
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at++] !== 255) break;
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (at + 2 > bytes.length) break;
      const size = view.getUint16(at);
      if (size < 2 || at + size > bytes.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        size >= 7
      ) {
        height = view.getUint16(at + 3);
        width = view.getUint16(at + 5);
        break;
      }
      at += size;
    }
  } else if (
    bytes.length >= 30 &&
    ascii(0, 4) === "RIFF" &&
    ascii(8, 4) === "WEBP"
  ) {
    mime_type = "image/webp";
    if (ascii(12, 4) === "VP8X") {
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (
      ascii(12, 4) === "VP8 " &&
      bytes[23] === 157 &&
      bytes[24] === 1 &&
      bytes[25] === 42
    ) {
      width = view.getUint16(26, true) & 16383;
      height = view.getUint16(28, true) & 16383;
    } else if (ascii(12, 4) === "VP8L" && bytes[20] === 47) {
      const bits = view.getUint32(21, true);
      width = (bits & 16383) + 1;
      height = ((bits >> 14) & 16383) + 1;
    }
  }
  if (
    !mime_type ||
    !width ||
    !height ||
    width > 16384 ||
    height > 16384 ||
    width * height > 40000000
  )
    throw new SafeError(
      "只支持具有有效尺寸的 JPEG、PNG 或 WebP 图片（最多4000万像素）。",
    );
  return { mime_type, width, height };
}
function safeFilename(name, mime) {
  const extension = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
  }[mime];
  const stem =
    String(name || "reference")
      .split(/[\\/]/)
      .at(-1)
      .replace(/\.[^.]*$/, "")
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .slice(0, 80)
      .replace(/^_+|_+$/g, "") || "reference";
  return stem + extension;
}
async function uploadReference(args, env, owner) {
  check(env);
  storage(env);
  const key = validateId(args.reference_id);
  const old = await first(
    env,
    "SELECT * FROM reference_uploads WHERE owner = ? AND reference_key = ?",
    owner,
    key,
  );
  // Reconcile uncertain writes by ID only; never repeat an upstream upload automatically.
  if (old && old.phase !== "ready") return referenceResult(old, true);
  const image = await downloadImage(args.file, env);
  const hash = await digest(image.bytes);
  if (old) {
    if (old.content_hash !== hash)
      throw new SafeError("该 reference_id 已绑定另一张参考图；不能覆盖。");
    return referenceResult(old, true);
  }
  const filename = safeFilename(args.file.file_name, image.mime_type);
  const insert = await run(
    env,
    "INSERT INTO reference_uploads (owner, reference_key, content_hash, phase, filename, mime_type, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner, reference_key) DO NOTHING",
    owner,
    key,
    hash,
    "reserved",
    filename,
    image.mime_type,
    image.bytes.length,
    Date.now(),
  );
  if (!insert.meta.changes) {
    const row = await reference(env, owner, key);
    if (row.content_hash !== hash)
      throw new SafeError("该 reference_id 已绑定另一张参考图；不能覆盖。");
    return referenceResult(row, true);
  }
  try {
    const form = new FormData();
    form.set("purpose", "agent");
    form.set(
      "file",
      new Blob([image.bytes], { type: image.mime_type }),
      filename,
    );
    const uploaded = await ark(env, "/files", { method: "POST", body: form });
    if (
      typeof uploaded.id !== "string" ||
      !uploaded.id ||
      uploaded.id.length > 256
    )
      throw new SafeError("上传响应缺少文件ID，需人工核验。");
    await run(
      env,
      "UPDATE reference_uploads SET phase = ?, file_id = ? WHERE owner = ? AND reference_key = ?",
      "ready",
      uploaded.id,
      owner,
      key,
    );
    return referenceResult(await reference(env, owner, key));
  } catch (e) {
    await run(
      env,
      "UPDATE reference_uploads SET phase = ? WHERE owner = ? AND reference_key = ?",
      "needs_review",
      owner,
      key,
    );
    throw new SafeError(
      `参考图上传结果需核验（reference_id=${key}）。${e instanceof SafeError ? e.message : "存储异常。"} 请查询原编号，不能自动重新上传。`,
    );
  }
}
async function history(env, sid) {
  const events = [],
    seen = new Set();
  let page = "";
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({ limit: "200", order: "asc" });
    if (page) q.set("page", page);
    const r = await ark(
      env,
      `/sessions/${encodeURIComponent(sid)}/events?${q}`,
    );
    for (const event of r.data || [])
      if (!event.id || !seen.has(event.id)) {
        events.push(event);
        if (event.id) seen.add(event.id);
      }
    if (!r.next_page) return events;
    if (page === r.next_page)
      throw new SafeError("事件分页未前进，需人工核验。");
    page = r.next_page;
  }
  throw new SafeError("事件历史超过查询上限，请人工检查，勿重新提交。");
}
async function listFiles(env, sid) {
  const files = [],
    seen = new Set();
  let after = "";
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({
      scope_id: sid,
      purpose: "agent",
      limit: "100",
      order: "asc",
    });
    if (after) q.set("after", after);
    // The live Files API returns JSON null when a Session has no outputs.
    // It is an empty list, not evidence that any generation has completed.
    const r = (await ark(env, `/files?${q}`)) ?? { data: [], has_more: false };
    if (
      !r ||
      typeof r !== "object" ||
      (r.data != null && !Array.isArray(r.data))
    ) {
      const kind = (value) =>
        value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      const keys = (value) =>
        value && typeof value === "object"
          ? Object.keys(value)
              .filter((key) => /^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/.test(key))
              .slice(0, 12)
              .join(",")
          : "";
      throw new SafeError(
        `方舟文件列表结构异常（root=${kind(r)}; keys=${keys(r)}; data=${kind(r?.data)}; data_keys=${keys(r?.data)}）。请核验原任务，不要重复提交生成。`,
      );
    }
    for (const f of r.data || [])
      if (f.id && !seen.has(f.id)) {
        seen.add(f.id);
        files.push(f);
      }
    if (!r.has_more) return files;
    if (!r.last_id || r.last_id === after)
      throw new SafeError("文件分页未前进，需人工核验。");
    after = r.last_id;
  }
  throw new SafeError("文件分页超过查询上限。");
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
    const response = await fetch(
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
    if (!response.ok || !response.body)
      throw new SafeError(`无法打开事件流 HTTP ${response.status}`);
    const reader = response.body.getReader();
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
function taskInput(args) {
  const key = validateId(args.request_id);
  if (
    typeof args.prompt !== "string" ||
    !args.prompt.trim() ||
    args.prompt.length > 12000 ||
    !["image", "video"].includes(args.output_kind)
  )
    throw new SafeError("请提供有效 prompt 和 output_kind。");
  const refs = args.reference_ids || [];
  if (
    !Array.isArray(refs) ||
    refs.length > 6 ||
    new Set(refs).size !== refs.length
  )
    throw new SafeError("reference_ids需为不重复的最多6个参考图编号。");
  refs.forEach(validateId);
  return { key, refs };
}
async function inputHash(args, refs) {
  return digest(
    args.prompt +
      "\n" +
      args.output_kind +
      (refs.length ? "\nreferences:" + JSON.stringify(refs) : ""),
  );
}
async function getTurn(env, owner, key, turnKey) {
  if (turnKey !== undefined)
    return first(
      env,
      "SELECT * FROM task_turns WHERE owner = ? AND request_key = ? AND turn_key = ?",
      owner,
      key,
      validateId(turnKey),
    );
  return first(
    env,
    "SELECT * FROM task_turns WHERE owner = ? AND request_key = ? ORDER BY id DESC LIMIT 1",
    owner,
    key,
  );
}
function turnResult(j, turn, reused = false) {
  return {
    request_id: j.request_key,
    turn_id: turn?.turn_key || j.request_key,
    session_id: j.session_id,
    phase: turn?.phase || j.phase,
    reused,
    instruction: "继续查询原任务/原轮，不要换编号重发。",
  };
}
async function refsReady(env, owner, refs) {
  const rows = [];
  for (const key of refs) {
    const row = await reference(env, owner, key);
    if (row.phase !== "ready" || !row.file_id)
      throw new SafeError(`参考图 ${key} 尚未确认上传成功，请查询原编号。`);
    rows.push(row);
  }
  return rows;
}
async function mountReferences(env, owner, j, refs) {
  const mounted = [];
  for (const ref of refs) {
    let local = await first(
      env,
      "SELECT * FROM reference_mounts WHERE owner = ? AND request_key = ? AND reference_key = ?",
      owner,
      j.request_key,
      ref.reference_key,
    );
    const path = `references/${ref.reference_key}/${ref.filename}`;
    if (local?.mounted_file_id) {
      mounted.push({
        ...ref,
        mounted_file_id: local.mounted_file_id,
        mount_path: local.mount_path,
      });
      continue;
    }
    const existing = await ark(
      env,
      `/sessions/${encodeURIComponent(j.session_id)}/resources`,
    );
    const found = (existing.data || []).find(
      (r) =>
        r.type === "file" &&
        (r.mount_path === path ||
          r.mount_path === `/mnt/session/uploads/${path}`),
    );
    if (found?.file_id) {
      await run(
        env,
        "INSERT INTO reference_mounts (owner, request_key, reference_key, mounted_file_id, mount_path) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner, request_key, reference_key) DO UPDATE SET mounted_file_id=excluded.mounted_file_id, mount_path=excluded.mount_path",
        owner,
        j.request_key,
        ref.reference_key,
        found.file_id,
        `/mnt/session/uploads/${path}`,
      );
      mounted.push({
        ...ref,
        mounted_file_id: found.file_id,
        mount_path: `/mnt/session/uploads/${path}`,
      });
      continue;
    }
    const resource = await ark(
      env,
      `/sessions/${encodeURIComponent(j.session_id)}/resources`,
      {
        method: "POST",
        body: JSON.stringify({
          type: "file",
          file_id: ref.file_id,
          mount_path: path,
        }),
      },
    );
    if (typeof resource.file_id !== "string" || !resource.file_id)
      throw new SafeError("资源挂载响应缺少文件ID，需核验原Session。");
    await run(
      env,
      "INSERT INTO reference_mounts (owner, request_key, reference_key, mounted_file_id, mount_path) VALUES (?, ?, ?, ?, ?)",
      owner,
      j.request_key,
      ref.reference_key,
      resource.file_id,
      `/mnt/session/uploads/${path}`,
    );
    mounted.push({
      ...ref,
      mounted_file_id: resource.file_id,
      mount_path: `/mnt/session/uploads/${path}`,
    });
  }
  return mounted;
}
async function turnEvents(turn, events) {
  let after = events;
  if (turn.boundary_event_id) {
    const index = events.findIndex((x) => x.id === turn.boundary_event_id);
    if (index < 0)
      return { events: [], accepted: false, boundary_missing: true };
    after = events.slice(index + 1);
  }
  let message = turn.message_event_id
    ? after.find(
        (x) => x.id === turn.message_event_id && x.type === "user.message",
      )
    : null;
  if (!message && turn.message_hash) {
    for (const event of after)
      if (
        event.type === "user.message" &&
        (await digest(JSON.stringify(event.content || []))) ===
          turn.message_hash
      ) {
        message = event;
        break;
      }
  }
  if (!message) return { events: [], accepted: false, boundary_missing: false };
  const index = after.indexOf(message);
  // A direct console/client turn must not bleed into the saved turn's results.
  const end = after.findIndex((x, i) => i > index && x.type === "user.message");
  return {
    events: after.slice(index, end < 0 ? undefined : end),
    accepted: true,
    message_event_id: message.id,
    boundary_missing: false,
  };
}
async function updateTurn(env, owner, j, turn, session, events) {
  const scoped = await turnEvents(turn, events);
  const summary = summarize(scoped.events);
  summary.turn_completed = scoped.accepted && summary.turn_completed;
  let phase = turn.phase;
  if (summary.turn_completed) phase = "completed";
  else if (scoped.accepted && summary.stop_reason === "retries_exhausted")
    phase = "failed";
  if (
    phase !== turn.phase ||
    (scoped.message_event_id && !turn.message_event_id)
  ) {
    await run(
      env,
      "UPDATE task_turns SET phase = ?, message_event_id = ? WHERE owner = ? AND request_key = ? AND turn_key = ?",
      phase,
      scoped.message_event_id || turn.message_event_id,
      owner,
      j.request_key,
      turn.turn_key,
    );
    if (
      turn.turn_key === j.request_key &&
      ["completed", "failed"].includes(phase)
    )
      await run(
        env,
        "UPDATE jobs SET phase = ? WHERE owner = ? AND request_key = ?",
        phase,
        owner,
        j.request_key,
      );
  }
  return {
    ...summary,
    accepted: scoped.accepted,
    boundary_missing: scoped.boundary_missing,
    phase,
    session_status: session.status,
  };
}
async function reserveTurn(env, owner, key, turnKey, hash) {
  try {
    const inserted = await run(
      env,
      "INSERT INTO task_turns (owner, request_key, turn_key, prompt_hash, phase, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner,request_key,turn_key) DO NOTHING",
      owner,
      key,
      turnKey,
      hash,
      "reserved",
      Date.now(),
    );
    const turn = await getTurn(env, owner, key, turnKey);
    if (turn?.prompt_hash !== hash)
      throw new SafeError("该 turn_id 已绑定另一需求；不允许覆盖。");
    return { turn, inserted: !!inserted.meta.changes };
  } catch (e) {
    if (e instanceof SafeError) throw e;
    const old = await getTurn(env, owner, key, turnKey);
    if (old) {
      if (old.prompt_hash !== hash)
        throw new SafeError("该 turn_id 已绑定另一需求；不允许覆盖。");
      return { turn: old, inserted: false };
    }
    throw new SafeError(
      "原任务有运行中或结果未核验的轮次；先查询原轮，不能同时提交另一修改。",
    );
  }
}
function hasNoSubmissionBoundary(turn) {
  return (
    turn?.message_hash === null &&
    turn.message_event_id === null &&
    turn.boundary_event_id === null &&
    turn.output_path === null
  );
}
function isUnsubmittedRoot(j, turn) {
  return (
    typeof j.session_id === "string" &&
    j.session_id.startsWith("sesn-") &&
    turn?.turn_key === j.request_key &&
    turn.phase === "needs_review" &&
    hasNoSubmissionBoundary(turn)
  );
}
async function assertUnsubmittedSession(env, j, knownEvents) {
  const [session, events] = await Promise.all([
    ark(env, `/sessions/${encodeURIComponent(j.session_id)}`),
    knownEvents ? Promise.resolve(knownEvents) : history(env, j.session_id),
  ]);
  if (
    session.status !== "idle" ||
    events.some((event) => event.type === "user.message")
  )
    throw new SafeError(
      "原Session不是空闲且从未接收用户消息的会话，不能恢复发送；请继续核验原任务。",
    );
}
async function recoverBeforeSubmission(args, env, owner, j, turn, ready) {
  if (!isUnsubmittedRoot(j, turn)) return turnResult(j, turn, true);
  const claim = await run(
    env,
    "UPDATE task_turns SET phase = ? WHERE owner = ? AND request_key = ? AND turn_key = ? AND prompt_hash = ? AND phase = ? AND message_hash IS NULL AND message_event_id IS NULL AND boundary_event_id IS NULL AND output_path IS NULL",
    "reserved",
    owner,
    j.request_key,
    j.request_key,
    turn.prompt_hash,
    "needs_review",
  );
  if (!claim.meta.changes)
    return turnResult(
      j,
      await getTurn(env, owner, j.request_key, j.request_key),
      true,
    );
  try {
    // The same partial unique index continues to hold the task's active slot.
    // Recovery does not create a session or claim an already-sent operation.
    await assertUnsubmittedSession(env, j);
    const submitted = await submitTurn(
      env,
      owner,
      j,
      { ...turn, phase: "reserved" },
      args,
      ready,
      true,
    );
    return { ...submitted, reused: true, resumed_before_submission: true };
  } catch (e) {
    // Only release our unsent claim back to review. Never clear a persisted
    // sending boundary or make an ambiguous POST eligible for recovery.
    await run(
      env,
      "UPDATE task_turns SET phase = ? WHERE owner = ? AND request_key = ? AND turn_key = ? AND phase = ? AND message_hash IS NULL AND message_event_id IS NULL AND boundary_event_id IS NULL AND output_path IS NULL",
      "needs_review",
      owner,
      j.request_key,
      j.request_key,
      "reserved",
    );
    throw new SafeError(
      `原任务恢复未完成（request_id=${j.request_key}, session_id=${j.session_id}）。${e instanceof SafeError ? e.message : "读取或存储异常。"} 请查询原编号，不能换号重发。`,
    );
  }
}
async function submitTurn(
  env,
  owner,
  j,
  turn,
  args,
  refs,
  verifyUnsubmitted = false,
) {
  let stream;
  try {
    const mounted = await mountReferences(env, owner, j, refs);
    stream = await openReady(env, j.session_id);
    // Establish the stream first; snapshot history and outputs before the write.
    const events = await history(env, j.session_id);
    if (verifyUnsubmitted) {
      await assertUnsubmittedSession(env, j, events);
      const current = await getTurn(env, owner, j.request_key, turn.turn_key);
      if (current?.phase !== "reserved" || !hasNoSubmissionBoundary(current))
        throw new SafeError("恢复领取状态已改变，不能重复发送原需求。");
    }
    const baseline = await listFiles(env, j.session_id);
    const outputPath = `/mnt/session/outputs/${j.request_key}/${turn.turn_key}/`;
    const resourceText = mounted.length
      ? "\n本轮参考图已挂载：\n" +
        mounted.map((x) => `${x.reference_key}: ${x.mount_path}`).join("\n")
      : "";
    const outputName = `${j.request_key}__${turn.turn_key}.${args.output_kind === "image" ? "png" : "mp4"}`;
    const instruction = `\n交付要求：只制作一个最终${args.output_kind === "image" ? "图片" : "视频"}文件，使用本轮唯一新路径 ${outputPath}${outputName}，不得覆盖旧轮产物，文件名必须保留 ${j.request_key}__${turn.turn_key} 前缀以区分轮次。不要额外制作候选版本；不要发布或发送给第三方。完成后给出文件名和结果。`;
    const content = [
      { type: "text", text: args.prompt + resourceText + instruction },
      ...mounted.map((x) => ({
        type: "image",
        source: { type: "file", file_id: x.mounted_file_id },
      })),
    ];
    await run(
      env,
      "UPDATE task_turns SET phase = ?, boundary_event_id = ?, message_hash = ?, base_file_ids = ?, output_path = ? WHERE owner = ? AND request_key = ? AND turn_key = ?",
      "submitting",
      events.at(-1)?.id || null,
      await digest(JSON.stringify(content)),
      JSON.stringify(baseline.map((f) => f.id)),
      outputPath,
      owner,
      j.request_key,
      turn.turn_key,
    );
    const accepted = await ark(
      env,
      `/sessions/${encodeURIComponent(j.session_id)}/events`,
      {
        method: "POST",
        body: JSON.stringify({ events: [{ type: "user.message", content }] }),
      },
    );
    const messageId = accepted.data?.[0]?.id;
    await run(
      env,
      "UPDATE task_turns SET phase = ?, message_event_id = ? WHERE owner = ? AND request_key = ? AND turn_key = ?",
      "submitted",
      typeof messageId === "string" ? messageId : null,
      owner,
      j.request_key,
      turn.turn_key,
    );
    if (turn.turn_key === j.request_key)
      await run(
        env,
        "UPDATE jobs SET phase = ? WHERE owner = ? AND request_key = ?",
        "submitted",
        owner,
        j.request_key,
      );
    return {
      ...turnResult(j, { ...turn, phase: "submitted" }),
      reference_ids: refs.map((x) => x.reference_key),
      instruction: "已受理不代表生成成功。查询当前轮状态，再取当前轮产物。",
    };
  } catch (e) {
    await run(
      env,
      "UPDATE task_turns SET phase = ? WHERE owner = ? AND request_key = ? AND turn_key = ?",
      "needs_review",
      owner,
      j.request_key,
      turn.turn_key,
    );
    if (turn.turn_key === j.request_key)
      await run(
        env,
        "UPDATE jobs SET phase = ? WHERE owner = ? AND request_key = ?",
        "needs_review",
        owner,
        j.request_key,
      );
    throw new SafeError(
      `任务需核验（request_id=${j.request_key}, turn_id=${turn.turn_key}, session_id=${j.session_id}）。${e instanceof SafeError ? e.message : "网络或存储请求异常。"} 请查询原轮，不要重新生成。`,
    );
  } finally {
    await stream?.close();
  }
}
async function createTask(args, env, owner) {
  check(env);
  storage(env);
  if (env.GENERATION_ENABLED !== "true")
    throw new SafeError("生成尚未启用；需先确认付费用量授权。");
  const { key, refs } = taskInput(args);
  const hash = await inputHash(args, refs);
  const ready = await refsReady(env, owner, refs);
  const inserted = await run(
    env,
    "INSERT INTO jobs (owner, request_key, prompt_hash, phase, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner,request_key) DO NOTHING",
    owner,
    key,
    hash,
    "reserved",
    Date.now(),
  );
  if (!inserted.meta.changes) {
    const old = await job(env, owner, key);
    if (old.prompt_hash !== hash)
      throw new SafeError("该 request_id 已绑定另一需求；不允许覆盖。");
    const turn = await getTurn(env, owner, key, key);
    if (turn?.prompt_hash !== undefined && turn.prompt_hash !== hash)
      throw new SafeError("该轮次已绑定另一需求；不允许覆盖。");
    return recoverBeforeSubmission(args, env, owner, old, turn, ready);
  }
  let sid;
  try {
    const { turn } = await reserveTurn(env, owner, key, key, hash);
    const session = await ark(env, "/sessions", {
      method: "POST",
      body: JSON.stringify({
        agent: env.ARK_AGENT_ID,
        environment_id: env.ARK_ENVIRONMENT_ID,
        title: `Dots ${key}`,
      }),
    });
    sid = session.id;
    if (typeof sid !== "string" || !sid.startsWith("sesn-"))
      throw new SafeError("Session 创建结果缺少有效 ID，需人工核验。");
    await run(
      env,
      "UPDATE jobs SET session_id = ?, phase = ? WHERE owner = ? AND request_key = ?",
      sid,
      "session_created",
      owner,
      key,
    );
    return await submitTurn(
      env,
      owner,
      { request_key: key, session_id: sid },
      turn,
      args,
      ready,
    );
  } catch (e) {
    await run(
      env,
      "UPDATE jobs SET phase = ? WHERE owner = ? AND request_key = ?",
      "needs_review",
      owner,
      key,
    );
    await run(
      env,
      "UPDATE task_turns SET phase = ? WHERE owner = ? AND request_key = ? AND turn_key = ?",
      "needs_review",
      owner,
      key,
      key,
    );
    if (e instanceof SafeError && e.message.includes("任务需核验")) throw e;
    throw new SafeError(
      `任务需核验（request_id=${key}${sid ? ", session_id=" + sid : ""}）。${e instanceof SafeError ? e.message : "网络或存储请求异常。"} 请查询原任务，不要重新生成。`,
    );
  }
}
async function continueTask(args, env, owner) {
  check(env);
  storage(env);
  if (env.GENERATION_ENABLED !== "true")
    throw new SafeError("生成尚未启用；需先确认付费用量授权。");
  const { key, refs } = taskInput(args);
  const turnKey = validateId(args.turn_id);
  if (turnKey === key)
    throw new SafeError("修改轮 turn_id 必须与根 request_id 不同。");
  const j = await job(env, owner, key);
  if (!j.session_id)
    throw new SafeError("原任务的Session尚未确认，不能继续修改。");
  const hash = await inputHash(args, refs);
  const existing = await getTurn(env, owner, key, turnKey);
  if (existing) {
    if (existing.prompt_hash !== hash)
      throw new SafeError("该 turn_id 已绑定另一需求；不允许覆盖。");
    return turnResult(j, existing, true);
  }
  const ready = await refsReady(env, owner, refs);
  const [session, events] = await Promise.all([
    ark(env, `/sessions/${encodeURIComponent(j.session_id)}`),
    history(env, j.session_id),
  ]);
  const previous = await getTurn(env, owner, key);
  if (previous) await updateTurn(env, owner, j, previous, session, events);
  else if (
    j.phase === "needs_review" ||
    !["submitted", "completed", "failed"].includes(j.phase)
  )
    throw new SafeError("原任务提交结果未核验，不能继续修改。");
  const stop = summarize(events).stop_reason;
  if (
    session.status !== "idle" ||
    !["end_turn", "retries_exhausted"].includes(stop)
  )
    throw new SafeError(
      "原Session仍在运行、需要工具确认、已终止或尚无可续接终态；请先查询原轮。",
    );
  if (!previous) {
    // v0.1 tasks predate the turn ledger. Freeze their original media before
    // admitting a new turn so an explicit initial-turn query cannot leak edits.
    const priorFiles = await listFiles(env, j.session_id);
    const initialMessage = events.find(
      (event) => event.type === "user.message",
    );
    await run(
      env,
      "INSERT INTO task_turns (owner, request_key, turn_key, prompt_hash, phase, message_event_id, message_hash, output_file_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner,request_key,turn_key) DO NOTHING",
      owner,
      key,
      key,
      j.prompt_hash,
      stop === "end_turn" ? "completed" : "failed",
      initialMessage?.id || null,
      initialMessage
        ? await digest(JSON.stringify(initialMessage.content || []))
        : null,
      JSON.stringify(priorFiles.map((f) => f.id)),
      j.created_at,
    );
  }
  const reserved = await reserveTurn(env, owner, key, turnKey, hash);
  if (!reserved.inserted) return turnResult(j, reserved.turn, true);
  return submitTurn(env, owner, j, reserved.turn, args, ready);
}
// Files lists processing/failed outputs too; only active (or status-less) files are deliverable.
const isReady = (f) => !f.status || f.status === "active";
function deliverable(files) {
  return {
    files: files.filter(isReady).map(outputFile),
    not_ready: files
      .filter((f) => !isReady(f))
      .map((f) => ({ id: f.id, filename: f.filename, status: f.status })),
  };
}
function outputFile(f) {
  return {
    id: f.id,
    filename: f.filename,
    mime_type: f.mime_type,
    bytes: f.bytes,
    created_at: f.created_at,
    download_url: f.download_url,
  };
}
async function outputsForTurn(env, owner, j, turn, allFiles) {
  const media = allFiles.filter((f) =>
    /^(image|video)\//.test(f.mime_type || ""),
  );
  if (!turn) return { ...deliverable(media), legacy_unscoped: true };
  const baseline = new Set(JSON.parse(turn.base_file_ids || "[]"));
  const known = new Set(JSON.parse(turn.output_file_ids || "[]"));
  const newest = await getTurn(env, owner, j.request_key);
  const candidates = media.filter((f) => !baseline.has(f.id));
  const scoped = [];
  for (const file of candidates) {
    const filename = String(file.filename || "").replace(/^\.\//, "");
    const relativePath = turn.output_path?.replace(
      /^\/mnt\/session\/outputs\//,
      "",
    );
    const filenamePrefix = `${j.request_key}__${turn.turn_key}.`;
    const inPath =
      !!turn.output_path &&
      (filename.startsWith(turn.output_path) ||
        filename.startsWith(relativePath || "\0") ||
        filename.split("/").at(-1).startsWith(filenamePrefix));
    // A late registration from the prior turn can appear in a set difference.
    // Only attribute names/paths carrying this turn or IDs already attributed.
    if (known.has(file.id) || (turn.message_hash && turn.output_path && inPath))
      scoped.push(file);
  }
  if (newest?.id === turn.id && scoped.length) {
    for (const f of scoped) known.add(f.id);
    await run(
      env,
      "UPDATE task_turns SET output_file_ids = ? WHERE owner = ? AND request_key = ? AND turn_key = ?",
      JSON.stringify([...known]),
      owner,
      j.request_key,
      turn.turn_key,
    );
  }
  return {
    ...deliverable(scoped),
    pending_registration: scoped.length === 0,
    attribution_uncertain: candidates.some((f) => !scoped.includes(f)),
    output_path: turn.output_path,
  };
}
async function call(name, args, env, owner) {
  if (name === "seedance_connection_status") {
    const missing = required.filter((k) => !env[k]);
    const config = {
      version: VERSION,
      bridge_version: VERSION,
      references_enabled: !!String(env.REFERENCE_ALLOWED_HOSTS || "").trim(),
      configured: !missing.length,
      missing,
      generation_enabled: env.GENERATION_ENABLED === "true",
      agent_id: env.ARK_AGENT_ID || null,
      environment_id: env.ARK_ENVIRONMENT_ID || null,
      storage_configured: !!env.DB,
      reference_upload_configured: !!String(
        env.REFERENCE_ALLOWED_HOSTS || "",
      ).trim(),
      reference_formats: ["image/jpeg", "image/png", "image/webp"],
      max_reference_bytes: MAX_IMAGE_BYTES,
      capabilities: [
        "text_generation",
        "reference_image_upload",
        "same_session_continue",
        "turn_scoped_outputs",
      ],
    };
    if (args.verify_remote) {
      check(env);
      const [a, e] = await Promise.all([
        ark(env, `/agents/${encodeURIComponent(env.ARK_AGENT_ID)}`),
        ark(env, `/environments/${encodeURIComponent(env.ARK_ENVIRONMENT_ID)}`),
      ]);
      Object.assign(config, {
        remote_verified: true,
        agent_type: a.base_agent,
        agent_name: a.name,
        environment_name: e.name,
      });
    }
    return config;
  }
  if (name === "seedance_upload_reference")
    return uploadReference(args, env, owner);
  if (name === "seedance_get_reference")
    return referenceResult(await reference(env, owner, args.reference_id));
  if (name === "seedance_create_task") return createTask(args, env, owner);
  if (name === "seedance_continue_task") return continueTask(args, env, owner);
  if (name === "seedance_get_task" || name === "seedance_get_outputs") {
    const j = await job(env, owner, args.request_id);
    const turn = await getTurn(env, owner, j.request_key, args.turn_id);
    if (args.turn_id && !turn && args.turn_id !== j.request_key)
      throw new SafeError("未找到当前用户的指定轮次。");
    if (!j.session_id)
      return {
        ...turnResult(j, turn),
        needs_review: true,
        instruction: "未确认Session；请核验原任务，不要重发。",
      };
    if (name === "seedance_get_outputs")
      return {
        request_id: j.request_key,
        turn_id: turn?.turn_key || j.request_key,
        session_id: j.session_id,
        ...(await outputsForTurn(
          env,
          owner,
          j,
          turn,
          await listFiles(env, j.session_id),
        )),
        instruction:
          "下载地址有时效，请及时下载；仅当前轮产物能用于本轮交付；not_ready 中的文件仍在处理或已失败，不能交付。",
      };
    const [session, events] = await Promise.all([
      ark(env, `/sessions/${encodeURIComponent(j.session_id)}`),
      history(env, j.session_id),
    ]);
    const state = turn
      ? await updateTurn(env, owner, j, turn, session, events)
      : summarize(events);
    const recoverableBeforeSubmission =
      isUnsubmittedRoot(j, turn) &&
      session.status === "idle" &&
      !events.some((event) => event.type === "user.message");
    return {
      request_id: j.request_key,
      turn_id: turn?.turn_key || j.request_key,
      session_id: j.session_id,
      submission_phase: turn?.phase || j.phase,
      status: session.status,
      usage: session.usage,
      usage_scope: "session_cumulative",
      ...state,
      recoverable_before_submission: recoverableBeforeSubmission,
      ...(recoverableBeforeSubmission
        ? {
            instruction:
              "已证实原Session空闲且从未接收用户消息，可用原request_id和完全相同参数调用seedance_create_task恢复原会话；不是重建或重新生成，禁止换号。",
          }
        : {}),
    };
  }
  throw new SafeError("未知工具。");
}
const instructions =
  "调用 Seedance Managed Agent。先检查connection_status。用户附件先调用upload_reference，成功后用reference_ids创建任务；不要把本地路径或临时附件链接直接当参考图文本。修改既有作品用continue_task，复用根request_id并为该轮设置稳定turn_id，不新建Session。创建/修改会产生费用，必须有用户授权。结果不明查询原任务/原轮，禁止自动换号重发。查询默认最新轮，可指定turn_id；只有该轮end_turn、无工具错误且取得该轮实际产物才能报告成功。用量是Session累计值，不是单轮账单。不得把密钥放进工具参数。";
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
      serverInfo: { name: "seedacne-dots", version: VERSION },
      instructions,
    };
  else if (body.method === "initialize")
    value = {
      protocolVersion:
        body.params?.protocolVersion === "2026-07-28"
          ? "2026-07-28"
          : "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "seedacne-dots", version: VERSION },
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
    // Only trust this header behind the Sites authentication gateway.
    if (!owner) return json({ error: "Authentication required" }, 401);
    if (url.pathname === "/mcp") {
      if (request.method !== "POST")
        return new Response(null, { status: 405, headers: { Allow: "POST" } });
      if (Number(request.headers.get("content-length") || 0) > 65536)
        return json({ error: "Request too large" }, 413);
      let body;
      try {
        const reader = request.body?.getReader();
        const chunks = [];
        let bytesRead = 0;
        if (reader) {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            bytesRead += value.byteLength;
            if (bytesRead > 65536) {
              await reader.cancel();
              return json({ error: "Request too large" }, 413);
            }
            chunks.push(value);
          }
        }
        const bytes = new Uint8Array(bytesRead);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        body = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (Array.isArray(body) || !body || typeof body !== "object")
        return json({ error: "Invalid request" }, 400);
      const response = await rpc(body, env, owner);
      return response === null
        ? new Response(null, { status: 202 })
        : json(response);
    }
    if (url.pathname === "/api/status" && request.method === "GET")
      return json(await call("seedance_connection_status", {}, env, owner));
    if (url.pathname !== "/" || request.method !== "GET")
      return json({ error: "Not found" }, 404);
    const ready = required.every((k) => !!env[k]);
    return new Response(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Seedacne · Dots 视觉创作</title><style>body{margin:0;background:#f5f3ee;color:#222;font:16px system-ui;line-height:1.7}main{max-width:760px;margin:10vh auto;padding:32px}small{color:#766553;letter-spacing:.14em}h1{font-size:44px;line-height:1.2;margin:16px 0}article{background:#fff;padding:28px;border:1px solid #ded9d0;border-radius:16px;margin:24px 0}b{color:#8c482a}li{margin:8px 0}</style><main><small>SEEDACNE × DOTS · ${VERSION}</small><h1>把创作需求，交给视觉 Agent。</h1><p>这是你的私有接入服务。支持文字任务、参考图上传和原会话继续修改。</p><article><b>${ready ? "服务端配置已就绪" : "等待服务端凭据配置"}</b><p>生成调用：${env.GENERATION_ENABLED === "true" ? "已启用，按方舟用量计费" : "尚未启用"}</p><p><a href="/api/status">检查连接与上传配置</a></p></article><article><h2>在 Dots 中使用</h2><ol><li>安装本站对应的私有插件。</li><li>附加参考图，先上传为 reference_id，再描述创作需求。</li><li>继续修改时沿用原 request_id，为本轮设置新的 turn_id。</li><li>查询该轮状态，交付该轮实际产物。</li></ol><p>参考图仅支持 JPEG、PNG、WebP，最大10MiB。附件主机需由服务端明确配置；创建与修改按实际用量计费。</p></article></main></html>`,
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
export { summarize, tools, imageInfo };
