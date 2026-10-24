# Tàng Thư Story Worker — Phase 1

Cloudflare Worker riêng cho Story, cùng mô hình với `tangthu-news-worker`.

## Vai trò

- Nhận yêu cầu từ `tangthu-opds`.
- Ghi request queue vào `tangthu-story-scraper/story-cache/requests/`.
- Phát `repository_dispatch` `story-request` sang `tangthu-story-scraper`.
- Đọc story cache và operation status để frontend polling.
- Cung cấp `/story/sources`.

Worker **không scrape, không build EPUB, không ghi Google Drive**.

## Secret

`GITHUB_TOKEN`: token GitHub có quyền Contents + Actions phù hợp trên:
- `Zenkjt/tangthu-story-scraper`

## API

- `POST /story/register`
- `POST /story/next`
- `POST /story/previous`
- `POST /story/jump`
- `GET /story/operation?request_id=...`
- `GET /story/current?user_id=...&story_id=...`
- `GET /story/sources`

## Async

POST trả `202 + request_id`; frontend polling `/story/operation`.

Khi `operation.status == completed`, `operation.story` chứa Story view.
