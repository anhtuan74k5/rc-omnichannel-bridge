# Rocket.Chat Omnichannel Bridge

Bridge Node.js kết nối Telegram và Facebook Messenger với Rocket.Chat
Omnichannel qua các API Livechat `/api/v1/livechat/*`.

Bridge đảm nhiệm:

- Nhận tin nhắn từ Telegram/Facebook và chuyển vào visitor room trên
  Rocket.Chat.
- Polling tin nhắn mới của agent từ Rocket.Chat rồi gửi ngược về đúng nền tảng.
- Chuyển text, emoji, ảnh, file, video, voice, audio, GIF và sticker tĩnh.
- Lưu mapping visitor/room để tiếp tục sử dụng sau khi restart.
- Hỏi đáp bằng AI và tài liệu riêng theo từng người dùng.

Cả Telegram và Facebook Messenger đều hỗ trợ media hai chiều (xem các mục bên
dưới).

## Kiến trúc

```text
Telegram Bot ────────┐
                     ├──► Bridge Express ──► Rocket.Chat Omnichannel
Facebook Messenger ──┘          ▲
                                │
             polling tin nhắn agent mỗi 10 giây
                                │
                    Telegram Bot API / Facebook Graph API
```

Các route Rocket.Chat được sử dụng chỉ thuộc namespace
`/api/v1/livechat/*`.

## Yêu cầu

- Node.js 22 trở lên.
- Rocket.Chat đang chạy và có tài khoản agent hoặc Personal Access Token.
- Bot Telegram nếu dùng Telegram.
- Facebook Page và Page Access Token nếu dùng Facebook.
- API key tương thích OpenAI nếu bật AI.

## Cài đặt

```powershell
cd D:\Github\rc-omnichannel-bridge
npm install
Copy-Item .env.example .env
```

Mở `.env` và điền các biến bắt buộc, sau đó khởi động:

```powershell
npm start
```

Chạy chế độ tự khởi động lại khi phát triển:

```powershell
npm run dev
```

Mặc định bridge lắng nghe tại `http://localhost:3000`. Nếu cổng 3000 đã được
Rocket.Chat sử dụng, đặt:

```env
PORT=3001
```

Rocket.Chat URL vẫn phải trỏ tới server Rocket.Chat, ví dụ:

```env
ROCKETCHAT_URL=http://localhost:3000
```

## Cấu hình môi trường

### Rocket.Chat

| Biến | Bắt buộc | Mô tả |
|---|---:|---|
| `ROCKETCHAT_URL` | Có | URL Rocket.Chat |
| `ROCKETCHAT_AUTH_TOKEN` | Một trong hai nhóm | Personal Access Token |
| `ROCKETCHAT_USER_ID` | Cùng nhóm trên | User ID đi cùng Personal Access Token |
| `ROCKETCHAT_AGENT_USERNAME` | Nhóm thay thế | Tài khoản agent để đăng nhập |
| `ROCKETCHAT_AGENT_PASSWORD` | Nhóm thay thế | Mật khẩu tài khoản agent |
| `ROCKETCHAT_DEPARTMENT_ID` | Không | Department gán cho visitor |

Nếu có cả `ROCKETCHAT_AUTH_TOKEN` và `ROCKETCHAT_USER_ID`, bridge ưu tiên
Personal Access Token thay cho username/password.

### Telegram

| Biến | Bắt buộc | Mô tả |
|---|---:|---|
| `TELEGRAM_BOT_TOKEN` | Có khi dùng Telegram | Token do BotFather cấp |
| `TELEGRAM_POLLING` | Không | Bật `true` để nhận update bằng `getUpdates` |
| `TELEGRAM_POLL_INTERVAL_MS` | Không | Chu kỳ polling, mặc định 2000 ms |
| `TELEGRAM_WEBHOOK_SECRET` | Khuyến nghị khi dùng webhook | Secret kiểm tra header Telegram |
| `TELEGRAM_WEBHOOK_URL` | Khi dùng helper | URL public của `/webhook/telegram` |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Không | Danh sách chat ID, phân cách bằng dấu phẩy |
| `TELEGRAM_MAX_DOCUMENT_BYTES` | Không | Giới hạn document, mặc định 100 MB |
| `TELEGRAM_RENDER_MARKDOWN` | Không | Mặc định `true`; đặt `false` để gửi tin agent dạng text thô |
| `ROCKETCHAT_POLL_INTERVAL_MS` | Không | Chu kỳ polling Rocket.Chat, tối thiểu 10000 ms |
| `ROCKETCHAT_POLL_MAX_CALLS_PER_MINUTE` | Không | Ngân sách số lần gọi `messages.history` mỗi phút cho **tất cả** phòng, mặc định 8 (ngưỡng mặc định của Rocket.Chat là 10) |
| `ROCKETCHAT_HOT_WINDOW_MS` | Không | Phòng được coi là "đang hoạt động" trong khoảng này sau tin cuối, mặc định 10 phút |

Polling chia sẻ ngân sách giữa các phòng: mỗi lượt chỉ poll số phòng vừa đủ ngân
sách, ưu tiên phòng đang hoạt động nhưng phòng yên tĩnh vẫn đến lượt. Vì vậy độ
trễ agent → khách tăng theo số phòng (khoảng `số phòng × chu kỳ` khi không có phòng
nào đang hoạt động). Muốn nhanh hơn với nhiều phòng, tăng giới hạn ở Rocket.Chat
(Administration → Settings → Rate Limiter → API) rồi tăng
`ROCKETCHAT_POLL_MAX_CALLS_PER_MINUTE` tương ứng.

`TELEGRAM_ALLOWED_CHAT_IDS` để trống nghĩa là cho phép mọi chat ID.

Khi không bật polling và chưa đặt `TELEGRAM_WEBHOOK_SECRET`, bridge ghi cảnh
báo lúc khởi động vì webhook không có xác thực secret.

### Facebook Messenger

| Biến | Bắt buộc | Mô tả |
|---|---:|---|
| `FB_PAGE_ACCESS_TOKEN` | Có khi dùng Facebook | Page Access Token |
| `FB_PAGE_ID` | Không | Page ID |
| `FB_VERIFY_TOKEN` | Có khi bật webhook Facebook | Token xác minh webhook |
| `FB_APP_SECRET` | Khuyến nghị | App Secret để kiểm tra chữ ký `X-Hub-Signature-256` |
| `FB_MAX_MEDIA_BYTES` | Không | Giới hạn file Facebook, mặc định 25 MB (giới hạn của Messenger) |

`FB_VERIFY_TOKEN` và `FB_APP_SECRET` không được ghi vào log.

### Bảo vệ API tài liệu

| Biến | Bắt buộc | Mô tả |
|---|---:|---|
| `ADMIN_API_KEY` | Khi dùng API tài liệu | Khóa Bearer cho `/documents` |

Nếu chưa đặt `ADMIN_API_KEY`, hai endpoint tài liệu bị vô hiệu hóa và trả
`503`, không mở truy cập tự do.

### AI và tài liệu

| Biến | Mặc định | Mô tả |
|---|---|---|
| `AI_ENABLED` | `false` | Bật AI tự trả lời |
| `AI_API_KEY` | Rỗng | API key tương thích OpenAI |
| `AI_BASE_URL` | `https://api.openai.com/v1` | URL API AI |
| `AI_MODEL` | `gpt-4o-mini` | Tên model |
| `AI_BUSINESS_CONTEXT` | Rỗng | Thông tin doanh nghiệp được phép dùng |
| `AI_HANDOFF_MESSAGE` | Theo `constants/messages.js` | Tin nhắn chuyển cho agent |
| `REQUEST_BODY_LIMIT` | `2mb` | Giới hạn body Express |
| `DOCUMENT_CHUNK_SIZE` | `1200` | Kích thước đoạn tài liệu |
| `DOCUMENT_CHUNK_OVERLAP` | `150` | Phần chồng lấn giữa các đoạn |
| `DOCUMENT_TOP_K` | `4` | Số đoạn dùng khi truy vấn |
| `DOCUMENT_SUMMARY_TOP_K` | `8` | Số đoạn dùng khi tóm tắt |

AI chỉ sử dụng thông tin trong `AI_BUSINESS_CONTEXT` hoặc tài liệu của đúng
platform và platform user ID. Khi không đủ thông tin, AI chuyển cuộc hội thoại
cho agent thay vì tự bịa.

### Vận hành và timeout

| Biến | Mặc định | Mô tả |
|---|---:|---|
| `PORT` | `3000` | Cổng Express của bridge |
| `HTTP_TIMEOUT_MS` | `15000` | Timeout request HTTP thông thường |
| `HTTP_UPLOAD_TIMEOUT_MS` | `120000` | Timeout tải lên/tải xuống media |
| `DEBUG_POLLING` | `false` | Ghi log request polling |
| `DEBUG_DUMP_PAYLOADS` | `false` | Dump có chọn lọc payload media |
| `TZ` | `Asia/Bangkok` | Múi giờ tiến trình |

## Telegram: polling hoặc webhook

### Polling local

```env
TELEGRAM_POLLING=true
TELEGRAM_BOT_TOKEN=<token-cua-ban>
```

Bridge sẽ gọi `getUpdates` theo chu kỳ và tự giữ offset khi handler lỗi để
update có thể được thử lại. Update đã xử lý được chống trùng trong bộ nhớ.

### Webhook

Đặt URL public và secret:

```env
TELEGRAM_POLLING=false
TELEGRAM_WEBHOOK_URL=https://example.com/webhook/telegram
TELEGRAM_WEBHOOK_SECRET=mot-secret-dai
```

Đăng ký webhook bằng helper:

```powershell
npm run tg:set-webhook
```

Helper gửi `secret_token` nếu đã cấu hình và luôn gửi danh sách
`allowed_updates` được bridge hỗ trợ.

Route webhook:

```text
POST /webhook/telegram
```

Request không có secret hoặc có secret sai trả `401` và không được xử lý.

## Định dạng tin nhắn agent → Telegram

Tin nhắn của agent (và caption kèm file) được chuyển từ Markdown của
Rocket.Chat sang HTML của Telegram (`parse_mode: "HTML"`):

| Rocket.Chat | Telegram |
|---|---|
| `*đậm*` hoặc `**đậm**` | **đậm** |
| `_nghiêng_` hoặc `__nghiêng__` | _nghiêng_ |
| `~gạch~` hoặc `~~gạch~~` | ~~gạch~~ |
| `` `code` `` | code inline |
| ```` ```code``` ```` (có thể kèm ngôn ngữ) | khối code |
| `[nhãn](https://...)` | liên kết (chỉ `http`, `https`, `tg`, `mailto`) |

Nguyên tắc:

- Không định dạng bên trong code; `snake_case_name`, `2 * 3 * 4`, URL chứa `_`
  được giữ nguyên.
- Cú pháp lồng sai hoặc không hợp lệ với Telegram tự động hạ cấp về text, không
  làm mất tin nhắn. Nếu Telegram vẫn trả lỗi parse entities, bridge gửi lại đúng
  nội dung đó dạng text thường một lần.
- Chỉ tin của agent được render. Tin hệ thống, thông báo bridge và câu trả lời AI
  luôn gửi nguyên văn.
- Tin dài được tách theo nguồn Markdown (giới hạn 4096 ký tự, caption 1024) và
  fence ``` bị cắt giữa chừng được đóng/mở lại ở chunk kế tiếp.
- Đặt `TELEGRAM_RENDER_MARKDOWN=false` để tắt hoàn toàn và quay về text thô.

## Facebook Messenger

Đăng ký callback URL trong Meta for Developers:

```text
GET  https://<domain>/webhook/facebook
POST https://<domain>/webhook/facebook
```

Khi xác minh, Meta phải gửi đúng `FB_VERIFY_TOKEN`. Cần dùng HTTPS public khi
đăng ký webhook thật; có thể dùng ngrok cho môi trường phát triển:

```powershell
ngrok http 3001
```

Thay `3001` bằng giá trị `PORT` thực tế của bridge.

Để không phải đổi callback URL mỗi lần chạy, dùng domain cố định: ngrok static
domain miễn phí (`ngrok http --url=<ten>.ngrok-free.app 3001`) hoặc Cloudflare
Tunnel.

### Xác thực webhook

Khi đặt `FB_APP_SECRET`, mọi `POST /webhook/facebook` phải có header
`X-Hub-Signature-256` đúng (HMAC-SHA256 của body thô); sai hoặc thiếu trả `401`
và không được xử lý. Nếu để trống, bridge ghi cảnh báo lúc khởi động vì webhook
không được xác thực.

### Xử lý webhook: trả lời nhanh, đúng thứ tự, không trùng

Bridge trả `200` ngay sau khi kiểm tra chữ ký, rồi xử lý trong hàng đợi:

- Meta chỉ chờ khoảng 20 giây; AI hoặc Rocket.Chat chậm sẽ không làm Meta gửi lại.
- Tin của **cùng một khách** được xử lý tuần tự đúng thứ tự đến; các khách khác xử
  lý song song.
- Tin Meta gửi lại (cùng `message.mid`) bị bỏ qua, kể cả sau khi khởi động lại (id
  lưu trong `mapping.json`, giữ 100 id gần nhất mỗi khách).
- Khi dừng bridge bằng Ctrl+C/SIGTERM, bridge chờ tối đa 10 giây để xử lý nốt hàng
  đợi.
- Hệ quả: lỗi xử lý nền không còn trả `500` cho Meta; xem log `[facebook]`.

### Hội thoại: AI, phòng đóng, lỗi gửi, tin sửa

- **AI nhường cho agent.** Khi AI chuyển cuộc trò chuyện cho agent (hoặc agent đã trả
  lời), AI im lặng trong phòng đó `AI_RESUME_AFTER_MINUTES` phút (mặc định 30) và chỉ
  thông báo chuyển agent **một lần**. Khách gõ `/bot` để bật lại AI. AI chậm quá
  `AI_TIMEOUT_MS` thì chuyển cho agent.
- **Agent đóng phòng.** Bridge phát hiện tin hệ thống `livechat-close`, ngừng poll phòng
  đó, và tin tiếp theo của khách tự mở **phòng mới** (kể cả khi gửi tin bị Rocket.Chat
  trả `room-closed`). Trạng thái AI của phòng cũ được xóa.
- **Gửi thất bại.** Lỗi được phân loại: tạm thời (mạng, 5xx, giới hạn tốc độ) thì thử lại
  tối đa `ROCKETCHAT_MAX_MESSAGE_RETRIES` lần; vĩnh viễn (khách chặn bot, ngoài cửa sổ
  24 giờ của Messenger, nội dung bị từ chối) thì dừng ngay. Khi bỏ cuộc, bridge đăng
  `⚠️ [Bridge] Không gửi được …` **vào phòng** để agent biết. Lỗi token (Facebook `190`,
  Telegram `401`) in `[ALERT]` ra log.
- **Khách sửa tin Telegram.** Bản sửa đến phòng dạng `✏️ (khách đã sửa tin) …`, không
  chạy AI và không trả lời lại. Sửa chú thích ảnh/file bị bỏ qua.
- **Tin dài.** Tin agent gửi Facebook được bỏ ký hiệu Markdown và tách ≤ 2000 ký tự,
  ưu tiên cắt ở ranh giới dòng.
- **Sticker Facebook.** Meta gửi mỗi sticker hai lần (`image` và `sticker`); bridge chỉ
  tải một ảnh.

### Media

| Hướng | Hỗ trợ |
|---|---|
| Facebook → Rocket.Chat | Ảnh, video, audio, file (tải từ CDN của Meta rồi upload vào room); vị trí gửi dạng link bản đồ |
| Rocket.Chat → Facebook | Ảnh, GIF (gửi như ảnh), video, audio/voice, file qua Send API |

- Messenger không có caption: text kèm file được gửi thành tin nhắn riêng ngay
  sau file.
- Chỉ tải URL `https` thuộc `fbcdn.net`, `fbsbx.com`, `facebook.com`; URL khác bị
  từ chối.
- File vượt `FB_MAX_MEDIA_BYTES` bị từ chối và khách nhận thông báo.
- Page Access Token được gửi qua header `Authorization`, không nằm trong URL.
- Webhook cần đăng ký field `messages` (và `message_echoes` là không bắt buộc;
  tin echo luôn bị bỏ qua).

## API của bridge

| Phương thức | Đường dẫn | Mục đích |
|---|---|---|
| `GET` | `/health` | Kiểm tra trạng thái và số room đang hoạt động |
| `GET` | `/webhook/facebook` | Xác minh webhook Facebook |
| `POST` | `/webhook/facebook` | Nhận sự kiện Facebook |
| `POST` | `/webhook/telegram` | Nhận update Telegram |
| `POST` | `/documents/upload` | Upload tài liệu cho một user |
| `GET` | `/documents` | Liệt kê tài liệu của một user |

Hai endpoint `/documents` yêu cầu:

```http
Authorization: Bearer <ADMIN_API_KEY>
```

Ví dụ upload tài liệu:

```powershell
curl.exe -X POST "http://localhost:3001/documents/upload" `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer <ADMIN_API_KEY>" `
  -d '{"platform":"telegram","platformUserId":"222333444","filename":"faq.md","content":"Giờ làm việc: 8:00-17:00 từ thứ Hai đến thứ Sáu."}'
```

Đổi `3001` thành cổng bridge thực tế. Tài liệu được phân vùng theo:

```text
platform + platformUserId
```

Các phần mở rộng tài liệu được hỗ trợ gồm `.txt`, `.md`, `.csv`, `.tsv`,
`.json`, `.jsonl`, `.html`, `.htm`, `.xml`, `.yaml`, `.yml`, `.log`, `.ini`,
`.conf`, `.env`, `.pdf` và `.docx`.

## Text, emoji và media

- Shortcode đã biết như `:smile:` và `:thumbsup:` được đổi thành emoji khi gửi
  sang Telegram.
- Shortcode không nhận ra được giữ nguyên.
- Inline code và fenced code không bị chuyển shortcode.
- Text Telegram được chuẩn hóa Unicode NFC khi chuyển vào Rocket.Chat.
- Tin Telegram dài hơn 4096 ký tự được tách theo xuống dòng/khoảng trắng.
- Bộ tách dùng grapheme cluster để không cắt đôi emoji ghép hoặc cờ.
- JSON gửi đi sử dụng UTF-8.
- Caption media sử dụng cùng quy tắc định dạng text.
- Telegram không dùng `parse_mode`; Markdown Rocket.Chat có thể hiển thị dạng
  raw trên Telegram. Đây là lựa chọn chủ đích để tránh lỗi escape.

Media Telegram nhận vào được hỗ trợ gồm:

- Ảnh.
- File/document.
- Video.
- Voice.
- Audio, gồm MP3.
- Animation/GIF.
- Video note.
- Sticker tĩnh WebP.

Sticker động và sticker video được nhận diện là chưa hỗ trợ. Media tải xuống
Telegram mặc định bị giới hạn 20 MB; document Telegram có giới hạn riêng
100 MB.

## AI tự động và chuyển agent

Khi `AI_ENABLED=true`, bridge gửi câu hỏi vào API AI trước khi chuyển cho agent:

1. Nếu AI trả lời được, câu trả lời được gửi về nền tảng và ghi vào room
   Rocket.Chat.
2. Nếu AI không trả lời được, bridge gửi `AI_HANDOFF_MESSAGE` cho khách và
   chuyển hội thoại cho agent.
3. Nếu AI tắt hoặc thiếu API key, tin nhắn đi thẳng tới agent.

Bridge cũng hỗ trợ tra cứu tài liệu đã upload theo đúng user, không trộn dữ
liệu giữa các cuộc hội thoại.

## Log, retry và dữ liệu lưu trữ

- Request HTTP dùng timeout và policy retry tập trung.
- Polling Rocket.Chat mặc định mỗi 10 giây; khi nhận 429, bridge tạm dừng theo
  thời gian Rocket.Chat yêu cầu.
- GET có thể retry lỗi mạng, timeout, 429 và 5xx theo caller; POST mặc định
  không retry để tránh gửi trùng.
- Telegram tôn trọng `retry_after` khi nhận 429.
- Token, password, authorization và visitor token được mask trong logger.
- Nội dung đầy đủ của tin nhắn không được ghi vào log polling.
- Mapping visitor/room được lưu trong `mapping.json`.
- Ghi mapping dùng file tạm rồi rename để giảm rủi ro file dở dang.
- Payload media debug được ghi vào `debug-dumps/` khi bật
  `DEBUG_DUMP_PAYLOADS=true`; token trong payload được redact.
- `debug-dumps/` không được commit.

## Kiểm thử

Chạy toàn bộ test:

```powershell
npm test
```

Bộ test hiện có kiểm tra:

- Mask thông tin nhạy cảm.
- Timeout, retry HTTP, retry Telegram 429 và chính sách không retry POST.
- Phân loại và gửi các loại media Telegram.
- Fallback ảnh sang document khi Telegram trả lỗi phù hợp.
- Chuyển shortcode, bảo toàn code, NFC và tách text dài.
- Không cắt đôi emoji ghép.
- Trao đổi JSON UTF-8 với server giả lập Telegram/Rocket.Chat.

Checklist kiểm thử thủ công nằm tại
[scripts/smoke.md](scripts/smoke.md), gồm text, emoji, ảnh, PDF, video, voice,
MP3, GIF, sticker, file lớn, restart và mất mạng.

## Xử lý lỗi thường gặp

### `fetch failed` khi polling Rocket.Chat

Kiểm tra:

1. Rocket.Chat có đang chạy không.
2. `ROCKETCHAT_URL` có đúng host và port không.
3. Port bridge và port Rocket.Chat có bị trùng không.
4. Từ máy chạy bridge có truy cập được `ROCKETCHAT_URL` không.
5. Personal Access Token/User ID hoặc thông tin agent có còn hiệu lực không.

Ví dụ khi Rocket.Chat chạy ở cổng 3000 và bridge chạy ở cổng 3001:

```env
ROCKETCHAT_URL=http://localhost:3000
PORT=3001
```

### `/documents` trả `503`

Đặt `ADMIN_API_KEY` rồi khởi động lại bridge. Mọi request phải gửi header
`Authorization: Bearer <ADMIN_API_KEY>`.

### Webhook Telegram trả `401`

Kiểm tra giá trị `TELEGRAM_WEBHOOK_SECRET` trên bridge có trùng với secret đã
đăng ký trong Telegram hay không.

## Giới hạn hiện tại

- Facebook Messenger hiện chỉ xử lý text ở chiều nhận.
- Telegram không dùng `parse_mode`, nên Markdown Rocket.Chat hiển thị dạng
  raw ở Telegram.
- Media tải xuống mặc định giới hạn 20 MB.
- Voice có thể có khác biệt khi phát trên một số trình duyệt, đặc biệt Safari.
- Sticker động và sticker video chưa được chuyển như sticker động.
- Test dùng mock/local server; vẫn cần chạy smoke checklist với Telegram và
  Rocket.Chat thật.

## Cấu trúc chính

```text
index.js                 Express server, route và vòng polling
telegram.js              Telegram webhook, polling và gửi media
facebook.js              Facebook webhook và gửi text
rocketchat.js            Rocket.Chat Livechat API
textFormat.js            Chuẩn hóa text, shortcode và tách grapheme
documents.js              Lưu/index tài liệu theo từng user
mapping.js                Lưu mapping visitor và room
media/                    Tải, phân loại và chuyển media
constants/                Cấu hình, message và error
test/                     Bộ test node:test
scripts/smoke.md          Checklist kiểm thử thủ công
```
