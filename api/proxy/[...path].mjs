// tg-proxy — прозрачный релей запросов к Telegram Bot API для Vercel Functions
// (Node.js runtime, .mjs без отдельного package.json).
//
// api/proxy/[...path].mjs — catch-all путь, ловит всё после /api/proxy/.
// TELEGRAM_API_BASE_URL на стороне бота: https://<проект>.vercel.app/api/proxy
// (bot.py сам допишет "/bot<ТОКЕН>/<метод>" при каждом вызове).

const TIMEOUT_MS = 20000;
const PREFIX = "/api/proxy";

async function relay(request) {
  const incoming = new URL(request.url);
  const relayPath = incoming.pathname.startsWith(PREFIX)
    ? incoming.pathname.slice(PREFIX.length)
    : incoming.pathname;
  const targetUrl = "https://api.telegram.org" + relayPath + incoming.search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("connection");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const hasBody = !["GET", "HEAD"].includes(request.method);
  const init = {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    signal: controller.signal,
  };
  if (hasBody) {
    init.duplex = "half";
  }

  // Логируем КАЖДЫЙ запрос — до сих пор Logs были пустыми просто потому,
  // что в коде не было ни одного console.log. Без этого невозможно понять,
  // что реально приходит от Telegram при сбоях — приходится гадать вслепую.
  // relayPath без query-параметров (там токен) — безопасно светить в логах.
  console.log(`[tg-proxy] -> ${request.method} ${relayPath}`);

  try {
    const upstream = await fetch(targetUrl, init);
    clearTimeout(timer);

    const buf = await upstream.arrayBuffer();
    const bodyText = Buffer.from(buf).toString("utf-8");

    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    responseHeaders.delete("transfer-encoding");

    // Проверяем валидность JSON ДО отдачи клиенту — если невалиден, логируем
    // сырое тело (до 500 символов), чтобы в Vercel Logs было видно, что именно
    // вернулось в этом случае, а не просто "что-то пошло не так".
    let isValidJson = true;
    try {
      JSON.parse(bodyText);
    } catch {
      isValidJson = false;
    }
    console.log(
      `[tg-proxy] <- status=${upstream.status} bytes=${buf.byteLength} validJson=${isValidJson}` +
      (isValidJson ? "" : ` rawBody="${bodyText.slice(0, 500)}"`)
    );

    return new Response(buf, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err && err.name === "AbortError";
    const message = isTimeout
      ? `tg-proxy: upstream (api.telegram.org) не ответил за ${TIMEOUT_MS}мс`
      : `tg-proxy: ошибка запроса к upstream: ${String(err)}`;
    console.error(`[tg-proxy] ERROR: ${message}`, err && err.stack);
    return new Response(JSON.stringify({ ok: false, error_code: 504, description: message }), {
      status: 504,
      headers: { "content-type": "application/json" },
    });
  }
}

export const GET = relay;
export const POST = relay;
export const PUT = relay;
export const PATCH = relay;
export const DELETE = relay;
export const HEAD = relay;
