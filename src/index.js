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

async function readJsonFile(env, path, repo = STORY_REPO) {
  const res = await gh(
    env,
    `/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=main`
  );

  const meta = await res.json();
  const raw = atob(String(meta.content || "").replace(/\n/g, ""));
  const bytes = Uint8Array.from(raw, ch => ch.charCodeAt(0));

  return {
    sha: meta.sha,
    data: JSON.parse(new TextDecoder("utf-8").decode(bytes)),
  };
}

async function readStoryRepoJson(env, path) {
  return (await readJsonFile(env, path, STORY_REPO)).data;
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

  const res = await gh(
    env,
    `/repos/${STORY_REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );

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
  const tocIndex =
    body.toc_index == null ? null : Number(body.toc_index);

  if (!userId) throw new Error("Thiếu user_id");
  if (!folderId) throw new Error("Thiếu folder_id");
  if (action === "register" && !url) throw new Error("Thiếu URL truyện");

  if (action !== "register" && !storyId) {
    let state;
    try {
      state = await readShelfStoryState(env, folderId);
    } catch (error) {
      const diagnostic = new Error(
        "CROSSPOINT_STORY_STATE_READ_FAILED: " + String(error.message || error)
      );
      diagnostic.status = 502;
      diagnostic.stage = "story_state";
      throw diagnostic;
    }

    if (!state || !state.story_id) {
      const diagnostic = new Error(
        "CROSSPOINT_STORY_STATE_EMPTY: Tủ này chưa có StoryState / truyện đang đọc"
      );
      diagnostic.status = 502;
      diagnostic.stage = "story_state";
      throw diagnostic;
    }

    storyId = String(state.story_id).trim();
  }

  if (action !== "register" && !storyId) {
    throw new Error("Thiếu story_id");
  }

  if (
    action === "jump" &&
    (!Number.isInteger(tocIndex) || tocIndex < 1)
  ) {
    throw new Error("toc_index không hợp lệ");
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
    toc_index: tocIndex,
    status: "queued",
    message: "Đã xếp hàng xử lý.",
    created_at: now,
    updated_at: now,
  };

  try {
    await writeJsonFile(
      env,
      requestPath(requestId),
      request,
      `story: queue ${action} ${requestId}`
    );
  } catch (error) {
    const diagnostic = new Error(
      "CROSSPOINT_REQUEST_WRITE_FAILED: " + String(error.message || error)
    );
    diagnostic.status = 503;
    diagnostic.stage = "request_write";
    throw diagnostic;
  }

  try {
    await dispatch(env, { request_id: requestId });
  } catch (error) {
    request.status = "failed";
    request.message = error.message;
    request.updated_at = new Date().toISOString();

    try {
      await writeJsonFile(
        env,
        requestPath(requestId),
        request,
        `story: dispatch failed ${requestId}`
      );
    } catch {
      // Diagnostic mode: preserve the original dispatch failure.
    }

    const diagnostic = new Error(
      "CROSSPOINT_DISPATCH_FAILED: " + String(error.message || error)
    );
    diagnostic.status = 504;
    diagnostic.stage = "dispatch";
    throw diagnostic;
  }

  return {
    ok: true,
    status: "queued",
    request_id: requestId,
    message: request.message,
  };
}

/* =========================================================
   CROSSPOINT NEXT RECEPTOR
   ========================================================= */

async function loadCrosspointShelf(env, shelfNo) {
  const data = (await readJsonFile(env, "config/branches.json", REPO)).data;

  const branches = Array.isArray(data)
    ? data
    : Array.isArray(data.branches)
      ? data.branches
      : [];

  const branch = branches.find(
    item => Number(item.shelf_no) === shelfNo
  );

  if (!branch) {
    throw new Error(`Không tìm thấy shelf_no=${shelfNo}`);
  }

  if (branch.enabled === false || branch.status === "suspended") {
    throw new Error(`Tủ shelf_no=${shelfNo} đang bị vô hiệu hóa`);
  }

  const userId = String(branch.id || "").trim();
  const folderId = String(branch.root_folder_id || "").trim();

  if (!userId) {
    throw new Error("Shelf thiếu branch.id");
  }

  if (!folderId) {
    throw new Error("Shelf thiếu root_folder_id");
  }

  return {
    user_id: userId,
    folder_id: folderId,
    shelf_name: String(
      branch.display_name ||
      branch.folder_name ||
      `Shelf ${shelfNo}`
    ),
  };
}

async function crosspointNext(env, request) {
  if (request.method !== "POST") {
    const error = new Error("Method Not Allowed");
    error.status = 405;
    throw error;
  }

  let body;
  try {
    body = await request.json();
  } catch (error) {
    const diagnostic = new Error("CROSSPOINT_INVALID_JSON: " + String(error));
    diagnostic.status = 400;
    diagnostic.stage = "crosspoint_json";
    throw diagnostic;
  }

  const shelfNo = Number(body?.shelf_no);

  if (!Number.isInteger(shelfNo) || shelfNo < 1) {
    const error = new Error("CROSSPOINT_INVALID_SHELF_NO");
    error.status = 400;
    error.stage = "crosspoint_validate";
    throw error;
  }

  let shelf;
  try {
    shelf = await loadCrosspointShelf(env, shelfNo);
  } catch (error) {
    console.error("CROSSPOINT_SHELF_LOAD_FAILED", {
      shelf_no: shelfNo,
      message: String(error?.message || error),
      status: error?.status || null,
    });

    const diagnostic = new Error(
      "CROSSPOINT_SHELF_LOAD_FAILED: " + String(error.message || error)
    );
    diagnostic.status = 501;
    diagnostic.stage = "shelf_load";
    throw diagnostic;
  }

  let result;
  try {
    result = await createRequest(
      env,
      {
        user_id: shelf.user_id,
        folder_id: shelf.folder_id,
      },
      "next"
    );
  } catch (error) {
    const diagnostic = new Error(
      "CROSSPOINT_REQUEST_CREATE_FAILED: " + String(error.message || error)
    );
    diagnostic.status = 500;
    diagnostic.stage = "request_create";
    throw diagnostic;
  }

  return {
    ok: true,
    status: result.status,
    request_id: result.request_id,
    shelf_no: shelfNo,
    shelf_name: shelf.shelf_name,
    direction: "next",
    items: [{
      id: result.request_id,
      title: "Request sent.",
      author: "New chapter should be available in about 90 seconds.",
    }],
  };
}

async function crosspointPrevious(env, request) {
  if (request.method !== "POST") {
    const error = new Error("Method Not Allowed");
    error.status = 405;
    throw error;
  }

  let body;
  try {
    body = await request.json();
  } catch (error) {
    const diagnostic = new Error("CROSSPOINT_INVALID_JSON: " + String(error));
    diagnostic.status = 400;
    diagnostic.stage = "crosspoint_json";
    throw diagnostic;
  }

  const shelfNo = Number(body?.shelf_no);

  if (!Number.isInteger(shelfNo) || shelfNo < 1) {
    const error = new Error("CROSSPOINT_INVALID_SHELF_NO");
    error.status = 400;
    error.stage = "crosspoint_validate";
    throw error;
  }

  let shelf;
  try {
    shelf = await loadCrosspointShelf(env, shelfNo);
  } catch (error) {
    console.error("CROSSPOINT_SHELF_LOAD_FAILED", {
      shelf_no: shelfNo,
      message: String(error?.message || error),
      status: error?.status || null,
    });

    const diagnostic = new Error(
      "CROSSPOINT_SHELF_LOAD_FAILED: " + String(error.message || error)
    );
    diagnostic.status = 501;
    diagnostic.stage = "shelf_load";
    throw diagnostic;
  }

  let result;
  try {
    result = await createRequest(
      env,
      {
        user_id: shelf.user_id,
        folder_id: shelf.folder_id,
      },
      "previous"
    );
  } catch (error) {
    const diagnostic = new Error(
      "CROSSPOINT_REQUEST_CREATE_FAILED: " + String(error.message || error)
    );
    diagnostic.status = 500;
    diagnostic.stage = "request_create";
    throw diagnostic;
  }

  return {
    ok: true,
    status: result.status,
    request_id: result.request_id,
    shelf_no: shelfNo,
    shelf_name: shelf.shelf_name,
    direction: "previous",
    items: [{
      id: result.request_id,
      title: "Request sent.",
      author: "New chapter should be available in about 90 seconds.",
    }],
  };
}

async function currentStory(env, request) {
  const userId = String(
    request.searchParams.get("user_id") || ""
  ).trim();

  const storyId = String(
    request.searchParams.get("story_id") || ""
  ).trim();

  if (!userId || !storyId) {
    throw new Error("Thiếu user_id hoặc story_id");
  }

  try {
    const result = await readJsonFile(
      env,
      storyPath(userId, storyId)
    );

    return {
      ok: true,
      story: addCoverUrl(result.data, userId, storyId),
    };
  } catch (error) {
    if (error.status === 404) {
      return {
        ok: false,
        status: "not_found",
        error: "Chưa có story cache.",
      };
    }

    throw error;
  }
}

async function currentStoryByUser(env, request) {
  const userId = String(
    request.searchParams.get("user_id") || ""
  ).trim();

  const folderId = String(
    request.searchParams.get("folder_id") || ""
  ).trim();

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

  if (
    String(state.story_id) !==
    String(state.story.story_id || "")
  ) {
    throw new Error(
      "StoryState không nhất quán: story_id không khớp story.story_id"
    );
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
  const id = String(
    request.searchParams.get("request_id") || ""
  ).trim();

  if (!id) throw new Error("Thiếu request_id");

  try {
    const result = await readJsonFile(
      env,
      requestPath(id)
    );

    const op = result.data;

    if (op.story) {
      op.story = addCoverUrl(
        op.story,
        op.user_id,
        op.story_id
      );
    }

    return {
      ok: true,
      operation: op,
    };
  } catch (error) {
    if (error.status === 404) {
      return {
        ok: false,
        status: "not_found",
        error: "Không tìm thấy request.",
      };
    }

    throw error;
  }
}

async function sources(env) {
  try {
    const data = await readStoryRepoJson(
      env,
      SOURCES_PATH
    );

    return {
      ok: true,
      sources: Array.isArray(data.sources)
        ? data.sources
        : [],
      updated_at: data.updated_at || null,
    };
  } catch (error) {
    if (error.status === 404) {
      return {
        ok: true,
        sources: [],
        updated_at: null,
      };
    }

    throw error;
  }
}


/* =========================================================
   EPUB METADATA
   ========================================================= */

const MAX_EPUB_BYTES = 40 * 1024 * 1024;

function decodeXmlEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (entity, code) => {
    const key = code.toLowerCase();
    if (key === "lt") return "<";
    if (key === "gt") return ">";
    if (key === "amp") return "&";
    if (key === "quot") return '"';
    if (key === "apos") return "'";
    const numeric = key.startsWith("#x")
      ? parseInt(key.slice(2), 16)
      : parseInt(key.slice(1), 10);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 0x10ffff) {
      return entity;
    }
    try {
      return String.fromCodePoint(numeric);
    } catch {
      return entity;
    }
  });
}

function xmlText(xml, localName) {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    "<(?:[\\w.-]+:)?" + escaped + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?" + escaped + "\\s*>",
    "i"
  );
  const match = xml.match(pattern);
  if (!match) return "";
  return decodeXmlEntities(
    match[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, "")
      .trim()
  );
}

function findZipEnd(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Math.max(0, bytes.length - 65557);
  for (let offset = bytes.length - 22; offset >= min; offset--) {
    if (
      offset + 22 <= bytes.length &&
      view.getUint32(offset, true) === 0x06054b50
    ) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === bytes.length) return offset;
    }
  }
  throw new Error("EPUB ZIP directory not found or invalid");
}

function findZipEntry(bytes, wanted) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findZipEnd(bytes);
  const diskNo = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  let offset = view.getUint32(eocd + 16, true);

  if (diskNo !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error("Multi-disk ZIP is not supported");
  }
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    offset === 0xffffffff
  ) {
    throw new Error("ZIP64 EPUB is not supported");
  }
  if (offset + centralSize > eocd || offset > bytes.length) {
    throw new Error("Invalid ZIP central directory bounds");
  }

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Invalid ZIP central directory entry");
    }

    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;

    if (nextOffset > offset + centralSize || nextOffset > bytes.length) {
      throw new Error("Invalid ZIP entry length");
    }

    const name = new TextDecoder().decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength)
    );

    if (name === wanted) {
      if (flags & 1) throw new Error("Encrypted EPUB entries are not supported");
      if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
        throw new Error("Invalid ZIP local file header");
      }

      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;

      if (dataEnd > bytes.length) throw new Error("Invalid ZIP entry data bounds");
      return {
        method,
        data: bytes.subarray(dataStart, dataEnd),
      };
    }

    offset = nextOffset;
  }

  return null;
}

async function unzipEpubEntry(bytes, path) {
  const entry = findZipEntry(bytes, path);
  if (!entry) throw new Error("EPUB entry not found: " + path);
  if (entry.method === 0) return entry.data;
  if (entry.method !== 8) {
    throw new Error("Unsupported ZIP compression method: " + entry.method);
  }
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Worker runtime lacks DecompressionStream");
  }

  const stream = new Blob([entry.data])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readLimitedBody(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) {
    throw new Error("EPUB exceeds the 40 MB metadata limit");
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new Error("EPUB exceeds the 40 MB metadata limit");
    }
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("EPUB exceeds the 40 MB metadata limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    result.set(chunk, position);
    position += chunk.byteLength;
  }
  return result;
}

async function epubMetadata(request, origin) {
  if (request.method !== "GET") {
    return json({ ok: false, error: "Method Not Allowed" }, 405, origin);
  }

  const url = new URL(request.url);
  const fileId = String(url.searchParams.get("file_id") || "").trim();

  if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) {
    return json({ ok: false, error: "Invalid or missing Google Drive file ID" }, 400, origin);
  }

  try {
    const driveUrl = "https://drive.google.com/uc?export=download&id=" +
      encodeURIComponent(fileId);
    const response = await fetch(driveUrl, { redirect: "follow" });

    if (!response.ok) {
      throw new Error("Google Drive HTTP " + response.status);
    }

    const bytes = await readLimitedBody(response, MAX_EPUB_BYTES);
    if (
      bytes.length < 4 ||
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) !== 0x04034b50
    ) {
      throw new Error("Google Drive did not return an EPUB ZIP file; the file may be private or require a confirmation page");
    }

    const containerBytes = await unzipEpubEntry(bytes, "META-INF/container.xml");
    const containerXml = new TextDecoder("utf-8").decode(containerBytes);
    const rootMatch = containerXml.match(
      /<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i
    );

    if (!rootMatch) {
      throw new Error("Cannot locate OPF package document in container.xml");
    }

    const opfPath = decodeXmlEntities(rootMatch[1]);
    const opfBytes = await unzipEpubEntry(bytes, opfPath);
    const opfXml = new TextDecoder("utf-8").decode(opfBytes);

    return json({
      ok: true,
      file_id: fileId,
      title: xmlText(opfXml, "title"),
      author: xmlText(opfXml, "creator"),
      size: bytes.byteLength,
    }, 200, origin);
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error),
    }, 502, origin);
  }
}


export default {
  async fetch(request, env) {
    const origin = requestOrigin(request, env);

    if (!origin) {
      return json(
        {
          ok: false,
          error: "Origin không được phép",
        },
        403
      );
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: headers(origin),
      });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/metadata") {
        if (!rateLimit(request, "metadata")) {
          return json({ ok: false, error: "Too many requests" }, 429, origin);
        }
        return await epubMetadata(request, origin);
      }

      if (
        request.method === "GET" &&
        url.pathname === "/story/current"
      ) {
        if (!rateLimit(request, "current")) {
          return json(
            {
              ok: false,
              error: "Too many requests",
            },
            429,
            origin
          );
        }

        return json(
          await currentStory(env, url),
          200,
          origin
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/story/crosspoint-previous"
      ) {
        if (!rateLimit(request, "trigger")) {
          return json(
            {
              ok: false,
              error: "Too many requests",
            },
            429,
            origin
          );
        }

        return json(
          await crosspointPrevious(env, request),
          202,
          origin
        );
      }

      if (
        request.method === "GET" &&
        url.pathname === "/story/current-by-user"
      ) {
        if (!rateLimit(request, "current")) {
          return json(
            {
              ok: false,
              error: "Too many requests",
            },
            429,
            origin
          );
        }

        return json(
          await currentStoryByUser(env, url),
          200,
          origin
        );
      }

      if (
        request.method === "GET" &&
        url.pathname === "/story/operation"
      ) {
        if (!rateLimit(request, "operation")) {
          return json(
            {
              ok: false,
              error: "Too many requests",
            },
            429,
            origin
          );
        }

        return json(
          await operation(env, url),
          200,
          origin
        );
      }

      if (
        request.method === "GET" &&
        url.pathname === "/story/sources"
      ) {
        if (!rateLimit(request, "current")) {
          return json(
            {
              ok: false,
              error: "Too many requests",
            },
            429,
            origin
          );
        }

        return json(
          await sources(env),
          200,
          origin
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/story/trigger"
      ) {
        requireTriggerToken(request, env);

        if (!rateLimit(request, "trigger")) {
          return json(
            {
              ok: false,
              error: "Too many requests",
            },
            429,
            origin
          );
        }

        const body = await request.json();
        const action = String(
          body.action || ""
        ).trim().toLowerCase();

        if (
          action !== "next" &&
          action !== "previous"
        ) {
          return json(
            {
              ok: false,
              error: "Unsupported trigger action",
            },
            400,
            origin
          );
        }

        return json(
          await createRequest(
            env,
            body,
            action
          ),
          202,
          origin
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/story/crosspoint-next"
      ) {
        if (!rateLimit(request, "trigger")) {
          return json(
            {
              ok: false,
              error: "Too many requests",
            },
            429,
            origin
          );
        }

        return json(
          await crosspointNext(env, request),
          202,
          origin
        );
      }

      if (request.method === "POST") {
        const body = await request.json();
        const action = url.pathname.replace(
          /^\/story\//,
          ""
        );

        if (
          ![
            "register",
            "next",
            "previous",
            "jump",
          ].includes(action)
        ) {
          return json(
            {
              ok: false,
              error: "Unsupported story action",
            },
            404,
            origin
          );
        }

        if (!rateLimit(request, action)) {
          return json(
            {
              ok: false,
              error: "Too many requests",
            },
            429,
            origin
          );
        }

        return json(
          await createRequest(
            env,
            body,
            action
          ),
          202,
          origin
        );
      }

      return json(
        {
          ok: false,
          error: "Not found",
        },
        404,
        origin
      );
    } catch (error) {
      const status = error.status || 500;

      return json(
        {
          ok: false,
          error: error.message || String(error),
          stage: error.stage || null,
        },
        status,
        origin
      );
    }
  },
};
