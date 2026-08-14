import http from "node:http";
import * as Lark from "@larksuiteoapi/node-sdk";

const port = Number(process.env.PORT || 3000);
const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;

if (!appId || !appSecret) {
  console.error("Missing FEISHU_APP_ID or FEISHU_APP_SECRET");
  process.exit(1);
}

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        service: "motion-note-feishu-long-connection",
      }),
    );
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, () => {
  console.log(`Motion Note listener running on :${port}`);
});

function extractDocumentId(text) {
  if (typeof text !== "string") return null;
  const match = text.match(/(?:docx|docs)\/([A-Za-z0-9_-]+)/i);
  return match?.[1] || null;
}

async function getTenantAccessToken() {
  const response = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    },
  );

  const result = await response.json();
  if (!response.ok || result.code !== 0 || !result.tenant_access_token) {
    throw new Error(`tenant token failed: ${result.msg || response.status}`);
  }
  return result.tenant_access_token;
}

async function readDocument(documentId) {
  const token = await getTenantAccessToken();
  const response = await fetch(
    `https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`,
    { headers: { authorization: `Bearer ${token}` } },
  );

  const result = await response.json();
  if (!response.ok || result.code !== 0) {
    throw new Error(`document read failed: ${result.msg || response.status}`);
  }
  return String(result.data?.content || "").trim();
}

function compactSummary(content) {
  const text = content
    .replace(/[#*_>`]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!text) return "文档已读取，但暂未发现可提炼的正文。";
  return text.length > 900 ? `${text.slice(0, 900)}…` : text;
}

const client = new Lark.Client({ appId, appSecret });

async function reply(messageId, text) {
  await client.im.v1.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
  });
}

const dispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    const message = data?.message;
    if (!message) return;

    const rawContent = message.content || "";
    console.log("Motion Note received message", {
      messageId: message.message_id,
      messageType: message.message_type,
      rawContent,
    });

    const documentId = extractDocumentId(rawContent);

    if (!documentId) {
      await reply(
        message.message_id,
        "已收到训练文档卡片，但还没有识别到文档地址。我正在记录它的格式，稍后再试一次。",
      );
      return;
    }

    await reply(message.message_id, "已识别到训练文档，正在读取原计划…");

    try {
      const content = await readDocument(documentId);

      await reply(
        message.message_id,
        `训练计划已读取，将按原文执行：\n\n${compactSummary(content)}`,
      );
    } catch (error) {
      console.error("Motion Note document import failed", error);

      await reply(
        message.message_id,
        "已识别到文档，但暂时无法读取正文。请确认文档已分享给 Motion Note，且已开通“查看新版文档”权限。",
      );
    }
  },
});

const wsClient = new Lark.WSClient({
  appId,
  appSecret,
  loggerLevel: Lark.LoggerLevel.info,
});

wsClient.start({ eventDispatcher: dispatcher });
