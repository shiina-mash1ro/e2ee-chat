# E2EE Chat

轻量、无数据库的 Web 端端到端加密临时群聊。

消息、文件和图片均在浏览器内加密，服务端只维护内存中的在线连接并转发密文，不保存聊天记录。客户端优先使用 WebSocket（二进制 MessagePack），不可用时自动回落到 SSE + HTTP，并持续尝试恢复 WebSocket。

## 主要功能

- 完整邀请链接房间：随机房间 ID + 256-bit 房间密钥，密钥保存在 URL fragment 中，不会随 HTTP 请求发送给服务端。
- 群聊码房间：支持随机码、4/6 位数字码，以及 4-32 位 `A-Z`、`2-9` 自定义码。
- 创建房间时可设置最大人数，范围 2-100，默认 4 人（包含创建者）。
- 群聊使用 `XChaCha20-Poly1305`；设备间私发使用 `crypto_box_easy`。
- 支持普通文本、保留换行的多行消息、代码模式、emoji、文件和剪贴板图片。
- 图片可在页面内预览，支持 50%-500% 缩放、滚轮缩放、拖拽移动、双击复位和下载原图。
- 浏览器系统通知可选开启；每条新消息独立通知，包括页面位于前台时。
- “一键鸵鸟”可主动删除当前设备发送的消息，并通知所有在线成员同步清理。
- 关闭标签或窗口后进入 30 秒重连宽限期；超时未恢复时由服务端广播清理该设备的消息。
- 每个标签页保持独立房间、设备和连接状态；刷新会复用当前标签页在该房间的设备 ID。
- WebSocket 回落后无限重试，失败间隔从 5 秒退避至最多 2 分钟；收发消息、恢复联网或页面重新可见会提前唤醒探测。

## 快速开始

要求：Node.js、npm、Go 1.23+。

构建前端：

```bash
cd ui
npm install
npm run build
```

启动服务：

```bash
cd ../server
go run .
```

默认监听 `:8080`。打开：

```text
http://127.0.0.1:8080/
```

开发时可分别启动后端和 Vite：

```bash
# 终端 1
cd server
go run .

# 终端 2
cd ui
npm run dev
```

Vite 会把 `/api` 代理到 `http://127.0.0.1:8080`。

## 房间类型

### 完整邀请链接

示例：

```text
/r/abc123#k=base64url_room_secret
```

`#k=...` 是 URL fragment，只在浏览器本地用于派生房间密钥。复制完整链接给其他人即可加入。

### 群聊码

示例：

```text
/r/TEAM29#p=TEAM29
```

群聊码会作为 `room_id` 被服务端看到，并直接用于派生密钥。短码熵较低，只适合便利性优先的临时场景，不应替代完整邀请链接处理敏感内容。

字母码会自动忽略空格、连字符和下划线，并排除容易混淆的 `0/1/I/L/O`。

## 配置

### 监听地址

```bash
ADDR=0.0.0.0:8080 go run .
```

### 可信代理

只有直连来源 IP 命中 `TRUSTED_PROXIES` 时，服务端才读取 `X-Forwarded-For` 或 `X-Real-IP`：

```bash
TRUSTED_PROXIES=127.0.0.1/32,10.0.0.0/8 ADDR=:8080 go run .
```

Cloudflare 可使用内置快捷值：

```bash
TRUSTED_PROXIES=cloudflare ADDR=:8080 go run .
```

Cloudflare IP 段来自官方 IPv4/IPv6 清单；官方范围变更后应同步更新代码或改用明确的 CIDR 配置。

### 群聊码 PoW

创建或加入群聊码前，浏览器需要完成 SHA-256 PoW。默认难度为 12 个 leading zero bits：

```bash
POW_DIFFICULTY=12 ADDR=:8080 go run .
```

## 安全与功能边界

- 服务端看不到消息、文件和图片明文，但能看到 `room_id`、连接 IP、事件类型、发送方/接收方设备 ID、在线状态、消息大小和发送时间等元数据。
- 完整邀请链接持有者拥有群聊解密能力；任何获得链接的人都可以尝试加入房间，直至达到人数上限。
- 私发消息正文只可由目标设备解密，但发送方和接收方标识属于可见元数据。
- 服务端不保存历史，离线期间不会补发消息；服务重启后在线状态、房间人数配置和断开宽限状态都会丢失。
- 标签页刷新会复用当前房间的设备 ID、Ed25519 签名身份和临时 `crypto_box` 身份；它们仅保存在该标签页的 `sessionStorage` 中。
- “一键鸵鸟”和离开清理只影响当前在线页面中已有的消息副本；无法撤回对方已经复制、下载、截图或在离线页面中保留的内容。
- 群聊内容密钥每 15 分钟或每 100 条群聊消息轮换；采用 prepare/offer/ready/commit 流程，旧 epoch 至少保留 2 分钟以完成在途消息和文件。
- Web E2EE 无法防止服务器向浏览器下发恶意 JavaScript；本项目适合轻量临时通信，不适合高对抗安全场景。

## 传输与协议

客户端首先连接：

```text
GET /api/rooms/{room_id}/ws?client_id=xxx
```

当前只接受协议 v3。WebSocket 使用 MessagePack 二进制帧，公钥、nonce、签名、密文和 sealed key 均保持 MessagePack binary，不转换为 base64，并支持文件分块与逐块确认。连接失败时回落到：

```text
GET  /api/rooms/{room_id}/events?client_id=xxx&connection_token=xxx
POST /api/rooms/{room_id}/messages
```

SSE 输出：

```text
event: message
data: {...json...}

event: ping
data: {}
```

SSE/HTTP 使用 JSON，相同的二进制字段在 JSON 边界使用标准 base64；客户端还原为原始 bytes 后再生成 AAD、HMAC 或签名输入。因此两种传输共享认证语义，但不共享线上二进制表示。

主要事件：

```text
hello
peer_hello
peer_leave
group_msg
private_msg
recipient_ack
chunk
server_ack
chunk_ack
purge_self
leave_room
peer_purge
key_prepare
key_offer
key_ready
key_commit
key_abort
join_key_offer
join_key_ready
device_key_update
```

HTTP 路由：

```text
GET  /
GET  /r/{room_id}
GET  /api/pow-challenge?purpose=code
POST /api/code-room
PUT  /api/code-room
POST /api/rooms/{room_id}/config
GET  /api/rooms/{room_id}/ws?client_id=xxx
GET  /api/rooms/{room_id}/events?client_id=xxx&connection_token=xxx
POST /api/rooms/{room_id}/messages
```

`POST /api/rooms/{room_id}/config` 创建房间配置：

```json
{
  "max_clients": 4
}
```

配置只允许在房间首次连接前设置一次。未显式配置或服务重启后通过旧链接重新进入的房间使用默认值 4。

SSE 的破坏性操作还必须携带与事件流连接匹配的 `X-Connection-Token`，避免仅凭公开设备 ID 冒充其他成员清理消息。

## 服务端限制

- 请求 body 最大 50 MiB；文件经序列化、加密和 base64 后会膨胀。
- WebSocket 模式单文件上限 20 MiB；SSE 兼容模式单文件上限 5 MiB。
- `room_id`：`[A-Za-z0-9_-]`，长度 3-64。
- `client_id`：`[A-Za-z0-9_-]`，长度 8-96。
- 最大人数：2-100，默认 4，按唯一设备 ID 计算。
- 群聊码创建/加入：同一客户端 IP 每分钟最多 3 次。
- PoW challenge 有效期 2 分钟，由服务端无状态校验。
- SSE ping 间隔 25 秒。
- 异常断开后的消息清理宽限期为 30 秒。
- 空房间在最后一个连接离开且清理定时器结束后从内存删除。
- 服务端日志不记录消息 body，只记录房间和事件类型等必要信息。
- CORS 默认关闭，仅支持同源浏览器请求。

## nginx 反向代理

WebSocket 和 SSE 共用 `/api/rooms/`，需要同时允许 Upgrade 并关闭代理缓冲：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

location /api/rooms/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;

    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
}

location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
}
```

## 测试

```bash
cd server
go test ./...

cd ../ui
npm run build
npm run smoke
```

`npm run smoke` 需要本地服务运行在 `http://127.0.0.1:8080`，覆盖完整链接、群聊码、群聊/私发、文件、图片预览与缩放、代码模式、多行消息、SSE 回落恢复、“一键鸵鸟”和多标签房间隔离。

## 部署包

发布包的使用说明见 [`deploy/README.deploy.md`](deploy/README.deploy.md)。
