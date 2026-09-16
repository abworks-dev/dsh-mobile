# Cloudflare 命名隧道（固定公网域名）

内置的 cloudflared 通道有两种模式，在面板 **移动访问 → 远程 → cloudflared → 隧道类型** 中切换：

| | 快速隧道（默认） | 命名隧道 |
| --- | --- | --- |
| 账号 | 不需要 | 需要 Cloudflare 账号 |
| 地址 | 每次启动随机分配 `*.trycloudflare.com` | 你自己域名下的固定主机名 |
| 重启后 | 地址变化，需要重新扫码 | 地址不变，已配对设备继续可用 |
| 可用性 | 官方定位为测试用途：有限流、无可用性保证 | 由你的 Cloudflare 账号承载 |
| 配置项 | 无 | 连接器令牌、公网域名、本机转发端口 |

命名隧道的公网域名由 Cloudflare 负责解析与 TLS，插件只负责在本机运行 `cloudflared` 并把流量交给已认证的私有网关；**手机端仍然要走 App 的远程访问扫码流程**，隧道不改变配对方式。

## 前置条件

1. 一个已接入 Cloudflare 的域名（该域名的 NS 必须指向 Cloudflare 分配的名称服务器，在域名注册商处修改；改完通常几分钟到 24 小时生效）。
2. Cloudflare Zero Trust（团队域名）已启用——隧道控制台位于其中。
3. 面板中 cloudflared 组件已安装（命名隧道和快速隧道使用同一个官方客户端）。

## 在 Cloudflare 控制台创建隧道

1. 打开 **Zero Trust → Networks → Tunnels**，选择 **Create a tunnel**，类型选 **Cloudflared**。
2. 命名（例如 `dsh-mobile`），保存后会显示 connector 安装命令。
3. 在 **Public Hostname** 页签添加一条：
   - Subdomain：`dsh`，Domain：选你的域名（得到 `dsh.example.com`）
   - Service：**HTTP** → `127.0.0.1:3444`
4. 回到 **Overview** 页签复制连接器令牌（一长串以 `eyJ` 开头的字符串）。令牌里已经包含账号、隧道 ID 和隧道密钥，**等同于密码**。

> `127.0.0.1:3444` 就是面板里的「本机转发端口」。Cloudflare 把公网主机名固定转发到这个端口，所以它必须与面板中填写的端口一致，并且长期不变。

## 在 DSH Mobile 面板中填写

1. **移动访问 → 远程 → cloudflared**。
2. 隧道类型选 **命名隧道**。
3. 依次填写：
   - **公网域名**：`dsh.example.com`
   - **本机转发端口**：`3444`（与第 3 步的 Service 端口一致）
   - **连接器令牌**：粘贴上一步复制的令牌
4. 点击 **保存并连接**。

已保存后令牌输入框留空表示不更改；输入框里不会再回显已保存的令牌。「移除已保存的令牌」会把配置改回快速隧道。

## 安全边界

- 令牌只写入 DSH Mobile 私有目录（`~/.dsh/mobile-access/remote/cloudflared/tunnel.json`，权限 0600），并且**只**通过子进程环境变量 `TUNNEL_TOKEN` 传给 `cloudflared`，不出现在命令行里（本机任何进程都能读到命令行）。
- 令牌从不回传给浏览器或手机端；面板状态里只有「是否已配置」、域名和端口。
- 隧道背后是 DSH Mobile 自己的认证网关：公网主机名只暴露该网关，DSH 本体仍然需要配对设备凭据。
- 插件不会创建系统服务、开机启动项、注册表项或 PATH 项；关闭通道即结束进程。

## 错误码

| 面板提示 | 实际错误码 | 含义与处理 |
| --- | --- | --- |
| 本机转发端口不可用 | `cloudflared_tunnel_port_unavailable` | 配置的端口已被占用。命名隧道不能改用其他端口（Cloudflare 固定转发到该端口），请释放端口或换一个端口并同步修改 Cloudflare 的 Service。 |
| 公网域名无效 | `cloudflared_tunnel_hostname_invalid` | 必须是本账号下域名的真实主机名；不接受 IP、通配符、`.trycloudflare.com` 与 `.cfargotunnel.com`。 |
| 转发端口无效 | `cloudflared_tunnel_port_invalid` | 端口需在 1024–65535 之间。 |
| 令牌无效 | `cloudflared_tunnel_token_invalid` | 令牌需从控制台完整复制，不能有空格或换行。 |
| 设置未通过校验 | `cloudflared_tunnel_settings_invalid` | 请求里带了不该有的字段（例如快速隧道模式下携带端口）。 |
| 需要同时填写令牌、域名和端口 | `cloudflared_tunnel_config_missing` | 首次配置命名隧道时三项都必填。 |
| 已保存配置无法读取 | `cloudflared_tunnel_config_invalid` | 配置文件损坏或不符合格式；插件会退回快速隧道，重新保存即可。 |
| 等待公网地址超时 | `cloudflared_start_timeout` | connector 在 60 秒内没有打印 `Registered tunnel connection`。常见原因是网络到 Cloudflare 边缘不通。 |

## 排错

- **连接一直停在「正在连接」**：命名隧道没有横幅，只有 connector 真正注册后才算就绪。查看 DSH 日志里 cloudflared 的输出；预检表（`CONNECTIVITY PRE-CHECKS`）会指出是 DNS、UDP/QUIC 还是 TCP 不通。
- **公网访问返回 1033**：Cloudflare 认为该主机名没有健康的 connector。确认隧道在 Zero Trust 里显示 Healthy，且 ingress 指向的端口与面板一致。
- **`cloudflared` 报 `Unauthorized` 或隧道 ID 不存在**：令牌与控制台里的隧道不匹配（例如隧道被删除后重建）。重新复制令牌。
- **本机开着 TUN/透明代理（如 Clash、Mihomo）时连接不稳**：`cloudflared` 走 QUIC/UDP，fake-IP 和透明代理容易让长连接被重置。建议对 `*.argotunnel.com`、`*.trycloudflare.com`、`api.cloudflare.com` 走直连。
- **域名解析还是旧地址**：改完 NS 后 Cloudflare 需要把 zone 从 Pending 变为 Active；A/CNAME 在 zone 激活前不会对外生效。
