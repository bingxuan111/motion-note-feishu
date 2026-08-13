import crypto from "node:crypto";

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
const stateSecret = process.env.OAUTH_STATE_SECRET;
const publicBaseURL = process.env.PUBLIC_BASE_URL;

function verifyState(state) {
  const [payload, signature] = (state || "").split(".");
  if (!payload || !signature || !stateSecret) return false;
  const expected = crypto.createHmac("sha256", stateSecret).update(payload).digest();
  const received = Buffer.from(signature, "base64url");
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return false;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString()).expiresAt > Date.now(); } catch { return false; }
}

export default async function handler(request, response) {
  const { code, state, error } = request.query;
  if (error || !code || !verifyState(state)) return response.status(400).send("飞书授权未完成或已过期，请返回 Motion Note 重试。");
  if (!appId || !appSecret || !publicBaseURL) return response.status(500).send("Motion Note 云端凭证尚未配置完整。");
  try {
    const tokenResponse = await fetch("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: appId,
        client_secret: appSecret,
        code,
        redirect_uri: `${publicBaseURL}/api/feishu/callback`
      })
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || token.code) throw new Error(token.msg || "token exchange failed");
    // This verification release deliberately does not persist or expose any token.
    // Token storage and document import are added after OAuth is confirmed working.
    response.redirect(302, "motionnote://feishu-connected?success=1");
  } catch (exception) {
    console.error("Feishu OAuth callback failed", exception.message);
    response.status(502).send("飞书连接没有完成，请返回 Motion Note 重试。");
  }
}
