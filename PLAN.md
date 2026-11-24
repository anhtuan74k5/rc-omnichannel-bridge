# PLAN: Kiểm thử toàn diện và khắc phục bridge Rocket.Chat ↔ Telegram / Facebook

Trạng thái: **KẾ HOẠCH, chưa thực thi bất kỳ bài kiểm thử nào.** Mục 1–3 là đánh giá
dựa trên đọc mã và quan sát log của phiên đang chạy (chỉ đọc, không gửi tin). Mục
4–8 là kế hoạch kiểm thử và khắc phục sẽ làm sau khi bạn duyệt (mục 9).

Phạm vi phiên kiểm thử:

- Bridge: `npm run dev` ở `PORT=3001`, Telegram dùng polling, Facebook dùng webhook qua
  ngrok `https://haphazard-spinal-gradation.ngrok-free.dev`.
- Rocket.Chat (Docker) `http://localhost:3000`.
- Phòng Telegram: `http://localhost:3000/live/4qNnCwMv6fRSRyL7R/room-info`
- Phòng Facebook: `http://localhost:3000/live/mzKxWtEWomJp9g3zZ/room-info`
- Giao diện: Telegram Web, Facebook Messenger (Page OmniChannel) và Rocket.Chat đã
  đăng nhập sẵn trong Chrome.

---

## 1. Hiện trạng quan sát được (bằng chứng)

Nguồn: `bridge.log`, lịch sử request của ngrok, `mapping.json` (đã che giá trị).

| Quan sát | Kết luận |
|---|---|
| Meta đã gửi `POST /webhook/facebook` tới bridge (nhiều request, `200`, 2 ms–2,2 s) | Webhook Facebook **đã lưu và hoạt động** |
| Log `[rocketchat] Visitor file uploaded successfully` cho room Facebook (file, ảnh) | Facebook → Rocket.Chat **file/ảnh chạy thật** |
| Log `[ai] AI auto-replied to facebook:…` rồi `[facebook] Message sent` | Gửi text ra Messenger **chạy thật** (token và quyền đúng) |
| Log `[facebook] Received attachment { type: 'sticker' }` rồi tin `[Facebook sticker] … cannot forward` trong room | **Sticker bị bỏ**, xem G3 |
| 11 dòng `Rocket.Chat API error 429 … wait 10 seconds` ở room Telegram | **Polling bị rate-limit**, xem G1 |
| Nhiều log `AI cannot handle, handing off to agent` lặp lại cho cùng một khách | AI chen vào mỗi tin, xem G5 |
| `.env`: `AI_ENABLED=true`, `ROCKETCHAT_POLL_INTERVAL_MS=10000`, `TELEGRAM_POLLING=true`, `REQUEST_BODY_LIMIT=100mb` | Cấu hình ảnh hưởng thiết kế bài test, xem mục 4 và G12 |
| `mapping.json` có 2 entry (1 Telegram, 1 Facebook) | Hiện chỉ 2 phòng thật |

Lưu ý: [CODEBASE_AUDIT_REPORT.md](CODEBASE_AUDIT_REPORT.md) **đã lỗi thời**: phần lớn
rủi ro nêu trong đó đã được sửa (xem mục 2). Nên đánh dấu lỗi thời hoặc xóa file này
sau khi hoàn tất.

---

## 2. Đã làm được và đã khắc phục

Cột "Mức xác nhận": **Live** = thấy trong log phiên thật; **Test** = có unit test tự
động (54/54 pass); **Đọc mã** = chỉ xác nhận bằng đọc code, chưa chạy thật.

### 2.1 Chức năng

| Hạng mục | Telegram | Facebook | Mức xác nhận |
|---|---|---|---|
| Nhận text | Có (polling + webhook) | Có | TG Live; FB Live |
| Gửi text agent → khách | Có, render Markdown → HTML, tách tin dài | Có (text thuần) | TG Live; FB Live (qua AI) |
| Nhận ảnh/video/voice/audio/GIF/sticker tĩnh/file | Có | Ảnh, video, audio, file có; **sticker không** | FB ảnh/file Live; còn lại Test/Đọc mã |
| Gửi ảnh/GIF/video/audio/voice/file agent → khách | Có (đúng endpoint theo loại) | Có (Send API upload) | Test (mock); **chưa Live** |
| Caption | Có (≤1024, phần dư gửi thành text) | Gửi thành tin text riêng sau file | Test |
| Giới hạn kích thước | 20 MB media, 100 MB document, 50 MB gửi ra | 25 MB (giới hạn Messenger) | Test |
| Tài liệu cho AI (RAG): PDF/DOCX/text | Có | Chưa (FB chỉ upload vào Rocket.Chat, không index) | TG Live |
| AI tự trả lời và chuyển agent | Có | Có | Live |
| Dấu thời gian `<t:…>` đọc được | Có (date entity) | Chuyển thành text | Test |
| Lưu mapping qua restart | Có | Có | Live |

### 2.2 Độ tin cậy và bảo mật (so với audit cũ)

| Rủi ro trong audit | Trạng thái hiện tại |
|---|---|
| Webhook Telegram không xác thực | Đã có `TELEGRAM_WEBHOOK_SECRET` (`timingSafeEqual`) |
| Webhook Facebook không xác thực | **Đã có** `X-Hub-Signature-256` + `FB_APP_SECRET`; Live: không chữ ký → 401, đúng chữ ký → 200 |
| `/documents/*` không auth | Đã có `ADMIN_API_KEY` (mặc định tắt, trả 503) |
| Không timeout / retry | Đã có `fetchWithTimeout`, retry có backoff, tôn trọng `retry_after` |
| Telegram `lastUpdateId` tiến trước khi xử lý xong | Đã giữ offset để retry, tối đa `TELEGRAM_MAX_UPDATE_RETRIES` |
| Poll chỉ dựa timestamp | Đã thêm `processedMessageIds` + retry đếm theo từng tin/attachment |
| Mapping không an toàn đồng thời | Đã có mutex theo user + ghi file nguyên tử (tmp + rename) |
| Log lộ token | Đã che bằng `logger.mask` (đã Live: `token=***`) |
| Facebook token trên URL | Đã chuyển sang header `Authorization` |
| SSRF khi tải media Facebook | Chỉ chấp nhận `https` + `*.fbcdn.net`, `*.fbsbx.com`, `*.facebook.com` |
| Token Facebook hết hạn | Đã thay bằng Page token không hết hạn (`fb:check` kiểm tra) |
| Media chưa có kiến trúc | Đã có `media/` (mime, types, telegramFiles, facebookFiles, rocketchatFiles) |

---

## 3. Thiếu sót và vấn đề phát hiện (xếp theo mức độ)

Mỗi mục có: nguyên nhân, ảnh hưởng, cách khắc phục, cách kiểm chứng.

### P0: nghiêm trọng, ảnh hưởng đúng vận hành

> **Cập nhật 24/11/2026: G1 (phần ngắn hạn) và G2 đã được sửa**, có test tự động
> (55/55 pass). G1 dài hạn (Omnichannel webhook, gói W9) vẫn để sau.
> - G1: bộ lập lịch `pollScheduler.js` chia ngân sách gọi theo phòng (ưu tiên phòng
>   đang hoạt động, không bỏ đói phòng yên tĩnh, phòng bị 429 được thử lại trước).
>   Live: 0 lỗi 429 sau khi khởi động lại bản mới (trước đó lặp lại ở gần như mọi lượt).
> - G2: `/webhook/facebook` trả `200` ngay; hàng đợi theo từng khách (`keyedQueue.js`);
>   loại trùng theo `message.mid` lưu bền; dừng bridge thì chờ xử lý nốt.
>
> **Kiểm chứng thực tế (24/11/2026, tin Messenger thật + Telegram Web + Rocket.Chat):**
>
> | Kiểm tra | Kết quả |
> |---|---|
> | Webhook Facebook trả lời | `200` trong 1–4 ms (trước đây 0,7–2,2 s) |
> | 3 tin liên tiếp `[TEST P0] A1/A2/A3` | Vào Rocket.Chat đúng thứ tự, không mất, không trùng; AI trả lời cả ba |
> | Phát lại đúng payload thật của Meta (kèm chữ ký thật) | `200`, log `Duplicate delivery ignored`, Rocket.Chat vẫn đúng 1 bản (T-H02) |
> | Agent trả lời đồng thời cả hai phòng (FB + TG) | Cả hai nhận được; Telegram render `*bold* _italic_` đúng; **0 lỗi 429** |
> | Độ trễ agent → khách | Phòng đang chat (FB): ~13 s. Phòng nguội (TG) khi phòng khác đang nóng: 45 s với hệ số 4, **18 s sau khi giảm hệ số xuống 2** |
>
> Giới hạn còn lại: polling vẫn cho độ trễ 10–30 s; chỉ webhook của Rocket.Chat (W9)
> mới đưa xuống dưới 3 s. Chưa kiểm chứng: webhook chậm hơn 20 s thật (T-H01, cần
> mock AI chậm) và media agent → khách (T-F20), thuộc phần kiểm thử toàn diện.

**G1. Polling Rocket.Chat bị rate-limit; có thể "bỏ đói" một phòng**
- Bằng chứng Live: 11 lần `429 … You must wait 10 seconds before trying this endpoint again`.
- Nguyên nhân: mỗi tick gọi `messages.history` cho **từng** phòng liên tiếp; endpoint này
  chỉ cho ~1 lần/10 giây. Với ≥2 phòng, phòng thứ hai luôn dính 429. Vòng lặp lại `break`
  khi gặp 429 và luôn bắt đầu từ cùng một phòng, nên phòng đứng sau có thể **không bao giờ
  được poll** (tin agent không tới khách).
- Ảnh hưởng: agent trả lời nhưng khách không nhận; càng nhiều khách càng tệ; độ trễ tối
  thiểu 10 s.
- Khắc phục (theo thứ tự ưu tiên):
  1. Ngắn hạn: poll **vòng tròn công bằng** (nhớ vị trí phòng đã poll, bắt đầu tiếp từ phòng
     kế tiếp), ghi thời điểm 429 theo endpoint.
  2. Dev: tăng ngưỡng ở Rocket.Chat (Administration → Settings → Rate Limiter → API) và hạ
     `ROCKETCHAT_POLL_INTERVAL_MS`; ghi vào guide.
  3. Dài hạn (khuyến nghị): bỏ polling, dùng **Omnichannel webhook** của Rocket.Chat
     (Administration → Omnichannel → Webhooks, sự kiện tin nhắn agent) để bridge nhận push
     (độ trễ < 1 s, không tốn rate limit). Bridge và Rocket.Chat cùng máy nên không cần tunnel
     (Docker gọi `http://host.docker.internal:3001`). Giữ polling làm phương án dự phòng.
- Kiểm chứng: T-E04, T-P03, T-P04.

**G2. Webhook Facebook xử lý đồng bộ toàn bộ rồi mới trả 200; không chống trùng**
- Nguyên nhân: `app.post('/webhook/facebook')` `await` cả luồng AI + Rocket.Chat + gửi trả
  mới `sendStatus(200)`. Đo được 0,7–2,2 s; nhưng AI chậm hoặc Rocket.Chat treo có thể vượt
  **20 s**, Meta coi là lỗi, **gửi lại** cùng một tin (trùng tin trong Rocket.Chat, AI trả
  lời hai lần) và về lâu dài có thể **tắt webhook**. Không lưu `message.mid` để loại trùng.
- Khắc phục: trả `200` ngay sau khi kiểm tra chữ ký, đưa xử lý vào hàng đợi trong bộ nhớ
  (tuần tự **theo từng người dùng** để giữ thứ tự tin); loại trùng theo `mid` (LRU, lưu cả
  vào `mapping`/file nhỏ để sống qua restart); lỗi cuối cùng ghi vào danh sách "dead letter".
- Kiểm chứng: T-H01, T-H02, T-H09, T-F20.

### P1: cao, sai hành vi người dùng thấy

> **Cập nhật 24/11/2026: G3–G8 đã sửa và kiểm chứng trên giao diện thật** (Messenger,
> Telegram Web, Rocket.Chat), 80/80 test tự động pass. Đính chính G3: sticker **không**
> bị bỏ; ảnh đã vào phòng, chỉ có tin cảnh báo thừa (xem bên dưới).
>
> | Mục | Quan sát trên giao diện (sau khi sửa) |
> |---|---|
> | G3 sticker | Gửi sticker THANKS: xuất hiện **một** ảnh trong phòng, không còn tin "cannot forward". Nguyên nhân thật: Meta gửi mỗi sticker hai attachment (`image` và `sticker`, cùng URL/sticker_id) |
> | G4 tin dài | Tin 4252 ký tự tới Messenger thành 3 phần, mỗi phần cắt ở ranh giới dòng (Đoạn 18/19, 37/38); ký hiệu Markdown bỏ, `snake_case_name` và `2 * 3 * 4` giữ nguyên, link hiện kèm URL. Lần thử đầu cắt giữa dòng, đã sửa bộ tách |
> | G5 AI | Agent đang xử lý: tin khách vào phòng, AI im. `/bot` bật lại AI. Câu khiếu nại: **một** thông báo chuyển agent, tin kế tiếp không có AI/thông báo nữa |
> | G6 phòng đóng | Agent bấm End conversation: bridge ngừng poll phòng. Khách nhắn lại: **phòng mới** `hSenZ5nm…` có tin và câu trả lời AI; agent trả lời trong phòng mới tới được Messenger |
> | G7 lỗi gửi | Khách giả (PSID không tồn tại) + agent trả lời: phòng hiện `⚠️ [Bridge] Không gửi được tin nhắn tới khách trên facebook: Facebook từ chối nội dung (mã 100)`, không thử lại |
> | G8 tin sửa | Sửa tin trên Telegram Web: phòng hiện `✏️ (khách đã sửa tin) …`, AI không trả lời lại |
>
> Kèm theo: AI timeout 30 s (rơi về agent), log AI chỉ ghi độ dài (G10 một phần),
> `scripts/restart-bridge.ps1`. Ghi chú vận hành: không dùng hai `npm run dev` cùng lúc.
>
> Chưa kiểm chứng trên giao diện: lỗi 24 giờ thật, khách chặn bot Telegram, token bị
> thu hồi (đã có test phân loại, chưa có tình huống thật).

**G3. Sticker Facebook bị bỏ**: Meta gửi sticker với `type: 'sticker'` (hoặc `image` kèm
`sticker_id`); mã chỉ nhận `image/video/audio/file`. Live: room nhận tin "cannot forward".
Sửa: coi `sticker` có `payload.url` như ảnh (`.png/.gif`). Thêm test.

**G4. Facebook gửi ra chưa xử lý giới hạn và định dạng**
- Text > 2000 ký tự bị Graph từ chối (Telegram có tách tin, Facebook chưa).
- Markdown của Rocket.Chat hiện nguyên ký hiệu (`*đậm*`, `` `code` ``) vì Messenger không
  hỗ trợ; nên chuyển về text thuần (bỏ ký hiệu, giữ link).
- Sửa: hàm `buildFacebookMessages` tách theo ranh giới câu/đoạn ≤ 2000, loại ký hiệu markdown.

**G5. AI chen vào cả khi agent đã tiếp nhận**
- Log Live: mỗi tin khách mà AI không trả lời được đều gửi lại `AI_HANDOFF_MESSAGE`, kể cả
  khi agent đang chat. AI vẫn có thể "trả lời hộ" xen giữa agent và khách.
- Sửa: lưu **trạng thái handoff** theo phòng: sau khi AI chuyển agent hoặc khi agent đã
  trả lời, **tắt AI** cho phòng đó; chỉ bật lại khi phòng đóng/hết hạn (cấu hình được) hoặc
  khi khách gõ lệnh (ví dụ `/bot`). Chỉ gửi thông báo handoff **một lần**.

**G6. Phòng bị agent đóng: mapping còn trỏ phòng cũ**
- Không có mã phát hiện phòng đóng. Khách nhắn tiếp có thể bị lỗi "routing failed" hoặc rơi
  vào phòng đã đóng.
- Sửa: khi `sendMessage`/`upload` trả lỗi dạng room closed, xóa `roomId` khỏi mapping và
  tạo phòng mới (có giới hạn thử lại); ghi log rõ. Kiểm chứng bằng cách đóng phòng thật
  (T-E07).

**G7. Mất tin âm thầm khi gửi ra thất bại**: sau `ROCKETCHAT_MAX_MESSAGE_RETRIES` lần thất
bại, bridge `markMessageProcessed` (bỏ tin) và chỉ ghi log. Agent không biết khách không
nhận được. Facebook còn có các lỗi đặc thù: ngoài cửa sổ 24 giờ (code 10), người dùng chặn
Page, token bị thu hồi (190) — chưa phân loại.
Sửa: phân loại lỗi Graph/Telegram (tạm thời / vĩnh viễn / cần can thiệp); khi bỏ cuộc, đăng
một **tin hệ thống vào phòng Rocket.Chat** ("Không gửi được tin cho khách: lý do"); lỗi 190
báo to ở log và `/health`; xem xét `HUMAN_AGENT` tag (cần App Review) cho tin ngoài 24 giờ.

**G8. Telegram `edited_message` tạo tin trùng**: bản sửa được coi như tin mới. Chọn chính
sách: bỏ qua, hoặc gửi "✏️ (đã sửa) …". Cần quyết định.

### P2: trung bình

| # | Vấn đề | Cách xử lý |
|---|---|---|
| G9 ✅ | Tên khách hiển thị `FB <psid>` / `TG <id>` | Telegram: lấy `first_name/username` từ update. Facebook: gọi User Profile API (`/{psid}?fields=name`) nếu app có quyền, rơi về `FB <psid>` |
| G10 ✅ | Log AI in nội dung tin khách (`Asking AI to handle: "…"`) | Chỉ log độ dài; mask PII; giữ nguyên nguyên tắc "không log nội dung" |
| G11 ✅ | Không có đo độ trễ/chỉ số vận hành | Thêm log thời gian từng chặng (nhận → RC → gửi), mở rộng `/health` (số phòng, độ sâu hàng đợi, lần poll cuối, số 429, trạng thái token Facebook) |
| G12 ✅ | `REQUEST_BODY_LIMIT=100mb` áp cho **mọi** route, kể cả webhook công khai | Giới hạn nhỏ cho `/webhook/*` (ví dụ 1 MB), lớn chỉ cho `/documents/upload` |
| G13 ✅ | Không giới hạn tốc độ theo khách: một người spam gây tốn tiền AI và đầy phòng | Rate limit theo `platform:userId` (ví dụ 20 tin/phút), vượt thì báo một lần và bỏ qua |
| G14 | ✅ Đã làm (W0). Không thể giả lập lỗi Graph/Telegram: URL cứng trong `constants/config.js` | Cho phép ghi đè `TELEGRAM_API_BASE_URL`, `FB_GRAPH_BASE_URL` để chạy mock server (điều kiện tiên quyết cho kiểm thử lỗi) |
| G15 | ✅ Đã làm (khởi động: `checkToken()` ở `facebook.js`/`telegram.js`; tin hệ thống vào phòng vẫn thuộc W6). Không có kiểm tra sức khỏe token lúc khởi động | Gọi `debug_token`/`/me` khi start, cảnh báo nếu lỗi hoặc sắp hết hạn |
| G16 | ⏳ Chỉ kiểm chứng được ở Live (mock không biết Messenger chấp nhận codec nào; chưa viết code). Facebook voice clip/Telegram voice định dạng khác nhau | Cần kiểm tra Live: Messenger audio có nhận `.ogg` (opus) không; nếu không, chuyển `audio/mp4`/mp3 hoặc gửi dạng file |
| G17 | ngrok free: có trang cảnh báo, giới hạn băng thông, tiến trình phải tự giữ sống | Chấp nhận khi dev; để production dùng VPS (xem README) |
| G18 ✅ | Webhook Telegram vẫn nhận request khi đang chạy polling | Không hại, nhưng nên tắt route hoặc yêu cầu secret khi `TELEGRAM_POLLING=true` |

### P3: cải tiến tùy chọn

- Facebook: `sender_action` (`typing_on`, `mark_seen`), quick replies/postback, reaction, Instagram.
- Telegram: `callback_query`, nút bấm, `location/contact/venue` thành tin có định dạng.
- Chuyển cuộc trò chuyện cho phòng ban/agent cụ thể; giờ làm việc/offline; CSAT khi đóng phòng.
- Hỗ trợ nhiều Page Facebook; lưu transcript.
- Chuyển mapping JSON sang SQLite khi có nhiều phòng hoặc nhiều instance.

---

## 4. Chiến lược kiểm thử

### 4.1 Các tầng

| Tầng | Công cụ | Dùng cho |
|---|---|---|
| L0 Unit | `npm test` (đã có 54 test) | Logic thuần: format, mime, chữ ký, parse webhook |
| L1 Script/API | Node scripts trong `scripts/e2e/` (viết mới) | Mô phỏng Facebook webhook **có chữ ký hợp lệ**, mô phỏng agent trả lời qua REST, đo độ trễ, tải |
| L2 Giao diện | Chrome: Messenger, Telegram Web, Rocket.Chat | Hành vi thật của người dùng và agent, định dạng, media phát được |
| L3 Lỗi | Mock server (G14), `docker stop`, tắt ngrok, rút mạng | Fallback, retry, phục hồi |
| L4 Hiệu năng | Script tải + log thời gian | Độ trễ, thông lượng, rate limit |

Vì sao cần cả hai kiểu Facebook: tin **thật** từ Messenger kiểm chứng đường đi Meta → ngrok →
bridge; tin **mô phỏng có chữ ký** (ký bằng `FB_APP_SECRET`) cho phép bắn hàng loạt, lặp
lại và tạo lỗi mà không phiền tài khoản thật. Telegram thì ngược lại: bot không tự nhắn cho
chính nó được, nên **nhận** phải qua Telegram Web (tin thật). Chỉ riêng kiểm thử tải/lỗi mới
có thể bơm update giả vào `POST /webhook/telegram` (route luôn mở, cần secret nếu có đặt).

### 4.2 Đo độ trễ

Mỗi bài đo dùng một **mã dấu** (uuid ngắn) trong nội dung tin để ghép các mốc:

- **Inbound** (khách → Rocket.Chat): `t0` lúc gửi (script) hoặc lúc bấm gửi (UI, ghi qua
  đồng hồ máy), `t1` lúc tin xuất hiện trong `livechat/messages.history` hoặc `rooms.history`.
- **Outbound** (agent → khách): `t0` lúc agent gửi (REST), `t1` lúc bridge log
  `Message sent`/`Sent media` (thêm log thời gian ở G11), `t2` lúc khách thấy (UI).
- Báo cáo p50/p95/max từ ≥ 20 mẫu cho mỗi loại, tách có AI và không AI.

**Mục tiêu (ngưỡng đạt):**

| Chặng | Mục tiêu hiện tại (polling) | Mục tiêu sau G1 (webhook RC) |
|---|---|---|
| Facebook → RC, text, AI tắt | p95 ≤ 2 s | giữ nguyên |
| Facebook → RC, text, AI bật | p95 ≤ 8 s (phụ thuộc model) | giữ nguyên |
| Telegram → RC, text | p95 ≤ 4 s (poll 2 s) | giữ nguyên |
| Media ≤ 5 MB → RC | p95 ≤ 8 s | giữ nguyên |
| Agent → khách, text | p95 ≤ 15 s (poll 10 s) | p95 ≤ 3 s |
| Agent → khách, media ≤ 5 MB | p95 ≤ 20 s | p95 ≤ 8 s |
| Webhook Facebook trả `200` | ≤ 1 s (sau G2), tuyệt đối < 5 s | giữ nguyên |
| Thất lạc/trùng tin trong 200 tin | 0 / 0 | giữ nguyên |

### 4.3 Ràng buộc an toàn khi kiểm thử

- Chỉ dùng tài khoản và Page của bạn; không nhắn người khác. Không spam Meta/Telegram
  quá ngưỡng (Facebook: tối đa vài chục tin/phút ra thật; phần tải lớn dùng mock).
- Dữ liệu và bí mật: không in token/secret vào báo cáo; ảnh chụp màn hình che thông tin.
- **Không chạy lệnh git** (không commit/push); file mới chỉ nằm trong thư mục làm việc.
- Sao lưu `mapping.json` và `data/` trước khi chạy; dọn mọi visitor/phòng giả (prefix
  `test_`) sau khi xong.
- Cấu hình AI: chạy hai lượt, `AI_ENABLED=false` (đo thuần cầu nối) và `true` (đo AI + handoff).
  Tin mô phỏng gửi tới PSID giả sẽ làm bridge cố trả lời qua Graph và nhận lỗi; vì vậy lượt
  mô phỏng chạy với `AI_ENABLED=false` hoặc trỏ `FB_GRAPH_BASE_URL` vào mock (G14).

---

## 5. Ma trận kiểm thử

Ký hiệu: **U** = giao diện thật, **S** = script/API, **M** = mock/lỗi giả lập, **L** = tải.

### A. Facebook → Rocket.Chat (nhận)

| ID | Kịch bản | Cách | Kỳ vọng |
|---|---|---|---|
| T-F01 | Text ngắn, tiếng Việt có dấu, xuống dòng | U+S | Nguyên vẹn Unicode, xuống dòng |
| T-F02 | Emoji (😀 ❤️ 🇻🇳 👨‍👩‍👧), nút Like 👍 | U | Hiển thị đúng trong RC |
| T-F03 | Text 2000 ký tự, URL dài, ký tự đặc biệt `<>&"` | U+S | Không cắt, không vỡ |
| T-F04 | Ảnh JPG/PNG (1 ảnh), nhiều ảnh trong một tin | U | Upload đủ, không trùng |
| T-F05 | GIF | U | Hiển thị/animate trong RC |
| T-F06 | Video mp4 ≤ 10 MB | U | Phát được trong RC |
| T-F07 | Voice clip (audio), file mp3 | U | Nghe được |
| T-F08 | PDF, DOCX, ZIP | U | Tải về đúng file/tên |
| T-F09 | Sticker, Like lớn | U | **Hiển thị như ảnh** (sau G3) |
| T-F10 | Vị trí | U | Link bản đồ |
| T-F11 | File > 25 MB / URL CDN hết hạn / host lạ | S | Từ chối có thông báo cho khách; không crash |
| T-F12 | Reply (trích dẫn), reaction, "đã đọc", "đã nhận" | U | Không tạo tin rác; `non-message event` bị bỏ |
| T-F13 | Chữ ký sai/thiếu/ký lại (replay) | S | `401`, không xử lý |
| T-F14 | Payload hỏng, `object` khác `page`, `entry` rỗng | S | `200`/`400` an toàn, không crash |
| T-F15 | Tên file đặc biệt/Unicode/rất dài | U | Giữ tên hợp lệ |

### B. Rocket.Chat → Facebook (gửi)

| ID | Kịch bản | Cách | Kỳ vọng |
|---|---|---|---|
| T-F16 | Agent gửi text thường + xuống dòng + emoji | U | Khách nhận nguyên văn |
| T-F17 | Markdown (`*đậm*`, `_nghiêng_`, `` `code` ``, link) | U | Chuyển thành text sạch (sau G4) |
| T-F18 | Text > 2000 ký tự | S | Tách thành nhiều tin theo thứ tự (sau G4) |
| T-F19 | `<t:…>` dấu thời gian | S | Thành chuỗi ngày giờ đọc được |
| T-F20 | Ảnh / GIF / video / mp3 / voice ogg / PDF / ZIP | U | Khách nhận đúng loại, phát/mở được |
| T-F21 | Nhiều file một tin + caption | U | Mỗi file một tin, caption một lần |
| T-F22 | File > 25 MB | S | Báo lỗi có kiểm soát, agent thấy tin hệ thống (sau G7) |
| T-F23 | Khách nhắn lần cuối > 24 giờ trước | M | Lỗi Graph được phân loại, ghi vào phòng (G7) |
| T-F24 | Token bị thu hồi (190) | M | Báo to ở log và `/health`, không retry vô hạn |
| T-F25 | Graph 5xx, 429, timeout | M | Retry có backoff, không gửi trùng khi thành công lần 2 |

### C. Telegram → Rocket.Chat (nhận)

| ID | Kịch bản | Cách | Kỳ vọng |
|---|---|---|---|
| T-T01 | Text, tiếng Việt, emoji, xuống dòng, 4096 ký tự | U | Nguyên vẹn |
| T-T02 | Lệnh `/start`, `/help` | U | AI/hướng dẫn trả lời đúng |
| T-T03 | Ảnh (1 ảnh, album nhiều ảnh) | U | Upload đủ, không trùng |
| T-T04 | Video, video note, GIF/animation | U | Phát được |
| T-T05 | Voice, audio mp3 | U | Nghe được |
| T-T06 | Sticker tĩnh / động / video | U | Tĩnh hiển thị; động có thông báo |
| T-T07 | Document PDF/DOCX/TXT (đồng thời index cho AI) | U | Upload RC + "Indexed N chunk" |
| T-T08 | Contact, location, venue | U | Tin hệ thống rõ ràng |
| T-T09 | Caption cho ảnh/file; forward; reply | U | Caption vào RC |
| T-T10 | File > 20 MB (media) / > 100 MB (document) | U | Thông báo vượt giới hạn |
| T-T11 | Sửa tin đã gửi | U | Theo chính sách G8 |
| T-T12 | Chat ngoài allowlist (`TELEGRAM_ALLOWED_CHAT_IDS`) | S | Bị bỏ qua |
| T-T13 | Update trùng `update_id` | S | Xử lý đúng một lần |

### D. Rocket.Chat → Telegram (gửi)

| ID | Kịch bản | Cách | Kỳ vọng |
|---|---|---|---|
| T-T14 | Mọi cú pháp Markdown: đậm, nghiêng, gạch, code, khối code, link | U | Render đúng HTML Telegram |
| T-T15 | Markdown sai/lồng nhau, ký tự `<>&` | S | Hạ cấp về text, không mất tin |
| T-T16 | Tin > 4096, fence code bị cắt giữa | S | Tách đúng, fence đóng/mở lại |
| T-T17 | Ảnh, GIF, video, mp3, voice ogg, PDF, ZIP | U | Đúng loại, phát được |
| T-T18 | Caption > 1024 | S | Phần dư thành tin text |
| T-T19 | Chat đã chặn bot (403), chat không tồn tại (400) | M | Phân loại lỗi, không retry vô hạn, báo agent (G7) |
| T-T20 | Telegram 429 `retry_after`, 5xx | M | Đợi đúng thời gian, không trùng |

### E. Rocket.Chat và ghép nối giữa các nền tảng

| ID | Kịch bản | Cách | Kỳ vọng |
|---|---|---|---|
| T-E01 | Hai khách (FB + TG) nhắn cùng lúc | U+S | Hai phòng riêng, không lẫn tin |
| T-E02 | Một khách nhắn 20 tin liên tiếp | S | **Đúng thứ tự**, không mất, không trùng |
| T-E03 | Cùng khách đổi nền tảng | U | Hai visitor độc lập (hành vi hiện tại, ghi nhận) |
| T-E04 | Nhiều phòng hoạt động, agent trả lời cả hai | U | **Cả hai** nhận được (kiểm chứng G1) |
| T-E05 | Agent gửi tin sửa/xóa | U | Không gửi lặp; chính sách ghi rõ |
| T-E06 | Tin nội bộ/hệ thống (`m.t`, "connected", chuyển phòng) | U | Không lọt sang khách |
| T-E07 | Agent **đóng phòng**, khách nhắn tiếp | U | Phòng mới tạo, tin không mất (G6) |
| T-E08 | Chuyển phòng ban/agent | U | Tin tiếp tục tới đúng khách |
| T-E09 | Rocket.Chat dừng (`docker stop`), rồi bật lại | M | Khách nhận thông báo lỗi lịch sự; sau khi RC lên, tin cũ được xử lý đúng |
| T-E10 | Phiên agent hết hạn (401) | M | Tự đăng nhập lại 1 lần, tiếp tục |
| T-E11 | Rocket.Chat 429 | M | Tạm dừng đúng thời gian, vòng tròn công bằng |
| T-E12 | Thêm department; không có agent online | U | Hàng đợi/offline xử lý hợp lý |

### F. AI và tài liệu

| ID | Kịch bản | Cách | Kỳ vọng |
|---|---|---|---|
| T-A01 | `AI_ENABLED=false` | U | Mọi tin tới agent, không có tin AI |
| T-A02 | AI bật, câu hỏi trả lời được | U | AI trả lời, cũng ghi vào RC |
| T-A03 | AI không trả lời → handoff | U | Thông báo handoff **một lần**; sau đó AI im (G5) |
| T-A04 | Agent đang chat, khách hỏi tiếp | U | AI **không** chen vào (G5) |
| T-A05 | AI lỗi/timeout (mock) | M | Rơi về agent, khách không thấy lỗi thô |
| T-A06 | Upload tài liệu rồi hỏi nội dung | U | Trả lời đúng, không bịa |
| T-A07 | `/documents/upload` không/ sai `Authorization` | S | `503`/`401` |
| T-A08 | Truy vấn live (thời tiết, chức vụ) | U | Đúng nguồn; lỗi mạng → fallback |

### G. Bảo mật

| ID | Kịch bản | Kỳ vọng |
|---|---|---|
| T-S01 | Facebook chữ ký sai/thiếu/body bị sửa | `401` (đã Live) |
| T-S02 | Telegram secret sai/thiếu | `401` |
| T-S03 | URL attachment trỏ `169.254.169.254`, `localhost`, host lạ | Bị từ chối |
| T-S04 | Body lớn trên webhook (sau G12) | `413` |
| T-S05 | Quét log và báo cáo tìm token/PSID/nội dung tin | Không có bí mật; chỉ độ dài |
| T-S06 | Một khách spam 100 tin/phút (sau G13) | Bị giới hạn, AI không bị gọi quá |
| T-S07 | `.env`/`mapping.json`/`data/` không bị theo dõi bởi git | `git check-ignore` đúng (chỉ đọc) |

### H. Độ tin cậy và khôi phục

| ID | Kịch bản | Cách | Kỳ vọng |
|---|---|---|---|
| T-H01 | Webhook Facebook chậm > 20 s (AI mock chậm) | M | `200` trả ngay (G2), không có tin trùng |
| T-H02 | Meta gửi lại cùng `mid` | S | Chỉ xử lý một lần |
| T-H03 | Restart bridge giữa chừng (khi đang gửi media) | S+U | Không mất, không trùng (mapping + id đã xử lý) |
| T-H04 | Tắt ngrok 2 phút rồi bật lại | U | Meta retry; tin tới sau khi tunnel sống; bridge không crash |
| T-H05 | Mất mạng Internet (Graph/Telegram không tới) | M | Retry rồi tiếp tục, không mất update Telegram |
| T-H06 | `mapping.json` hỏng/ghi lỗi | S | Khởi động không mất hết; cảnh báo rõ |
| T-H07 | Upload thành công nhưng gửi caption lỗi | M | Không gửi lại file (đã có), ghi log |
| T-H08 | Hai instance bridge chạy cùng lúc (cảnh báo cấu hình) | S | Tài liệu nêu rõ chưa hỗ trợ |
| T-H09 | Graceful shutdown khi đang xử lý | S | Hoàn tất hoặc trả hàng đợi, không mất tin |

### I. Hiệu năng

| ID | Kịch bản | Đo | Đạt khi |
|---|---|---|---|
| T-P01 | 100 tin text tuần tự từ 1 PSID giả (AI tắt, mock Graph) | p50/p95 inbound | p95 ≤ 2 s, 0 mất/trùng |
| T-P02 | 20 PSID giả × 5 tin đồng thời | thông lượng, lỗi | 0 mất, đúng thứ tự mỗi PSID |
| T-P03 | 20 phòng hoạt động, agent trả lời tất cả | độ trễ outbound, số 429 | Mọi phòng nhận ≤ 15 s (polling) hoặc ≤ 3 s (webhook) |
| T-P04 | Số request tới Rocket.Chat mỗi phút khi rảnh | request/phút | Polling: ≤ ngưỡng rate limit; webhook: ≈ 0 |
| T-P05 | Media 1/5/10/20 MB hai chiều | thời gian, RAM | Tuyến tính, RAM không phình quá 3 × kích thước |
| T-P06 | Chạy 30 phút liên tục | RSS, handle, CPU | Không rò rỉ (ổn định ± 10 %) |
| T-P07 | AI bật: độ trễ cuối-cuối | p95 | ≤ 8 s với model hiện tại |

---

## 6. Kế hoạch khắc phục (gói công việc)

Thứ tự theo giá trị và phụ thuộc. Mỗi gói kèm test mới; không đổi API công khai hiện có.

| Gói | Nội dung | Giải quyết | Công sức | Phụ thuộc |
|---|---|---|---|---|
| W0 | Mock server Graph/Telegram (`FB_GRAPH_BASE_URL`, `TELEGRAM_API_BASE_URL`) + khung `scripts/e2e/` (ký webhook, đo độ trễ, dọn dữ liệu) | G14 | 0,5 ngày | — |
| W1 | Poll vòng tròn công bằng + ghi nhận 429 theo endpoint + hướng dẫn tăng rate limit | G1 (ngắn hạn) | 0,5 ngày | — |
| W2 | Facebook: trả `200` ngay, hàng đợi theo người dùng, loại trùng `mid`, lưu bền | G2 | 1 ngày | W0 |
| W3 | Sticker Facebook, tách tin ≤ 2000, bỏ ký hiệu markdown | G3, G4 | 0,5 ngày | — |
| W4 | Trạng thái handoff cho AI, thông báo handoff một lần | G5 | 0,5 ngày | — |
| W5 | Phát hiện phòng đóng và tạo phòng mới | G6 | 0,5–1 ngày | cần Live |
| W6 | Phân loại lỗi gửi ra, tin hệ thống vào phòng khi bỏ cuộc, trạng thái token | G7, G15 | 1 ngày | W0 |
| W7 | Tên khách, log độ trễ, mở rộng `/health`, bỏ log nội dung AI | G9–G11 | 0,5 ngày | — |
| W8 | Giới hạn body webhook, rate limit theo khách, tắt route TG khi polling | G12, G13, G18 | 0,5 ngày | — |
| W9 | Omnichat webhook của Rocket.Chat thay polling (giữ polling dự phòng) | G1 (dài hạn) | 1–2 ngày | W1 |
| W10 | Chính sách `edited_message` và các mục P3 được chọn | G8, P3 | tùy chọn | — |

Mỗi gói: viết test trước/cùng lúc, chạy `npm test`, cập nhật `README.md`, `guide.md`,
`.env.example`; không động tới `.env`.

---

## 7. Trình tự thực thi sau khi duyệt

1. **Chuẩn bị**: sao lưu `mapping.json` và `data/`; ghi lại phiên bản Rocket.Chat; xác nhận
   `npm test` xanh; `npm run fb:check` xanh; lưu cấu hình hiện tại của `.env` (không in bí mật).
2. **Đo nền (baseline)**: chạy L1 trên **mã hiện tại**, không sửa gì, để có số liệu "trước":
   latency, 429, hành vi sticker, handoff, phòng đóng. Kết quả vào `TEST_REPORT.md` mục "Trước".
3. **L2 giao diện** theo ma trận mục 5 (A–F): thao tác trên Messenger, Telegram Web,
   Rocket.Chat; chụp màn hình, ghi thời gian, đối chiếu log.
4. **L3 lỗi** (H, E09–E11): mock + dừng Docker + tắt ngrok.
5. **L4 tải** (I).
6. **Khắc phục** theo mục 6 (W0 → W9), mỗi gói xong chạy lại test liên quan.
7. **Chạy lại toàn bộ** ma trận, ghi "Sau", so sánh với "Trước".
8. **Dọn dẹp** dữ liệu giả, cập nhật hướng dẫn, đánh dấu `CODEBASE_AUDIT_REPORT.md` lỗi thời.

Sản phẩm giao:

- `TEST_REPORT.md`: bảng kết quả theo ID, số liệu độ trễ trước/sau, ảnh chụp, danh sách lỗi còn lại.
- `scripts/e2e/*.js` và lệnh `npm run e2e:*` để chạy lại sau này.
- Cập nhật `guide.md` (mục kiểm thử, mục rate limit Rocket.Chat, mục webhook Rocket.Chat).

### Tiêu chí hoàn thành

- 0 lỗi P0/P1 còn mở (hoặc có quyết định chấp nhận rõ ràng của bạn).
- Mọi dòng trong ma trận ở trạng thái Đạt / Không áp dụng / Chấp nhận rủi ro, có bằng chứng.
- Đạt các ngưỡng độ trễ ở mục 4.2 (theo mức hiện tại hoặc sau W9).
- Không còn bí mật hoặc nội dung tin trong log; `npm test` xanh; `fb:check` xanh.

---

## 8. Rủi ro của chính việc kiểm thử

| Rủi ro | Giảm thiểu |
|---|---|
| Làm bẩn phòng thật (hai phòng bạn đưa) bằng tin kiểm thử | Dùng `test_` visitor cho script; trên phòng thật chỉ làm bài U, đánh dấu tin bằng `[TEST]` |
| Meta giới hạn/khóa Page vì gửi nhiều | Tải lớn chỉ dùng mock; thật ≤ vài chục tin |
| Chi phí AI | Chạy phần lớn với `AI_ENABLED=false`; dùng bộ test AI nhỏ, model hiện tại |
| Token/secret lộ trong ảnh chụp, log | Che trước khi lưu; không dán vào báo cáo |
| Docker stop làm mất dữ liệu | Chỉ dừng container `rocketchat`, không động tới MongoDB |
| Sửa code làm hỏng phần đang chạy tốt | Mỗi gói có test, chạy lại ma trận liên quan; bạn commit khi hài lòng |

---

## 9. Cần bạn quyết định trước khi chạy

1. **Cho phép thao tác thật** trên Messenger/Telegram Web/Rocket.Chat đã đăng nhập: gửi
   nhiều tin và file test (đánh dấu `[TEST]`), đóng/mở phòng, chuyển phòng ban, đổi
   trạng thái agent? (Mặc định: có, trừ khi bạn nói khác.)
2. **AI**: chạy hai lượt bật/tắt như mục 4.3 (cần tôi sửa `AI_ENABLED` trong `.env` tạm thời
   rồi trả lại)? Hoặc giữ nguyên và chỉ kiểm thử với AI bật?
3. **Rocket.Chat admin**: cho phép tôi chỉnh **Rate Limiter** và thêm **Omnichannel
   webhook** (G1) trên giao diện admin? Đây là thay đổi cấu hình của Rocket.Chat.
4. **Chính sách** (G8): tin Telegram bị sửa thì (a) bỏ qua, (b) gửi lại kèm "đã sửa"?
5. **Thứ tự**: làm hết mục 7 theo trình tự, hay ưu tiên sửa P0 (G1, G2) trước rồi mới kiểm
   thử toàn diện?
6. **Phạm vi P3**: có làm typing/mark seen (Facebook), nút bấm (Telegram) không, hay để sau?


## Trạng thái W7 + W8 (G9–G13, G18)

Đã làm, có test tự động trong `test/ops-hardening.test.js` (chưa kiểm chứng trên giao diện thật):

- G9: `customerNames.js` + `facebookProfile.js`; tên lưu vào `mapping.json` (`displayName`).
- G10: không còn log nội dung tin khách; test quét mã nguồn để giữ nguyên tắc.
- G11: `metrics.js`, log `[timing]`, `/health` mở rộng. Chưa có kiểm tra sức khỏe token Facebook (thuộc G15), chỉ báo token đã cấu hình hay chưa.
- G12: `WEBHOOK_BODY_LIMIT=1mb` cho mọi route, `REQUEST_BODY_LIMIT` chỉ cho `/documents/upload`; `req.rawBody` vẫn được giữ.
- G13: `rateLimiter.js`, `RATE_LIMIT_PER_MINUTE=20`. Áp ở đầu `forwardToRocketChat` (tin văn bản); media không bị đếm.
- G18: `webhookGuards.js`; route Telegram webhook trả 404 khi `TELEGRAM_POLLING=true`.
