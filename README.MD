# CERNET Rules Worker

# 开发中，功能未完全实现

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

## 真实部署流程（Cloudflare Workers + GitHub 公开仓库）

这一节适合：你想把项目放在 GitHub 公开仓库，然后在 Cloudflare Dashboard 里连接仓库自动部署，同时让 Cloudflare 首次部署时自动创建 KV 绑定。

核心原则：

```text
公开仓库里可以放：worker.js、README.md、package.json、wrangler.toml
公开仓库里不要放：AUTH_TOKEN、AUTH_TOKENS、私有 CONFIG_URL、Cloudflare API Token
KV 可以让 Cloudflare 自动创建；token 必须在 Cloudflare Dashboard 里配置为 Secret
```

### 1. 推荐仓库结构

```text
cernet-rules-worker/
├── worker.js
├── package.json
├── wrangler.toml
├── README.md
└── .gitignore
```

### 2. package.json

```json
{
  "name": "cernet-rules-worker",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "deploy": "wrangler deploy",
    "dev": "wrangler dev"
  },
  "devDependencies": {
    "wrangler": "^4.0.0"
  }
}
```

### 3. wrangler.toml：自动创建 KV 版本

这是最适合 GitHub 公开仓库的写法：

```toml
name = "cernet-rules"
main = "worker.js"
compatibility_date = "2026-05-22"
workers_dev = true

# 可选：公开配置 URL 可以写这里；不想公开就不要写，改到 Dashboard 里设 Secret。
# [vars]
# CONFIG_URL = "https://example.com/cernet-config.json"

# 声明需要哪些 Secret。这里只是声明名称，不会把 secret 值写进仓库。
[secrets]
required = ["AUTH_TOKEN"]

# 自动 provisioning：不写 id。首次 deploy 时 Cloudflare 会自动创建 KV namespace。
[[kv_namespaces]]
binding = "RULES_KV"

[triggers]
crons = ["17 */6 * * *"]
```

重点：

```text
[[kv_namespaces]]
binding = "RULES_KV"
```

这里故意不写 `id`。Wrangler/Cloudflare 会在部署时自动创建 KV 资源。

如果你从 Dashboard 连接 GitHub 仓库部署，Cloudflare 会创建资源，但生成的 KV id 不会自动回写到 GitHub 仓库；以后仍然可以继续使用这个项目，因为绑定已经存在于 Cloudflare Worker 配置里。

### 4. GitHub 仓库里不要提交这些文件

`.gitignore` 建议：

```gitignore
node_modules
.wrangler
.dev.vars
.env
*.log
```

### 5. 在 Cloudflare Dashboard 从 GitHub 创建/连接项目

推荐流程：

```text
Cloudflare Dashboard
→ Workers & Pages
→ Create / Import from Git
→ 选择 GitHub 仓库
→ 选择项目根目录
→ Build command: npm ci
→ Deploy command: npx wrangler deploy
```

如果 Dashboard 只让你填一个构建命令，可以用：

```sh
npm ci && npx wrangler deploy
```

注意：Worker 名称必须和 `wrangler.toml` 里的 `name = "cernet-rules"` 一致。否则连接现有 Worker 或构建部署时可能失败。

### 6. 在 Cloudflare Dashboard 配置 Secret

部署前或部署后，在 Worker 项目的设置里添加 Secret：

```text
AUTH_TOKEN = 一个强随机 token
```

如果你要多个 token：

```text
AUTH_TOKENS = token-for-router,token-for-openclash,token-for-surge
```

如果你的配置 URL 不想公开，也可以把它设为 Secret：

```text
CONFIG_URL = https://private.example.com/cernet-config.json
```

`wrangler.toml` 里的 `[secrets] required = ["AUTH_TOKEN"]` 只声明必须存在这个 Secret，不包含实际值。

### 7. 部署后验证

```sh
export BASE="https://cernet-rules.YOUR_SUBDOMAIN.workers.dev"
export TOKEN="你的 token"

curl -fsSL -H "Authorization: Bearer $TOKEN" "$BASE/health"
curl -fsSL -H "Authorization: Bearer $TOKEN" "$BASE/cernet4.json" | head
curl -fsSL -H "Authorization: Bearer $TOKEN" "$BASE/cernet4.txt" | head
curl -fsSL -H "Authorization: Bearer $TOKEN" "$BASE/cernet4.mihomo.yaml" | head
```

### 8. 如果你想更可复现：手动创建 KV 并提交 id

自动创建 KV 很方便，但它是隐式资源。如果你希望仓库配置完全可复现，可以本地手动创建 KV：

```sh
npx wrangler kv namespace create cernet-rules-kv --binding RULES_KV --update-config
```

然后 `wrangler.toml` 会变成：

```toml
[[kv_namespaces]]
binding = "RULES_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

这个 `id` 不是密钥，可以提交到仓库。只有 token、API key、私有配置 URL 这类值才需要保密。

### 9. 两种部署方式如何选择

| 方式             | wrangler.toml 写法     | 优点           | 缺点                     |
| -------------- | -------------------- | ------------ | ---------------------- |
| GitHub 自动创建 KV | 只写 `binding`，不写 `id` | 最适合公开仓库，一键导入 | KV id 不会回写到仓库，资源较隐式    |
| 手动创建 KV 后提交 id | 写 `binding` + `id`   | 最可复现，换机器部署清晰 | 需要先本地运行 Wrangler 创建 KV |

个人使用推荐先用“GitHub 自动创建 KV”。项目稳定后，如果你想更规范，再改成手动创建 KV 并提交 `id`。

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
