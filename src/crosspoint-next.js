/**
 * Tàng Thư — CrossPoint NEXT receptor
 * POST /story/crosspoint-next
 * Request: {"shelf_no":1}
 */
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});

export async function handleCrosspointNext(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "Method Not Allowed" }, 405);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }

  const shelfNo = Number(body?.shelf_no);
  if (!Number.isInteger(shelfNo) || shelfNo < 1) {
    return json({ ok: false, error: "Invalid shelf_no" }, 400);
  }

  const triggerUrl = String(env.STORY_TRIGGER_URL || "").trim();
  const token = String(env.STORY_TRIGGER_TOKEN || "").trim();
  if (!triggerUrl || !token) {
    return json({ ok: false, error: "Story trigger configuration missing" }, 500);
  }

  const upstream = await fetch(triggerUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ shelf_no: shelfNo, direction: "next" }),
  });

  const raw = await upstream.text();
  if (!upstream.ok) {
    return json({ ok: false, error: "Story trigger rejected request", upstream_status: upstream.status }, 502);
  }

  let result;
  try { result = JSON.parse(raw); }
  catch { return json({ ok: false, error: "Invalid Story trigger response" }, 502); }

  if (result?.ok === false) {
    return json({ ok: false, error: result.error || "Story trigger failed" }, 502);
  }

  // CrossPoint browse expects a catalog-shaped response.
  return json({ ok: true, items: [] });
}

// Add to the existing Story Worker router:
// if (url.pathname === "/story/crosspoint-next") {
//   return handleCrosspointNext(request, env);
// }
