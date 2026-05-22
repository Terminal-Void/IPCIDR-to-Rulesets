# CERNET Rules Worker

一个运行在 Cloudflare Workers 上的 CERNET 规则适配器，用于从上游数据源拉取 CERNET IPv4/IPv6 CIDR，完成清洗、去重、冲突网段排除、格式转换、鉴权和缓存，然后为 MT5000/OpenWrt、OpenClash/Mihomo、Surge 等客户端提供统一规则输出。

## 适用场景

本项目适合以下网络结构：

```text
MT5000 / OpenWrt 主路由
├── WAN：电信 PPPoE，默认 IPv4 出口，提供公网 IPv4 / DDNS / WireGuard Server
├── WAN2：校园网，负责 CERNET IPv4、校园资源、IPv6 NAT6
└── LAN：宿舍内网 / AP / Wi-Fi 客户端
```

目标流量路径：

```text
CERNET IPv4  → 校园网 WAN2
CERNET IPv6  → 校园网 / NAT6
普通 IPv4    → 电信 PPPoE
境外流量      → OpenClash / Mihomo / PassWall2 代理
WireGuard    → 电信公网 IPv4 入站
```

## 功能特性

* 从外部数据源拉取 CERNET IPv4 / IPv6 CIDR
* 支持多个上游源合并
* 支持 IPv4 与 IPv6 分开处理
* 支持整行注释与行尾注释
* 支持纯 CIDR、Surge `IP-CIDR` / `IP-CIDR6` 格式输入
* 支持排除私网、LAN、WireGuard、Clash fake-ip 等冲突网段
* 支持 Token 鉴权，防止规则接口被滥用
* 支持 `Authorization: Bearer`、`X-Auth-Token`、`?token=` 三种鉴权方式
* 支持 Cloudflare KV 保存 last-good 缓存
* 上游失败时返回上一次成功规则，避免路由器拿到空规则
* 输出多种格式：纯 CIDR、Surge、Mihomo/OpenClash YAML、JSON
* 支持 Cron Triggers 定时刷新
* 配置可外置，便于后期调整数据源和排除规则

## 项目结构

```text
.
├── worker.js          # Cloudflare Worker 主程序
├── wrangler.toml      # Wrangler 部署配置
└── README.md
```

## 输出接口

假设 Worker 绑定域名为：

```text
https://rules.example.com
```

所有接口默认需要鉴权。

| 路径                     | 输出格式                 | 用途                                  |
| ---------------------- | -------------------- | ----------------------------------- |
| `/cernet4.txt`         | 纯 IPv4 CIDR          | MT5000/OpenWrt 路由脚本、pbr             |
| `/cernet6.txt`         | 纯 IPv6 CIDR          | IPv6 规则、调试、客户端订阅                    |
| `/cernet.txt`          | IPv4 + IPv6 纯 CIDR   | 通用合并列表                              |
| `/cernet4.surge`       | `IP-CIDR,...`        | Surge IPv4 规则                       |
| `/cernet6.surge`       | `IP-CIDR6,...`       | Surge IPv6 规则                       |
| `/cernet.surge`        | IPv4 + IPv6 Surge 规则 | Surge 合并规则                          |
| `/cernet4.mihomo.yaml` | `payload:` YAML      | OpenClash/Mihomo IPv4 rule-provider |
| `/cernet6.mihomo.yaml` | `payload:` YAML      | OpenClash/Mihomo IPv6 rule-provider |
| `/cernet.mihomo.yaml`  | IPv4 + IPv6 YAML     | OpenClash/Mihomo 合并 rule-provider   |
| `/cernet4.json`        | JSON                 | IPv4 调试信息                           |
| `/cernet6.json`        | JSON                 | IPv6 调试信息                           |
| `/config`              | JSON                 | 当前配置预览                              |
| `/refresh`             | JSON                 | 手动刷新全部规则                            |
| `/health`              | JSON                 | 健康检查                                |

## 鉴权方式

### 1. Authorization Header

推荐给 MT5000/OpenWrt 脚本使用：

```sh
curl -fsSL \
  -H "Authorization: Bearer YOUR_TOKEN" \
  "https://rules.example.com/cernet4.txt" \
  -o /tmp/cernet4.txt
```

### 2. X-Auth-Token Header

```sh
curl -fsSL \
  -H "X-Auth-Token: YOUR_TOKEN" \
  "https://rules.example.com/cernet4.txt"
```

### 3. URL Query Token

适合 OpenClash/Mihomo/Surge 等不方便加 Header 的客户端：

```text
https://rules.example.com/cernet4.mihomo.yaml?token=YOUR_TOKEN
```

注意：URL token 可能出现在客户端日志、代理日志或浏览器历史记录中。能使用 Header 的场景优先使用 Header。

## 部署准备

### 1. 安装 Wrangler

```sh
npm install -g wrangler
```

### 2. 登录 Cloudflare

```sh
wrangler login
```

### 3. 创建 KV Namespace

```sh
wrangler kv namespace create RULES_KV
```

命令会返回类似：

```text
{ binding = "RULES_KV", id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
```

把返回的 `id` 填入 `wrangler.toml`。

## wrangler.toml 示例

```toml
name = "cernet-rules"
main = "worker.js"
compatibility_date = "2026-05-22"

kv_namespaces = [
  { binding = "RULES_KV", id = "YOUR_KV_NAMESPACE_ID" }
]

[vars]
# 可选：外部配置 URL。也可以通过 secret 配置。
# CONFIG_URL = "https://example.com/cernet-config.json"

[triggers]
crons = ["17 */6 * * *"]
```

## 环境变量与 Secret

### 必需变量

| 名称            | 类型     | 说明               |
| ------------- | ------ | ---------------- |
| `AUTH_TOKEN`  | Secret | 单个访问 token       |
| `AUTH_TOKENS` | Secret | 多 token，使用英文逗号分隔 |

`AUTH_TOKEN` 和 `AUTH_TOKENS` 至少配置一个。

配置单 token：

```sh
wrangler secret put AUTH_TOKEN
```

配置多 token：

```sh
wrangler secret put AUTH_TOKENS
```

示例内容：

```text
token-for-router,token-for-openclash,token-for-surge
```

### 可选变量

| 名称            | 类型           | 说明            |
| ------------- | ------------ | ------------- |
| `CONFIG_URL`  | Var 或 Secret | 外部配置 JSON URL |
| `CONFIG_JSON` | Var 或 Secret | 直接写入的 JSON 配置 |

配置优先级：

```text
CONFIG_URL > KV 中的 cernet:config > CONFIG_JSON > Worker 内置默认配置
```

## 外部配置示例

可以把配置 JSON 放在 GitHub Raw、Cloudflare R2、自有服务器，或写入 KV 的 `cernet:config`。

```json
{
  "upstreams": {
    "cernet4": [
      "https://ispip.clang.cn/cernet.txt"
    ],
    "cernet6": [
      "https://ispip.clang.cn/cernet_ipv6.txt"
    ]
  },
  "exclude4": [
    "0.0.0.0/0",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "224.0.0.0/4"
  ],
  "exclude6": [
    "::/128",
    "::1/128",
    "fc00::/7",
    "fe80::/10",
    "ff00::/8"
  ],
  "minCount": {
    "cernet4": 10,
    "cernet6": 1
  }
}
```

### 配置字段说明

| 字段                  | 类型       | 说明                    |
| ------------------- | -------- | --------------------- |
| `upstreams.cernet4` | string[] | IPv4 数据源 URL 列表       |
| `upstreams.cernet6` | string[] | IPv6 数据源 URL 列表       |
| `exclude4`          | string[] | 需要排除的 IPv4 CIDR       |
| `exclude6`          | string[] | 需要排除的 IPv6 CIDR       |
| `minCount.cernet4`  | number   | IPv4 最小有效规则数，低于该值视为异常 |
| `minCount.cernet6`  | number   | IPv6 最小有效规则数，低于该值视为异常 |

## 支持的数据源格式

### 纯 CIDR

```text
1.51.0.0/16
1.184.0.0/15
101.4.0.0/14
2001:250::/30
2001:da8::/32
```

### Surge 格式

```text
IP-CIDR,101.4.0.0/14
IP-CIDR,101.4.0.0/14,no-resolve
IP-CIDR6,2001:da8::/32
IP-CIDR6,2001:da8::/32,no-resolve
```

### 注释

支持整行注释和行尾注释：

```text
# CERNET IPv4
101.4.0.0/14 # CERNET backbone

// CERNET IPv6
2001:da8::/32 // CERNET IPv6

2400:6000::/32 ; comment
```

## OpenClash / Mihomo 配置示例

```yaml
rule-providers:
  cernet4:
    type: http
    behavior: ipcidr
    format: yaml
    url: "https://rules.example.com/cernet4.mihomo.yaml?token=YOUR_TOKEN"
    path: ./rule_provider/cernet4.yaml
    interval: 86400

  cernet6:
    type: http
    behavior: ipcidr
    format: yaml
    url: "https://rules.example.com/cernet6.mihomo.yaml?token=YOUR_TOKEN"
    path: ./rule_provider/cernet6.yaml
    interval: 86400
```

规则顺序建议靠前：

```yaml
rules:
  - RULE-SET,cernet4,DIRECT
  - RULE-SET,cernet6,DIRECT
  - IP-CIDR,192.168.50.0/24,DIRECT,no-resolve
  - IP-CIDR,172.31.250.0/24,DIRECT,no-resolve
  - MATCH,PROXY
```

说明：

* `DIRECT` 只表示不进入代理。
* CERNET 流量实际从哪个 WAN 出口走，还需要 MT5000/OpenWrt 系统路由或 PBR 配合。

## Surge 配置示例

```ini
[Rule]
RULE-SET,https://rules.example.com/cernet4.surge?token=YOUR_TOKEN,DIRECT
RULE-SET,https://rules.example.com/cernet6.surge?token=YOUR_TOKEN,DIRECT
FINAL,PROXY
```

## MT5000 / OpenWrt 使用示例

MT5000 只需要消费 `/cernet4.txt`，然后把这些 CIDR route 到校园 WAN2。

示例脚本片段：

```sh
#!/bin/sh

RULE_URL="https://rules.example.com/cernet4.txt"
TOKEN="YOUR_TOKEN"
CAMPUS_IF="wan2"
ROUTE_PROTO="66"
ROUTE_METRIC="5"
TMP="/tmp/cernet4.txt"
LAST="/etc/cernet/cernet4.last"

mkdir -p /etc/cernet

if curl -fsSL -H "Authorization: Bearer ${TOKEN}" "$RULE_URL" -o "$TMP" && [ -s "$TMP" ]; then
  cp "$TMP" "$LAST"
elif [ -s "$LAST" ]; then
  cp "$LAST" "$TMP"
else
  logger -t cernet-route "no valid rule file"
  exit 1
fi

STATUS="$(ubus call network.interface.${CAMPUS_IF} status 2>/dev/null)" || exit 1
DEV="$(echo "$STATUS" | jsonfilter -e '@.l3_device')"
GW="$(echo "$STATUS" | jsonfilter -e '@.route[@.target="0.0.0.0"].nexthop' 2>/dev/null | head -n1)"

[ -n "$GW" ] || GW="$(ip -4 route show default dev "$DEV" | awk '/default/ {print $3; exit}')"

if [ -z "$DEV" ] || [ -z "$GW" ]; then
  logger -t cernet-route "no dev/gateway for ${CAMPUS_IF}"
  exit 1
fi

ip -4 route flush table main proto "$ROUTE_PROTO" 2>/dev/null

awk -v gw="$GW" -v dev="$DEV" -v proto="$ROUTE_PROTO" -v metric="$ROUTE_METRIC" '
  NF > 0 { print "route replace " $0 " via " gw " dev " dev " proto " proto " metric " metric }
' "$TMP" > /tmp/cernet4.routes

ip -4 -batch /tmp/cernet4.routes

logger -t cernet-route "loaded $(wc -l < /tmp/cernet4.routes) CERNET routes via ${CAMPUS_IF}/${DEV}/${GW}"
```

## 手动刷新

```sh
curl -fsSL \
  -H "Authorization: Bearer YOUR_TOKEN" \
  "https://rules.example.com/refresh"
```

强制刷新并返回指定规则：

```sh
curl -fsSL \
  -H "Authorization: Bearer YOUR_TOKEN" \
  "https://rules.example.com/cernet4.txt?refresh=1"
```

## 失败处理逻辑

Worker 的刷新逻辑如下：

```text
上游成功，且解析出的 CIDR 数量达到 minCount：
  更新 KV last-good
  返回新规则

上游失败：
  KV 中存在 last-good → 返回旧规则，并标记 stale
  KV 中不存在 last-good → 返回错误

上游成功但解析结果太少：
  视为异常
  不覆盖 KV
  有 last-good → 返回旧规则
  无 last-good → 返回错误

未配置 IPv6 上游：
  有 IPv6 last-good → 返回旧规则
  无 IPv6 last-good → 返回错误
```

响应 Header 中会包含：

| Header                | 说明            |
| --------------------- | ------------- |
| `x-cernet-count`      | 当前返回的 CIDR 数量 |
| `x-cernet-updated-at` | 规则更新时间        |
| `x-cernet-from-cache` | 是否来自 KV 缓存    |
| `x-cernet-stale`      | 是否为旧规则兜底      |

## 安全建议

* 不要把 token 提交到 Git 仓库。
* 优先使用 `Authorization: Bearer` 传 token。
* 给路由器、OpenClash、Surge 分配不同 token，便于后续吊销。
* 使用自定义域名，不建议长期依赖 `workers.dev`。
* Worker 输出接口建议只给个人设备和路由器使用，不要公开分享。

## 注意事项

* Worker 只负责规则清洗、转换和分发。
* OpenClash/Mihomo 的 `DIRECT` 只是不走代理，并不决定 WAN 出口。
* MT5000/OpenWrt 仍需要用静态路由、PBR 或脚本把 CERNET IPv4 指向校园 WAN2。
* IPv6 在你的网络中建议直接走校园 NAT6，不必逐条添加 IPv6 系统路由。
* 上游数据源格式变化时，优先修改 Worker 或外部配置，不建议在路由器端堆复杂脚本。

## 推荐部署流程

```text
1. 部署 Worker 和 KV
2. 配置 AUTH_TOKEN / AUTH_TOKENS
3. 配置 CONFIG_URL 或 CONFIG_JSON
4. 访问 /health 测试 Worker 是否在线
5. 访问 /cernet4.json 检查解析数量
6. 访问 /cernet4.mihomo.yaml 接入 OpenClash
7. 访问 /cernet4.txt 接入 MT5000 路由脚本
8. 在 MT5000 上测试 ip route get 101.4.1.1
9. 确认普通 IPv4 仍走电信 PPPoE
10. 确认 IPv6 仍走校园 NAT6
```

## License

MIT
