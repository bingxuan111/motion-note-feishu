# Motion Note · Feishu OAuth

个人使用的飞书 OAuth 回调服务。飞书 App Secret 只保存为 Vercel 环境变量，永远不进入 iPhone App 或 Git。

## Vercel 环境变量

为 Production、Preview、Development 都添加：

- `FEISHU_APP_ID`：飞书应用 App ID
- `FEISHU_APP_SECRET`：飞书应用 App Secret（Sensitive）
- `OAUTH_STATE_SECRET`：随机 32 字节以上字符串（Sensitive）
- `PUBLIC_BASE_URL`：Vercel 生产地址，例如 `https://motion-note-feishu.vercel.app`

飞书开放平台重定向 URL 为：`https://你的域名/api/feishu/callback`。

当前版本只验证 OAuth 授权并回跳 Motion Note。后续版本会增加加密的令牌持久化和飞书文档读取。

## 机器人事件回调

飞书「事件与回调」的 Webhook 请求地址为：

`https://你的域名/api/feishu/events`

订阅事件：`im.message.receive_v1`（接收消息）。当前接口已支持 URL 验证与消息确认；自动读取文档会在加密令牌和训练记录存储配置完成后启用。
Webhook deployment enabled.
