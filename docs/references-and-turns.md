# 参考图与原会话多轮修改

v0.2 在原来的私有 Sites MCP 上增加参考图和多轮工具，沿用原插件。仅限自己账号与已授权素材；单独创建新的插件或改为公开服务都不是升级步骤。

## 1. 配置文件下载来源

上传工具按 [OpenAI File APIs](https://developers.openai.com/plugins/reference#file-apis) 使用 `_meta["openai/fileParams"]: ["file"]`。宿主负责让用户选择附件并传入临时下载地址。支持文件参数的本地宿主也可能把本机文件路径自动上传并改写；远程 Worker 本身不能读取本机路径。

原始 MCP 文件对象的字段为 `download_url`、`file_id`，以及可选的 `mime_type`、`file_name`。不要把本地路径手动塞进 `download_url`，不要在聊天里粘贴签名链接。

官方未公布固定下载 hostname 或统一有效期。本模板初始 `REFERENCE_ALLOWED_HOSTS` 留空，拒绝未知来源。首次通过实际宿主传附件，错误只显示下载 hostname；核验来源后，把精确主机名加入服务端配置，例如 `files.example.org`，多个用逗号分隔，重新部署应用配置。此值不得包含完整 URL、签名查询串、通配符或凭据。

下载仅允许 HTTPS、允许名单主机及默认端口，拒绝 IP、localhost、重定向和超限内容；请求不携带方舟 Key 或 Sites 凭据。文件限制为 JPEG、PNG、WebP，最多 10 MiB/图，检查实际格式与尺寸。文件临时 URL 不进入持久账本。过期时重新选择附件，由宿主提供新的授权下载地址。不同附件可能由不同区域的下载 hostname 提供；出现新域名时核验并追加到本实例的精确名单，不用另建插件、换 Key 或换生成任务号。

## 2. 上传与首次创作

1. 向 Dots 附上参考图并说明该图用于本次创作。
2. Dots 调用 `seedance_upload_reference`，为这张图设置稳定 `reference_id`。
3. 通过 `seedance_get_reference` 确认上传状态；上传本身不启动素材生成。
4. 新建任务时调用 `seedance_create_task`，传根 `request_id`、`prompt`、`output_kind` 及 `reference_ids` 数组，每轮最多 6 张。
5. 服务把图片挂载进新 Session，并将挂载响应的文件 ID 作为 `image` 内容块传给模型。挂载 ID 可能不同于原上传 ID，不能自行替换。

给 Dots 的示例：

```text
请把我附的商品图上传到已连接的 Seedance Managed Agent 私有服务，用稳定 reference_id 记录。先确认上传完成，不开始生成。
```

已确认具体生成需求与费用范围后再发：

```text
请用刚上传的参考图制作一张 9:16 产品海报。保留杯型、杯盖和标签位置，背景改成浅米色石台与自然窗光，不新增文字和 Logo。只做一版。
新建根任务 request_id=product_poster_demo_001，传入刚才的 reference_ids。提交结果不明时查询同一任务，不自动重新生成。交付实际文件并如实指出偏差。
```

## 3. 在原 Session 继续修改

```text
继续修改 product_poster_demo_001 的现有会话。用新的稳定 turn_id=poster_edit_001，调用 seedance_continue_task，保持原 request_id 和 Session。
只把背景改成浅绿色，保留杯型、标签、构图和窗光。只做这次修改，不另建任务、不自动重做。交付本轮实际文件，说明保留项是否真的保持。
```

每次新的修改用新的 `turn_id`；同一轮的重查/网络重试保持原编号与同一输入。新的参考图也可先上传，再在该轮传 `reference_ids`。不重复附图时，由原 Session 上下文和已有挂载保留先前素材。

上一轮必须结束，且 Session 可接受新输入。运行中、需要工具确认、已终止或提交结果不明时，先查询原轮；不能换编号或新建会话绕过。同一任务的不同轮并发提交会被持久锁拦截。

`seedance_get_task` 与 `seedance_get_outputs` 接受可选 `turn_id`，默认查询最新轮。查询旧轮时显式指定该轮编号。服务按本轮受理事件与事件边界判断状态，以产物快照和唯一输出路径区分文件；没有明确归属时不把旧文件当新结果。文件注册仍可能延迟。

## 4. 升级已有部署

保留原 `project_id`、访问范围、密钥、`jobs` 数据和插件。按序应用 `drizzle/` 所有迁移，新迁移追加账本表，不改已应用 SQL。完成测试、构建和私有部署后，Sites 会刷新同一插件的工具表；若宿主仍缓存旧表，按当前插件刷新入口处理，再检查是否出现三个新工具。

| 新工具 | 行为 |
|---|---|
| `seedance_upload_reference` | 从宿主选定附件下载并上传方舟，持久防重 |
| `seedance_get_reference` | 查询本用户参考图状态 |
| `seedance_continue_task` | 在根任务的原 Session 提交一轮修改 |

0.2.1 对一种已确证的提交前失败提供恢复：仅当原轮从未持久记录任何消息发送边界、原 Session 为 idle 且完整历史没有 user.message 时，返回 `recoverable_before_submission=true`。此时可用完全相同参数再次调用 create_task，服务原子领取恢复权并复用原 Session；不是换编号或重建。已尝试发送、结果不明的失败继续禁止重发。

旧的无参考图新建任务及历史查询继续兼容。音频/视频参考上传、结构化的时长/分辨率参数、完整的 Agent 权限交互并不在本次实现范围；不能宣称上游全部能力已解锁。

## 官方协议依据

- [方舟上传并挂载文件](https://docs.volcengine.com/docs/ark/upload-and-mount-files?lang=zh)：`POST /files`，`purpose=agent`，以及挂载机制。
- [添加会话资源](https://docs.volcengine.com/docs/ark/add-resource-api?lang=zh)：挂载响应文件 ID 与只读资源。
- [Session 事件流](https://docs.volcengine.com/docs/ark/session-event-stream?lang=zh)：SSE ready、多模态内容和逐轮结束条件。
- [连续对话](https://docs.volcengine.com/docs/ark/build-triage-agent-with-continuous-session?lang=zh)：复用原 Session。
- [文件列表](https://docs.volcengine.com/docs/ark/list-files-api?lang=zh)：Session 输出筛选与 `after` / `has_more` 分页。

本地检查、插件工具刷新、真实附件上传、原 Session 修改和视觉质量分别记录。实际验证状态见 [验证记录](validation-v0.2.md)。
