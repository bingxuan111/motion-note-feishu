/**
 * Feishu event webhook entry point.
 *
 * Current responsibility: complete Feishu's URL verification safely and accept
 * incoming robot messages. Message-to-document import is deliberately gated
 * until encrypted token + workout storage is configured.
 */
export default async function handler(request, response) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "method_not_allowed" });
  }

  const body = request.body || {};
  // Feishu performs this handshake before it allows a Webhook URL to be saved.
  if (body.type === "url_verification" && typeof body.challenge === "string") {
    return response.status(200).json({ challenge: body.challenge });
  }

  if (body.header?.event_type === "im.message.receive_v1") {
    const sender = body.event?.sender?.sender_id?.open_id || "unknown";
    const messageId = body.event?.message?.message_id || "unknown";
    console.log("Motion Note received robot message", { sender, messageId });
    // Always acknowledge quickly. Event delivery retries otherwise.
    return response.status(200).json({ ok: true, accepted: true });
  }

  return response.status(200).json({ ok: true, ignored: true });
}
