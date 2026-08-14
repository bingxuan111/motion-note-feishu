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
    response.end(JSON.stringify({ ok: true, service: "motion-note-feishu" }));
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, () => {
  console.log(`Motion Note listener running on :${port}`);
});

const client = new Lark.Client({ appId, appSecret });

function extractDocumentReference(text) {
  if (typeof text !== "string") return null;

  const match = text.match(/\/(docx|docs|wiki)\/([A-Za-z0-9_-]+)/i);
  if (!match) return null;

  return {
    kind: match[1].toLowerCase(),
    token: match[2],
  };
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

async function resolveDocumentId(reference) {
  if (reference.kind !== "wiki") {
    return reference.token;
  }

  const accessToken = await getTenantAccessToken();

  const response = await fetch(
    `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(reference.token)}`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=utf-8",
      },
    },
  );

  const result = await response.json();
  const node = result.data?.node;

  if (!response.ok || result.code !== 0 || !node?.obj_token) {
    throw new Error(`wiki lookup failed: ${result.msg || response.status}`);
  }

  if (node.obj_type !== "docx") {
    throw new Error(`unsupported wiki document type: ${node.obj_type}`);
  }

  return node.obj_token;
}

async function readDocument(documentId) {
  const accessToken = await getTenantAccessToken();

  const response = await fetch(
    `https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`,
    {
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );

  const result = await response.json();

  if (!response.ok || result.code !== 0) {
    throw new Error(`document read failed: ${result.msg || response.status}`);
  }

  return String(result.data?.content || "").trim();
}

function compactSummary(content) {
  const normalized = content
    .replace(/[#*_>`]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!normalized) return "文档已读取，但暂未发现可展示的正文。";
  return normalized.length > 1200 ? `${normalized.slice(0, 1200)}…` : normalized;
}

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

    const reference = extractDocumentReference(rawContent);

    if (!reference) {
      await reply(
        message.message_id,
        "请直接发送私教课飞书文档链接，我会按原文导入训练计划。",
      );
      return;
    }

    await reply(message.message_id, "已识别到训练文档，正在读取原计划…");

    try {
      const documentId = await resolveDocumentId(reference);
      const content = await readDocument(documentId);

      console.log("Motion Note imported document", {
        documentId,
        characters: content.length,
      });

      await reply(
        message.message_id,
        `训练计划已读取，将按原文执行：\n\n${compactSummary(content)}`,
      );
    } catch (error) {
      console.error("Motion Note document import failed", error);

      await reply(
        message.message_id,
        "我识别到了文档，但暂时无法读取正文。请确认文档已分享给 Motion Note，并检查“查看知识库”和“查看新版文档”权限已发布。",
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
