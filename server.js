import http from "node:http";
import * as Lark from "@larksuiteoapi/node-sdk";

const port = Number(process.env.PORT || 3000);
const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;

if (!appId || !appSecret) {
  console.error("Missing FEISHU_APP_ID or FEISHU_APP_SECRET");
  process.exit(1);
}

// Railway probes this endpoint; the Feishu event channel itself is a persistent
// outbound WebSocket connection, so no public webhook URL is required.
const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "motion-note-feishu-long-connection" }));
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, () => {
  console.log(`Motion Note listener health check running on :${port}`);
});

const baseConfig = { appId, appSecret };
const client = new Lark.Client(baseConfig);
const dispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    const message = data?.message;
    if (!message) return;

    console.log("Motion Note received message", {
      messageId: message.message_id,
      messageType: message.message_type,
      chatId: message.chat_id,
    });

    // Phase 1: prove that the persistent event channel is working. A later
    // phase will extract Feishu document links, read documents using the user's
    // OAuth token, and store a structured workout record.
    if (message.message_type === "text") {
      await client.im.v1.message.reply({
        path: { message_id: message.message_id },
        data: {
          msg_type: "text",
          content: JSON.stringify({
            text: "已收到。Motion Note 正在准备导入这份训练记录。",
          }),
        },
      });
    }
  },
});

const wsClient = new Lark.WSClient({
  ...baseConfig,
  loggerLevel: Lark.LoggerLevel.info,
});

wsClient.start({ eventDispatcher: dispatcher });
