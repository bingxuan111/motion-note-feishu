import http from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";

const port = Number(process.env.PORT || 3000);
const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
const syncSecret = process.env.APP_SYNC_SECRET;
const planStorePath = process.env.PLAN_STORE_PATH || "/data/latest-plan.json";

if (!appId || !appSecret) {
  console.error("Missing FEISHU_APP_ID or FEISHU_APP_SECRET");
  process.exit(1);
}

function sendJSON(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function loadLatestPlan() {
  try {
    return JSON.parse(await readFile(planStorePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function saveLatestPlan(plan) {
  await mkdir(dirname(planStorePath), { recursive: true });
  const temporaryPath = `${planStorePath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(plan, null, 2), "utf8");
  await rename(temporaryPath, planStorePath);
}

// Railway probes this endpoint. The Feishu event channel itself uses a persistent
// outbound WebSocket, so no public webhook URL is required for receiving events.
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method === "GET" && url.pathname === "/health") {
    sendJSON(response, 200, { ok: true, service: "motion-note-feishu" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/latest-plan") {
    if (!syncSecret || request.headers["x-motionnote-key"] !== syncSecret) {
      sendJSON(response, 401, { error: "unauthorized" });
      return;
    }
    try {
      sendJSON(response, 200, { plan: await loadLatestPlan() });
    } catch (error) {
      console.error("Motion Note failed to load plan", error);
      sendJSON(response, 500, { error: "plan_store_unavailable" });
    }
    return;
  }

  sendJSON(response, 404, { error: "not_found" });
});

server.listen(port, () => console.log(`Motion Note listener running on :${port}`));

const baseConfig = { appId, appSecret };
const client = new Lark.Client(baseConfig);

function extractDocumentReference(text) {
  if (typeof text !== "string") return null;
  const match = text.match(/(?:docx|docs|wiki)\/([A-Za-z0-9_-]+)/i);
  return match ? { type: match[0].split("/")[0].toLowerCase(), token: match[1], sourceURL: text.trim() } : null;
}

async function getTenantAccessToken() {
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const result = await response.json();
  if (!response.ok || result.code !== 0 || !result.tenant_access_token) {
    throw new Error(`tenant token failed: ${result.msg || response.status}`);
  }
  return result.tenant_access_token;
}

async function resolveDocumentId(reference) {
  if (reference.type !== "wiki") return reference.token;
  const token = await getTenantAccessToken();
  const response = await fetch(
    `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(reference.token)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const result = await response.json();
  const node = result.data?.node;
  if (!response.ok || result.code !== 0 || node?.obj_type !== "docx" || !node?.obj_token) {
    throw new Error(`wiki resolve failed: ${result.msg || response.status}`);
  }
  return node.obj_token;
}

async function readDocument(documentId) {
  const token = await getTenantAccessToken();
  const response = await fetch(
    `https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const result = await response.json();
  if (!response.ok || result.code !== 0) throw new Error(`document read failed: ${result.msg || response.status}`);
  return String(result.data?.content || "").trim();
}

function titleFrom(content) {
  return content.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 80) || "飞书训练计划";
}

function compactSummary(content) {
  const normalized = content.replace(/[#*_>`]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return normalized.length > 900 ? `${normalized.slice(0, 900)}…` : normalized;
}

async function reply(messageId, text) {
  await client.im.v1.message.reply({
    path: { message_id: messageId },
    data: { msg_type: "text", content: JSON.stringify({ text }) },
  });
}

const dispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    const message = data?.message;
    if (!message) return;
    const rawContent = message.content || "{}";
    const text = message.message_type === "text" ? (JSON.parse(rawContent).text || "") : rawContent;
    const reference = extractDocumentReference(text);
    if (!reference) {
      await reply(message.message_id, "请把私教课飞书文档链接直接发给我，我会读取原计划并同步到 Motion Note。 ");
      return;
    }

    await reply(message.message_id, "已识别到训练文档，正在读取原计划…");
    try {
      const documentId = await resolveDocumentId(reference);
      const rawContent = await readDocument(documentId);
      const plan = {
        title: titleFrom(rawContent),
        raw_content: rawContent,
        source_url: reference.sourceURL,
        imported_at: new Date().toISOString(),
      };
      await saveLatestPlan(plan);
      await reply(message.message_id, `训练计划已读取并同步。App 里点“同步最新私教课”即可导入原文。\n\n${compactSummary(rawContent)}`);
    } catch (error) {
      console.error("Motion Note document import failed", error);
      await reply(message.message_id, "我识别到了文档链接，但暂时无法读取或保存正文。请确认文档已分享给 Motion Note 机器人，并检查文档与知识库查看权限。");
    }
  },
});

const wsClient = new Lark.WSClient({ ...baseConfig, loggerLevel: Lark.LoggerLevel.info });
wsClient.start({ eventDispatcher: dispatcher });
