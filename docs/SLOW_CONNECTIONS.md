# 慢速链路与反复重连

[English](SLOW_CONNECTIONS.en.md)

远程页面能打开、`/mobile-access/health` 返回正常，仍可能出现“重连中”、模型或工作区迟迟不显示。HTTP 可达只说明请求能通过；DSH 的实时数据还需要 WebSocket 连接完成初始化并保持在线。

## 先判断重连发生在哪一步

先记录 DSH、DSH Mobile 插件和 Android App 的版本，再在电脑端 **移动访问 → 连接诊断** 检查当前通道；查看 DSH 启动日志和浏览器开发者工具的 Network → WS，按问题涉及的组件更新。插件与 App 独立发版，版本号不必相同。分享日志时去掉 Token、Cookie 和完整配对地址。

- **WebSocket 没有连接成功**：检查请求是否获得 `101 Switching Protocols`，并留意 `401`、`403`、`404`、`502` 等错误。认证、Host/Origin、反向代理升级支持、连接路径或版本差异都可能造成这种情况。调整心跳不能解决这些问题；第三方插件被拦截的路径可在连接诊断中按需允许，不必把 DSH 内置路径全部重新添加。
- **已获得 101，但连接反复关闭**：记录关闭间隔，并对比同一页面、同一会话的局域网与远程访问。如果只在远程打开长会话时频繁断开，同时下载长时间占满链路，才进一步检查下面的心跳和初始化等待时间。浏览器显示 `1006` 表示连接异常结束，本身不能确定是哪一层断开。
- **初始化等待超时**：若控制台出现 `connection generation was not ready within 15000ms`，说明该次实时连接没有在等待期限内完成初始化。除了慢速传输，还要排查服务端错误、代理阻断及未完成的数据订阅。

[#126](https://github.com/saya-ch/dsh-mobile/issues/126) 和 [#146](https://github.com/saya-ch/dsh-mobile/issues/146) 都报告过“HTTP 正常但实时连接重连”，它们不能仅凭界面文案判定为同一个原因。

## 慢速传输可能超过默认等待时间

DSH 0.2.0-rc.2 的 API 网关默认每 **2 秒**发送一次 WebSocket Ping，连续两次未收到 Pong 后会结束连接，实际容忍时间约为 **4–6 秒**。客户端另有 **15 秒**的实时连接初始化期限。较大的会话数据、低速上行或拥塞可能延迟 Pong 或首次数据同步，触发断开和重新同步。

在 #146 的部署中，反馈者测量到约 2.18 MiB 的会话窗口与 2.68 Mbps 上行，并报告增大这两个时间后重连减少。这是该部署的观测结果，传输大小和改善程度取决于会话、插件及网络，不能作为通用性能保证。

## 按需增加两个 DSH 参数

确认是上述慢速链路后，可先试 **30 秒心跳间隔**和 **120 秒初始化等待**。这两个参数属于 DSH 已有插件配置，不是 DSH Mobile 的 `upstreamTimeoutMs`；后者不能改变 DSH 的心跳或客户端初始化期限。

在电脑端找到当前 profile 中已启用的 `@deepseek-ai/dsh-api-gateway` 与 `@deepseek-ai/dsh-client-connection` 条目。如果当前 DSH 提供相应配置编辑入口，修改其已有配置；没有入口时，先备份当前 profile 的 `cordis.patch.yml`，再编辑这个文件。命令行 Web 通常使用 `$DSH_HOME/profiles/web/cordis.patch.yml`，官方 Desktop 默认使用 `$DSH_HOME/profiles/desktop/cordis.patch.yml`；自定义 profile 以实际运行配置为准。

下例适用于 DSH 0.2.0-rc.2 的标准 Web/官方 Desktop 组装，现有条目 ID 分别为 `typert-gateway` 和 `connection`。先确认自己的条目 ID；同一个 ID 已有覆盖项时，修改它的 `config`，不要重复插入插件。

```yaml
- id: typert-gateway
  config:
    websocketHeartbeatIntervalMs: 30000

- id: connection
  config:
    trustedHosts: !!js ctx.webRuntime.trustedHosts
    recovery:
      generationReadyTimeoutMs: 120000
```

**Patch 会替换目标条目的整个 `config`。** 以上仅展示标准配置需要保留的可信 Host 表达式与两个调整项；若已有自定义 `trustedHosts`、Cookie 有效期、请求大小、`streamInboxBytes` 或其他 `recovery` 参数，须一并保留。把修改合入原文件的顶层 YAML 列表，保留其他条目；不要用示例覆盖整个文件或修改 `node_modules`。

保存后重启当前 DSH 实例，并重新打开手机页面，让页面取得新的客户端恢复参数。若启动提示条目不存在或字段不支持，恢复备份，核对当前 DSH 版本和配置；不同版本或自定义组装不要直接套用本例。

## 调整后检查效果

重新打开原先会反复重连的会话，比较连接持续时间、重连次数和实际传输量。30 秒心跳会让真正失联的发现变慢，120 秒初始化期限也会让失败连接等待更久；如果没有改善，恢复原值并继续定位，不要无限放大等待时间。通道带宽不会因延长时间而增加，也不能修复认证、代理或服务端故障。

参数与默认值已按 DSH 0.2.0-rc.2 核对：[API 网关配置与心跳实现](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.2/packages/api/gateway/src)、[客户端恢复配置](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/client/connection/src/recovery-config.ts)、[标准 Web 条目](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/bundle/web-app/cordis.patch.yml)。

## 可选的 WebSocket 压缩

从 DSH Mobile 0.5.4 起，可以为指定的实时连接路径启用压缩。它适合带宽有限、计量网络或会话数据较大的场景，以额外 CPU 和内存开销换取较少的传输量；默认路径列表为空，仍使用原来的无压缩转发。

在当前 `mobile-access` 条目的已有 `config` 中加入下面这段属性；这是**配置片段，不是完整 profile patch**。保留该条目已有的网卡、证书、配对状态与管理设置，不要用这个片段替换整个 `config`。

```yaml
websocketCompression:
  paths:
    - /api/remote.mux
```

`/api/remote.mux` 是当前 DSH 的主要实时数据路径。这里只选择要压缩的**准确路径**，不会新增访问权限；设备认证、Host/Origin 与 WebSocket 放行规则仍需通过。社区插件的路径若需要压缩，应先确认并通过连接诊断放行，再加入这个列表。压缩只在手机／浏览器与移动网关之间协商，与 DSH 之间仍不压缩；每条消息不复用先前消息的压缩字典。网关转发两端真实的 Ping/Pong，不另设心跳，也不会因此修改上文的 DSH 等待时间。

以下可选字段与 `paths` 同级，通常保持默认即可：

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `maxMessageBytes` | `33554432`（32 MiB） | 单条解压后消息的上限；超过时结束该连接 |
| `maxQueuedBytes` | `67108864`（64 MiB） | 每个转发方向的待发送数据与帧头上限；至少覆盖消息上限加 14 字节帧头 |
| `thresholdBytes` | `1024` | 向手机／浏览器发送消息时，小于此大小不尝试压缩 |
| `concurrencyLimit` | `4` | 压缩任务并发上限；`ws` 在当前进程首次建立压缩连接时确定这个共享上限，改动后重启 DSH |
| `level` | `3` | 压缩等级（0–9）；提高可能增加 CPU 开销 |

修改后重启 DSH 并重新打开手机页面。可在开发者工具中查看 WebSocket 握手是否协商了 `permessage-deflate`；客户端没有协商时仍可无压缩连接。对比同一会话的实际通道传输量与 CPU 使用，不能仅以开发者工具显示的解压后消息长度判断节省比例。需要关闭时把 `paths` 改回 `[]`；压缩不能提高服务商限额，也不能替代连接故障排查。

## 手动压缩会话与长时间 API 请求（0.6.0）

手机发出的 `/compact` 等命令要通过移动网关的 HTTP API；DSH 内部触发的自动压缩不经过这次网关请求。旧版网关对所有上游代理请求都使用默认 30 秒的 `upstreamTimeoutMs`，因此模型仍在生成摘要时，手动压缩可能先收到 `502 upstream_unavailable`。[#171](https://github.com/saya-ch/dsh-mobile/issues/171) 记录了这一情况。

当前网关区分传输等待和已鉴权 API 的响应等待。`upstreamTimeoutMs` 仍默认 30000 毫秒（1000–300000），用于上传、静态资源、启动资源和 WebSocket 握手的等待；请求头另有既有的 10 秒接收期限。只有完成设备鉴权、Host/Origin 与必要 CSRF 检查的 `/api` 和 `/api/…` HTTP 请求，在请求体发往 DSH 后切换到 `upstreamApiTimeoutMs`。新字段默认 `0`，表示不对 API 响应施加空闲超时；需要限制时，可配置为 `1–2147483647` 的整数毫秒，范围上限来自 Node 定时器的表示范围。这不是整个操作的总执行期限：持续到达的响应数据会重置空闲计时。

以下属性放进现有 `mobile-access` 条目的 `config`，并保留其他配置；这是配置片段，不是完整的 profile 补丁。`0` 是默认值，示例为 API 响应设置 10 分钟的空闲等待期限：

```yaml
upstreamApiTimeoutMs: 600000
```

保存后重启 DSH。设备/会话失效、撤销、调用方断开或网关关闭仍会中止代理请求；上传大小、上传等待、连接数、并发请求数和 CSRF 限制不因 `0` 而关闭。隧道、反向代理或模型服务商自己的期限仍可能提前结束请求；该字段也不会改变前文的 WebSocket 心跳或初始化设置。

普通 HTTP 代理请求在尚未发送响应头时，移动网关自己的上游超时返回 `504 {"error":"upstream_timeout"}`；一般连接失败仍为 `502 upstream_unavailable`。若流已经开始，则只能关闭连接，不能再发送第二份 HTTP 状态。网关不会自动重试 API 请求。超时或断开仅表示调用方停止等待，不保证 DSH 或模型任务已经停止，也不会撤销已经发生的副作用；重试操作前先检查实际会话结果。
