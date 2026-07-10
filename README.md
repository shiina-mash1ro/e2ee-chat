# E2EE Chat

极轻量 Web 端端到端加密临时群聊。后端只维护内存中的 SSE 连接并广播 JSON 密文，不保存消息，不使用数据库，不使用 WebSocket。

## 运行

安装前端依赖并构建静态文件：

```bash
cd ui
npm install
npm run build
```

启动 Go 服务：

```bash
cd ../server
go run .
```

默认监听 `:8080`，也可以用环境变量修改：

```bash
cd server
ADDR=:8080 go run .
```

如果部署在 nginx 或其他反代后面，并且需要按真实客户端 IP 限制群聊码请求，配置可信代理 CIDR：

```bash
cd server
TRUSTED_PROXIES=127.0.0.1/32,10.0.0.0/8 ADDR=:8080 go run .
```

只有请求的直连来源 IP 命中 `TRUSTED_PROXIES` 时，服务端才会读取 `X-Forwarded-For` 或 `X-Real-IP`；否则忽略这些头，避免客户端伪造 IP。

Cloudflare 可以使用内置快捷值：

```bash
cd server
TRUSTED_PROXIES=cloudflare ADDR=:8080 go run .
```

Cloudflare IP 段来自官方 `https://www.cloudflare.com/ips-v4` 和 `https://www.cloudflare.com/ips-v6` 清单。若 Cloudflare 更新 IP 段，应同步更新代码或改用外部配置。

群聊码创建/加入还需要浏览器完成 PoW。默认难度为 12 个 SHA-256 leading zero bits，可调整：

```bash
cd server
POW_DIFFICULTY=12 ADDR=:8080 go run .
```

打开 `http://127.0.0.1:8080/` 创建房间。创建后的 URL 类似：

```text
/r/abc123#k=base64url_room_secret
```

`#k=...` 是 URL fragment，不会发送给服务器。复制完整链接给其他浏览器窗口即可加入同一房间。

首页也可以创建随机群聊码、输入自定义群聊码，或用已有群聊码加入。群聊码兼容旧的 4/6 位数字码；自定义字母码支持 4-32 位 `A-Z` 和 `2-9`，会自动忽略空格、连字符、下划线，并排除容易混淆的 `0/1/I/L/O`。群聊码模式的 URL 类似：

```text
/r/TEAM29#p=TEAM29
```

群聊码模式只适合内网临时测试：码本身会作为 `room_id` 被服务端看到，短自定义码熵较低，不能替代完整邀请链接模式。

开发前端时可以同时运行：

```bash
cd server
go run .
cd ../ui
npm run dev
```

Vite 开发服务器会把 `/api` 请求代理到 `http://127.0.0.1:8080`。

## 功能边界

- 群聊消息使用浏览器端 `XChaCha20-Poly1305` 加密。
- 群内私发使用浏览器端 `crypto_box_easy`，发送方临时私钥和接收方临时公钥加密。
- 进入房间时可以设置显示名称，也可以在房间内修改；显示名称通过 `hello` / `peer_hello` 事件广播，属于服务端可见元数据。
- 输入框支持常用 emoji 快速插入。
- 支持发送图片和文件，也支持把剪贴板图片直接粘贴到消息框。文件在浏览器端读入并随消息一起加密，服务端不保存文件；当前单文件上限为 20 MiB。
- 服务端看不到消息明文，只处理 `room_id`、事件类型、发送方、接收方等元数据和密文。
- 服务端能看到 room_id、连接 IP、在线状态、消息大小、发送时间。
- 群聊消息所有持有完整邀请链接的人都能解密。
- 群聊码模式是便利功能，不适合敏感内容；完整邀请链接模式仍是默认推荐。
- 私发消息只有目标设备能解密，但 `from` / `to` 元数据对群内成员可见。
- 不保存消息，离线不会收到历史消息。
- 刷新页面会生成新的 device_id 和私钥，旧的私聊密钥会失效。
- 谁拿到邀请链接，谁就能加入房间。
- 不支持踢人后的密钥隔离。
- Web E2EE 无法防止服务器给用户下发恶意 JavaScript；适合轻量临时通信，不适合高对抗安全场景。

## HTTP 接口

```text
GET  /
GET  /r/{room_id}
GET  /api/rooms/{room_id}/events?client_id=xxx
POST /api/rooms/{room_id}/messages
POST /api/rooms/{room_id}/config
```

SSE 输出：

```text
event: message
data: {...json...}

event: ping
data: {}
```

支持事件类型：

```text
hello
peer_hello
group_msg
private_msg
purge_self
leave_room
peer_purge
```

## 后端限制

- POST body 最大 50 MiB。20 MiB 原始文件经 JSON、加密和 base64 后会明显膨胀。
- `room_id` 只允许 `[a-zA-Z0-9_-]`，长度 3 到 64。
- `client_id` 只允许 `[a-zA-Z0-9_-]`，长度 8 到 96。
- 创建或加入群聊码按客户端 IP 限制为每分钟 3 次。
- 创建或加入群聊码需要 PoW，有效期 2 分钟，服务端无状态校验 challenge。
- 创建房间时可设置最大人数（2-100，默认 4，包含创建者）；服务端按唯一设备 ID 执行限制。
- SSE ping 间隔 25 秒。
- 回落到 SSE 后会持续尝试恢复 WebSocket，失败间隔从 5 秒退避到最多 2 分钟；收发消息、恢复联网或页面重新可见会提前唤醒探测。
- 空 room 在最后一个 client 离开后删除。
- 连接异常断开后保留 30 秒重连宽限期；超时会广播 `peer_purge`，要求在线客户端删除该设备发送的消息。
- SSE 连接需要独立的 `connection_token`，破坏性操作同时校验设备 ID 与连接令牌。
- 不记录消息 body，日志只记录 room_id 和事件类型。
- CORS 默认关闭，只允许同源浏览器请求。

## nginx 反代

```nginx
location /api/rooms/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;

    proxy_buffering off;
    proxy_cache off;

    proxy_set_header Connection '';
    proxy_read_timeout 1h;
}

location / {
    proxy_pass http://127.0.0.1:8080;
}
```
