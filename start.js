import crypto from "node:crypto";

const appId = process.env.FEISHU_APP_ID;
const stateSecret = process.env.OAUTH_STATE_SECRET;
const publicBaseURL = process.env.PUBLIC_BASE_URL;

function base64url(value) { return Buffer.from(value).toString("base64url"); }
function sign(value) { return crypto.createHmac("sha256", stateSecret).update(value).digest("base64url"); }

export default function handler(request, response) {
  if (!appId || !stateSecret || !publicBaseURL) {
    return response.status(500).send("Motion Note 尚未完成云端授权配置。");
  }
  const payload = base64url(JSON.stringify({ nonce: crypto.randomBytes(16).toString("hex"), expiresAt: Date.now() + 10 * 60 * 1000 }));
  const state = `${payload}.${sign(payload)}`;
  const authorizationURL = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
  authorizationURL.searchParams.set("client_id", appId);
  authorizationURL.searchParams.set("redirect_uri", `${publicBaseURL}/api/feishu/callback`);
  authorizationURL.searchParams.set("state", state);
  authorizationURL.searchParams.set("scope", "offline_access");
  response.redirect(302, authorizationURL.toString());
}
