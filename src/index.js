const REPO = "Zenkjt/tangthu-opds";
const STORY_REPO = "Zenkjt/tangthu-story-scraper";
const STORY_ROOT = "story-cache";
const REQUEST_ROOT = `${STORY_ROOT}/requests`;
const SOURCES_PATH = `${STORY_ROOT}/story-sources.json`;
const GH_API = "https://api.github.com";
const DEFAULT_ALLOWED_ORIGIN = "https://tangthu.pages.dev";

const limits = new Map();

function headers(origin) {
  return {
    "Access-Control-Allow-Origin": origin || DEFAULT_ALLOWED_ORIGIN,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
}

function json(data, status = 200, origin = DEFAULT_ALLOWED_ORIGIN) {
  return new Response(JSON.stringify(data), { status, headers: headers(origin) });
}

function requestOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;
  if (origin && origin !== allowed) return null;
  return origin || allowed;
}

function rateLimit(request, kind) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = `${kind}:${ip}`;
  const now = Date.now();
  const windowMs = 60_000;
  const max = kind === "current" || kind === "operation" ? 60 : 12;
  const old = limits.get(key);
  if (!old || now - old.start >= windowMs) {
    limits.set(key, { start: now, count: 1 });
    return true;
  }
  if (old.count >= max) return false;
  old.count++;
  return true;
}

function requireTriggerToken(request, env) {
  const expected = String(env.STORY_TRIGGER_TOKEN || "").trim();
  if (!expected) throw new Error("STORY_TRIGGER_TOKEN chưa được cấu hình");

  const provided = String(request.headers.get("Authorization") || "").trim();
  if (provided !== `Bearer ${expected}`) {
    const error = new Error("Unauthorized");
    error.status = 401;
    throw error;
  }
}

async function gh(env, path, options = {}) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN chưa được cấu hình");
  const res = await fetch(`${GH_API}${path}`, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "TangThu-Story-Worker/1.0",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    const error = new Error(`GitHub API ${res.status}: ${body.slice(0, 500)}`);
    error.status = res.status;
    throw error;
  }
  return res;
}

function safeSegment(value, fallback = "unknown") {
  const s = String(value || "").trim();
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned || fallback;
}

function requestPath(id) {
  return `${REQUEST_ROOT}/${safeSegment(id)}.json`;
}

function storyPath(userId, storyId) {
  return `${STORY_ROOT}/${safeSegment(userId)}/${safeSegment(storyId)}/story.json`;
}

async function readJsonFile(env, path) {
  const res = await gh(env, `/repos/${STORY_REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=main`);
  const meta = await res.json();
  const raw = atob(String(meta.content || "").replace(/\n/g, ""));
  const bytes = Uint8Array.from(raw, ch => ch.charCodeAt(0));
  return {
    sha: meta.sha,
    data: JSON.parse(new TextDecoder("utf-8").decode(bytes)),
  };
}

async function readStoryRepoJson(env, path) {
  return (await readJsonFile(env, path)).data;
}

function utf8Base64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function writeJsonFile(env, path, data, message) {
  let sha = null;
  try {
    sha = (await readJsonFile(env, path)).sha;
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  const payload = {
    message,
    content: utf8Base64(JSON.stringify(data, null, 2) + "\n"),
    branch: "main",
  };
  if (sha) payload.sha = sha;

  const res = await gh(env, `/repos/${STORY_REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function dispatch(env, payload) {
  await gh(env, `/repos/${STORY_REPO}/dispatches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_type: "story-request",
      client_payload: payload,
    }),
  });
}

async function readShelfStoryState(env, folderId) {
  const appsScriptUrl = String(env.TANGTHU_APPS_SCRIPT_URL || "").trim();
  const token = String(env.TANGTHU_UPLOAD_TOKEN || "").trim();

  if (!appsScriptUrl) {
    throw new Error("TANGTHU_APPS_SCRIPT_URL chưa được cấu hình");
  }
  if (!token) {
    throw new Error("TANGTHU_UPLOAD_TOKEN chưa được cấu hình");
  }

  const response = await fetch(appsScriptUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "story_cache",
      operation: "read",
      token,
      folder_id: folderId,
      relative_path: "StoryState",
    }),
  });

  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text || "{}");
  } catch {
    throw new Error("Apps Script trả về dữ liệu không hợp lệ");
  }

  if (!response.ok || result.ok === false) {
    throw new Error(result.error || `Apps Script HTTP ${response.status}`);
  }

  if (!result.exists) return null;

  const raw = atob(String(result.content_base64 || ""));
  const bytes = Uint8Array.from(raw, ch => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

async function createRequest(env, body, action) {
  const userId = String(body.user_id || "").trim();
  let storyId = String(body.story_id || "").trim();
  const folderId = String(body.folder_id || "").trim();
  const url = String(body.url || "").trim();
  const chapterNumber = body.chapter_number == null ? null : Number(body.chapter_number);

  if (!userId) throw new Error("Thiếu user_id");
  if (!folderId) throw new Error("Thiếu folder_id");
  if (action === "register" && !url) throw new Error("Thiếu URL truyện");

  // CrossPoint trigger intentionally sends no story_id.
  // Resolve it from the shelf-local StoryState instead.
  if (action !== "register" && !storyId) {
    const state = await readShelfStoryState(env, folderId);
    if (!state || !state.story_id) {
      throw new Error("Tủ này chưa có StoryState / truyện đang đọc");
    }
    storyId = String(state.story_id).trim();
  }

  if (action !== "register" && !storyId) throw new Error("Thiếu story_id");

  if (action === "jump" && (!Number.isInteger(chapterNumber) || chapterNumber < 1)) {
    throw new Error("chapter_number không hợp lệ");
  }

  const requestId = crypto.randomUUID();
  const now = new Date().toISOString();
  const request = {
    schema_version: 1,
    request_id: requestId,
    user_id: userId,
    story_id: storyId || null,
    folder_id: folderId,
    action,
    url: url || null,
    chapter_number: chapterNumber,
    status: "queued",
    message: "Đã xếp hàng xử lý.",
    created_at: now,
    updated_at: now,
  };

  await writeJsonFile(env, requestPath(requestId), request, `story: queue ${action} ${requestId}`);

  try {
    await dispatch(env, { request_id: requestId });
  } catch (error) {
    request.status = "failed";
    request.message = error.message;
    request.updated_at = new Date().toISOString();
    await writeJsonFile(env, requestPath(requestId), request, `story: dispatch failed ${requestId}`);
    throw error;
  }

  return {
    ok: true,
    status: "queued",
    request_id: requestId,
    message: request.message,
  };
}

async function currentStory(env, request) {
  const userId = String(request.searchParams.get("user_id") || "").trim();
  const storyId = String(request.searchParams.get("story_id") || "").trim();
  if (!userId || !storyId) throw new Error("Thiếu user_id hoặc story_id");
  try {
    const result = await readJsonFile(env, storyPath(userId, storyId));
    return { ok: true, story: addCoverUrl(result.data, userId, storyId) };
  } catch (error) {
    if (error.status === 404) return { ok: false, status: "not_found", error: "Chưa có story cache." };
    throw error;
  }
}

async function currentStoryByUser(env, request) {
  const userId = String(request.searchParams.get("user_id") || "").trim();
  const folderId = String(request.searchParams.get("folder_id") || "").trim();

  if (!userId) throw new Error("Thiếu user_id");
  if (!folderId) throw new Error("Thiếu folder_id");

  const state = await readShelfStoryState(env, folderId);
  if (!state || !state.story_id || !state.story) {
    return {
      ok: false,
      status: "not_found",
      error: "Chưa có truyện đang đọc trong tủ này.",
    };
  }

  if (String(state.story_id) !== String(state.story.story_id || "")) {
    throw new Error("StoryState không nhất quán: story_id không khớp story.story_id");
  }

  return {
    ok: true,
    story: state.story,
  };
}

function addCoverUrl(story, userId, storyId) {
  const ext = story.cover_ext || ".jpg";
  return {
    ...story,
    cover_url:
      story.cover_url ||
      `https://raw.githubusercontent.com/${STORY_REPO}/main/${STORY_ROOT}/${safeSegment(userId)}/${safeSegment(storyId)}/cover${ext}`,
  };
}

async function operation(env, request) {
  const id = String(request.searchParams.get("request_id") || "").trim();
  if (!id) throw new Error("Thiếu request_id");
  try {
    const result = await readJsonFile(env, requestPath(id));
    const op = result.data;
    if (op.story) op.story = addCoverUrl(op.story, op.user_id, op.story_id);
    return { ok: true, operation: op };
  } catch (error) {
    if (error.status === 404) return { ok: false, status: "not_found", error: "Không tìm thấy request." };
    throw error;
  }
}

async function sources(env) {
  try {
    const data = await readStoryRepoJson(env, SOURCES_PATH);
    return {
      ok: true,
      sources: Array.isArray(data.sources) ? data.sources : [],
      updated_at: data.updated_at || null,
    };
  } catch (error) {
    if (error.status === 404) return { ok: true, sources: [], updated_at: null };
    throw error;
  }
}

export default {
  async fetch(request, env) {
    const origin = requestOrigin(request, env);
    if (!origin) return json({ ok: false, error: "Origin không được phép" }, 403);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: headers(origin) });
    }

    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/story/current") {
        if (!rateLimit(request, "current")) return json({ ok: false, error: "Too many requests" }, 429, origin);
        return json(await currentStory(env, url), 200, origin);
      }

      if (request.method === "GET" && url.pathname === "/story/current-by-user") {
        if (!rateLimit(request, "current")) return json({ ok: false, error: "Too many requests" }, 429, origin);
        return json(await currentStoryByUser(env, url), 200, origin);
      }

      if (request.method === "GET" && url.pathname === "/story/operation") {
        if (!rateLimit(request, "operation")) return json({ ok: false, error: "Too many requests" }, 429, origin);
        return json(await operation(env, url), 200, origin);
      }

      if (request.method === "GET" && url.pathname === "/story/sources") {
        if (!rateLimit(request, "current")) return json({ ok: false, error: "Too many requests" }, 429, origin);
        return json(await sources(env), 200, origin);
      }

      if (request.method === "POST" && url.pathname === "/story/trigger") {
        requireTriggerToken(request, env);
        if (!rateLimit(request, "trigger")) return json({ ok: false, error: "Too many requests" }, 429, origin);

        const body = await request.json();
        const action = String(body.action || "").trim().toLowerCase();

        if (action !== "next" && action !== "previous") {
          return json({ ok: false, error: "Unsupported trigger action" }, 400, origin);
        }

        return json(await createRequest(env, body, action), 202, origin);
      }

      if (request.method === "POST") {
        const body = await request.json();
        const action = url.pathname.replace(/^\/story\//, "");
        if (!["register", "next", "previous", "jump"].includes(action)) {
          return json({ ok: false, error: "Unsupported story action" }, 404, origin);
        }
        if (!rateLimit(request, action)) return json({ ok: false, error: "Too many requests" }, 429, origin);
        return json(await createRequest(env, body, action), 202, origin);
      }

      return json({ ok: false, error: "Not found" }, 404, origin);
    } catch (error) {
      const status = error.status || 400;
      return json({ ok: false, error: error.message || String(error) }, status, origin);
    }
  },
};
