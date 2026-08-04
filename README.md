# E2EE Chat 部署

本文件只保留部署说明。发布包的完整服务器安装与升级步骤见 [`deploy/README.deploy.md`](deploy/README.deploy.md)。

## 构建

要求 Node.js、npm 和 Go 1.23+。

```bash
cd ui
npm ci
npm run build:all

cd ../server
go build -trimpath -o e2ee-chat .
```

前端产物会写入 `server/static/`，扩展产物会写入 `dist/extension/`。GitHub Release workflow 会生成：

- `e2ee-chat-deploy.zip`
- `e2ee-chat-deploy.tar.gz`
- `e2ee-chat-extension.zip`

## 启动服务

```bash
cd server
ADDR=127.0.0.1:8080 ./e2ee-chat
```

可用环境变量：

- `ADDR`：监听地址，默认 `:8080`。
- `TRUSTED_PROXIES`：可信反向代理 CIDR，逗号分隔；也可使用 `cloudflare`。
- `POW_DIFFICULTY`：群聊码创建和加入的 PoW 难度，默认 12。
- `EXTENSION_ORIGINS`：允许跨域访问 API 的扩展 origin，逗号分隔，例如 `chrome-extension://扩展ID`；不接受普通 HTTP(S) origin。

生产环境建议使用部署包中的 systemd 服务和升级脚本，具体命令见 [`deploy/README.deploy.md`](deploy/README.deploy.md)。

## Nginx

TLS 在 Nginx 终止；Go 服务只监听本机地址。WebSocket 和 SSE 共用 `/api/rooms/`，需要允许 Upgrade 并关闭代理缓冲：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name chat.example.com;

    location /api/rooms/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
}
```

HSTS 由 Nginx 返回。CSP、`X-Content-Type-Options`、Referrer Policy 和 Permissions Policy 由 Go 服务返回，不要在 Nginx 重复设置。

## Chrome / Edge 扩展发布

扩展包不包含默认聊天服务域名。安装后必须填写并验证 HTTPS 服务 origin，服务端需提供 `/api/extension-info`。

本地加载：

```bash
cd ui
npm ci
npm run build:extension
```

随后在 Chrome 或 Edge 的扩展管理页选择“加载已解压的扩展”，目录为 `dist/extension/`。

生产部署扩展时，将其固定 origin 加入服务进程的 `EXTENSION_ORIGINS`，例如：

```bash
EXTENSION_ORIGINS=chrome-extension://abcdefghijklmnop \
ADDR=127.0.0.1:8080 ./e2ee-chat
```

修改环境变量后重启 systemd 服务。不要使用 `*` 放宽 CORS。
