import { timingSafeEqual } from "node:crypto";

// Canal administrativo local: nao depende de OAuth e nunca permite acionamento pelo tunel/browser.
export function mountLocalShutdown(app, { token, onRequest } = {}) {
  if (!token || !onRequest) return;
  let scheduled = false;
  app.post("/api/shutdown", (request, response) => {
    const host = request.get("host") || "";
    const localHost = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(host);
    const localPeer = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress);
    if (!localHost || !localPeer || request.get("origin") || request.get("forwarded")
      || request.get("x-forwarded-host") || request.get("x-forwarded-for") || request.get("x-forwarded-proto")) {
      response.status(403).json({ error: "local_only" });
      return;
    }
    const supplied = Buffer.from(request.get("x-mcp-shutdown-token") || "");
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.status(403).json({ error: "invalid_shutdown_token" });
      return;
    }
    if (!scheduled) {
      scheduled = true;
      // Confirma a resposta antes de fechar o HTTP que transporta este pedido.
      response.once("finish", () => setImmediate(onRequest));
    }
    response.status(202).json({ status: "stopping" });
  });
}
