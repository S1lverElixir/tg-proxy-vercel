// tg-proxy — прозрачный релей запросов к Telegram Bot API для Vercel Functions
// (Node.js runtime — стандартный/рекомендованный рантайм Vercel Functions,
// Edge Functions официально deprecated с 2026 года).
//
// Расширение .mjs — чтобы не создавать отдельный package.json с "type": "module".
//
// ВАЖНО ПРО ПУТЬ ФАЙЛА: этот файл должен лежать ровно по пути
// api/proxy/[...path].mjs
// (включая квадратные скобки и три точки в имени файла — это специальный
// "catch-all"-синтаксис Vercel, он подхватывает ЛЮБОЙ путь после /api/proxy/,
// например /api/proxy/bot<ТОКЕН>/getMe). Создавая файл через веб-интерфейс GitHub,
// можно ввести весь этот путь целиком в поле имени файла — папки создадутся сами.
//
// Поэтому TELEGRAM_API_BASE_URL на стороне бота должен быть:
// https://<твой-проект>.vercel.app/api/proxy
// (bot.py сам допишет дальше "/bot<ТОКЕН>/<метод>" при каждом вызове).

const TIMEOUT_MS = 20000;
const PREFIX = "/api/proxy";

async function relay(request) {
  const incoming = new URL(request.url);
  const relayPath = incoming.pathname.startsWith(PREFIX)
    ? incoming.pathname.slice(PREFIX.length)
    : incoming.pathname;
  const targetUrl = "https://api.telegram.org" + relayPath + incoming.search;

  // Убираем заголовки, которые нельзя/не нужно пробрасывать руками при
  // формировании нового исходящего запроса — fetch сам корректно проставит их
  // под целевой хост.
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
  // duplex:"half" обязателен спецификацией fetch при передаче потокового тела —
  // без него современные рантаймы кидают ошибку "duplex option is required".
  if (hasBody) {
    init.duplex = "half";
  }

  try {
    const upstream = await fetch(targetUrl, init);
    clearTimeout(timer);

    // ВАЖНО: Node.js fetch() (undici) сам прозрачно распаковывает gzip/br-ответы
    // upstream'а — то есть upstream.body, который мы отдаём дальше, это уже
    // РАСПАКОВАННЫЕ байты. Но upstream.headers при этом всё ещё содержит
    // ОРИГИНАЛЬНЫЕ content-encoding/content-length от Telegram (для сжатого,
    // ещё не распакованного тела) — это задокументированный gotcha самого
    // fetch()/undici (whatwg/fetch issue #1729, nodejs/undici issue #2514),
    // спецификация не обязывает чистить эти заголовки при автораспаковке.
    // Если пробросить их как есть — клиент (aiohttp в bot.py) получает тело
    // без сжатия, но заголовок "content-encoding: gzip" всё ещё стоит, пытается
    // распаковать его повторно и либо ловит ошибку, либо получает мусор вместо
    // JSON. Именно это и было источником периодических "Expecting value: line 1
    // column 1" в логах бота — проявлялось не всегда, а только когда ответ
    // Telegram оказывался достаточно большим, чтобы Telegram сам сжал его gzip'ом.
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    responseHeaders.delete("transfer-encoding");

    return new Response(upstream.body, {
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
    // Валидный JSON в форме, похожей на ошибку Telegram API (ok:false), а не сырой
    // текст/HTML — именно сырой не-JSON ответ прокси уже один раз ломал бота
    // (JSONDecodeError на стороне bot.py при падении прежнего прокси на Deno).
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
