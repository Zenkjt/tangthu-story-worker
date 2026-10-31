import app from "./index.js";

const BRANCHES_URL =
  "https://raw.githubusercontent.com/Zenkjt/tangthu-opds/main/config/branches.json";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function loadBranches() {
  const response = await fetch(BRANCHES_URL, {
    cf: { cacheTtl: 60, cacheEverything: true },
  });

  if (!response.ok) {
    throw new Error(`Không đọc được branches.json: HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data || !Array.isArray(data.branches)) {
    throw new Error("branches.json không hợp lệ");
  }

  return data.branches;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (
      request.method === "POST" &&
      url.pathname === "/story/crosspoint-trigger"
    ) {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "JSON không hợp lệ" }, 400);
      }

      const shelfNo = Number(body && body.shelf_no);
      const direction = String(
        (body && body.direction) || ""
      ).trim().toLowerCase();

      if (!Number.isInteger(shelfNo) || shelfNo < 1) {
        return json({ ok: false, error: "shelf_no không hợp lệ" }, 400);
      }

      if (direction !== "next" && direction !== "previous") {
        return json({ ok: false, error: "direction không hợp lệ" }, 400);
      }

      try {
        const branches = await loadBranches();
        const branch = branches.find(
          (item) => Number(item && item.shelf_no) === shelfNo
        );

        if (!branch) {
          return json(
            { ok: false, error: `Không tìm thấy tủ #${shelfNo}` },
            404
          );
        }

        if (branch.enabled === false) {
          return json(
            { ok: false, error: `Tủ #${shelfNo} đang bị vô hiệu hóa` },
            403
          );
        }

        const userId = String(branch.id || "").trim();
        const folderId = String(branch.root_folder_id || "").trim();

        if (!userId || !folderId) {
          return json(
            {
              ok: false,
              error: `Tủ #${shelfNo} thiếu id hoặc root_folder_id`,
            },
            500
          );
        }

        // Delegate to the existing authenticated /story/trigger path.
        // CrossPoint never receives or stores STORY_TRIGGER_TOKEN.
        const internalRequest = new Request(
          new URL("/story/trigger", request.url),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${String(
                env.STORY_TRIGGER_TOKEN || ""
              ).trim()}`,
            },
            body: JSON.stringify({
              user_id: userId,
              folder_id: folderId,
              action: direction,
            }),
          }
        );

        return app.fetch(internalRequest, env, ctx);
      } catch (error) {
        return json(
          {
            ok: false,
            error: error.message || String(error),
          },
          502
        );
      }
    }

    return app.fetch(request, env, ctx);
  },
};
