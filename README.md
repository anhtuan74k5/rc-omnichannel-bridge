# Rocket.Chat Messenger + Telegram Bridge

Bridge server (Node.js + Express) tích hợp **Facebook Messenger** và **Telegram**
vào **Rocket.Chat Omnichannel** — giao tiếp trực tiếp qua REST API namespace
`/api/v1/livechat/*`, **không dùng** Marketplace app có sẵn của Rocket.Chat.

> ⚠️ Chỉ gọi các route `/api/v1/livechat/*`. Mọi route khác (như `/users.create`,
> `/channels.list`) bị proxy chặn (404) nên code **không bao giờ** gọi chúng.

## Kiến trúc

```
Facebook Messenger ──► POST /webhook/facebook ──┐
                                                ├──► Rocket.Chat /api/v1/livechat/*
Telegram Bot ────────► POST /webhook/telegram ──┘        (visitor, room, message)

Rocket.Chat agent reply ──► polling (3s) ──► Facebook Graph API / Telegram Bot API
```

- **Inbound** (người dùng → Rocket.Chat): webhook nhận tin nhắn, tạo visitor +
  room, gửi tin vào room.
- **Outbound** (agent → người dùng): vòng lặp polling mỗi 3 giây kiểm tra tin
  mới từ agent trong từng room, gửi ra đúng nền tảng tương ứng.

## Cấu trúc project

```
.
├── package.json      # dependencies & scripts
├── .env.example      # mẫu biến môi trường (copy thành .env)
├── index.js          # Express server + polling loop + routes
├── rocketchat.js     # tích hợp Rocket.Chat livechat API
├── facebook.js       # webhook + gửi tin Facebook Messenger
├── telegram.js       # webhook + gửi tin Telegram
├── mapping.js        # lưu mapping (visitor token, room, platform) vào mapping.json
└── mapping.json      # (tự tạo) dữ liệu mapping persist qua restart
```

## Cài đặt & chạy

```bash
# 1. Cài dependencies
npm install

# 2. Tạo file .env từ mẫu và điền đầy đủ biến
cp .env.example .env

# 3. Chạy server
npm start
```

Server sẽ chạy tại `http://localhost:3000`.

## Checklist biến môi trường (.env)

| Biến | Bắt buộc | Mô tả |
|------|----------|-------|
| `ROCKETCHAT_URL` | ✅ | URL Rocket.Chat, ví dụ `https://dev.weteams.net` |
| `ROCKETCHAT_AGENT_USERNAME` | ✅ | Tài khoản agent (không phải admin) |
| `ROCKETCHAT_AGENT_PASSWORD` | ✅ | Mật khẩu agent |
| `ROCKETCHAT_DEPARTMENT_ID` | ⬜ | ID phòng ban gán cho visitor (nếu có) |
| `FB_PAGE_ACCESS_TOKEN` | ⬜* | Page Access Token (bắt buộc nếu dùng Facebook) |
| `FB_PAGE_ID` | ⬜* | Page ID (bắt buộc nếu dùng Facebook) |
| `FB_VERIFY_TOKEN` | ⬜* | Verify token khớp với cấu hình webhook Facebook |
| `TELEGRAM_BOT_TOKEN` | ⬜* | Bot token từ BotFather (bắt buộc nếu dùng Telegram) |
| `PORT` | ⬜ | Cổng server (mặc định `3000`) |

\* Chỉ bắt buộc nếu bạn dùng nền tảng tương ứng. Có thể chạy chỉ 1 nền tảng.

## Expose ra internet bằng ngrok (để test với Facebook/Telegram thật)

Facebook và Telegram yêu cầu webhook phải là HTTPS public. Dùng ngrok:

```bash
# Chạy server trước (npm start), sau đó mở 1 terminal khác:
ngrok http 3000
```

Ngrok sẽ in ra URL public dạng `https://xxxx.ngrok-free.app`. Dùng URL này để
cấu hình webhook:

> 💡 **Restart index.js có cần restart ngrok không?** — **Không.** Ngrok chỉ là
> tunnel forward request tới cổng `3000`. Khi bạn restart `index.js`, chỉ server
> Express bên trong bật/tắt lại; ngrok vẫn giữ nguyên URL public và tự hoạt động
> lại khi server lắng nghe lại đúng cổng. Chỉ cần restart ngrok khi: đổi cổng
> server (chạy `ngrok http <cổng mới>`), session ngrok hết hạn (URL đổi), hoặc
> muốn URL public mới.


### Facebook Messenger
1. Vào **Meta for Developers** → App → **Messenger** → **Webhooks**.
2. Callback URL: `https://xxxx.ngrok-free.app/webhook/facebook`
3. Verify token: nhập đúng giá trị `FB_VERIFY_TOKEN` trong `.env`.
4. Subscribe vào event **messages**.
5. Vào **Messenger → Settings → Access Tokens** để lấy `FB_PAGE_ACCESS_TOKEN`
   và `FB_PAGE_ID`, điền vào `.env`.

### Telegram

**Lấy Bot Token qua BotFather (từng bước):**
1. Mở Telegram, tìm và mở chat với **@BotFather** (tài khoản chính thức của Telegram).
2. Gõ lệnh `/newbot` và gửi.
3. BotFather hỏi **tên hiển thị** của bot — nhập tên bất kỳ, ví dụ `My Support Bot`.
4. BotFather hỏi **username** của bot — phải kết thúc bằng `bot`, ví dụ `mysupport_bot`.
5. Nếu username hợp lệ, BotFather trả về **HTTP API token** dạng:
   ```
   1234567890:AAHf...token...xyz
   ```
   Đây chính là `TELEGRAM_BOT_TOKEN` — copy vào `.env`.
6. (Tùy chọn) Gõ `/setdescription` để đặt mô tả, `/setabouttext` để đặt giới thiệu.

> 💡 Token là bí mật — không chia sẻ. Nếu lỡ lộ, gõ `/revoke` trong BotFather để cấp token mới.

**Đăng ký webhook cho bot** (thay `<TOKEN>` và URL thật):
```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://xxxx.ngrok-free.app/webhook/telegram"}'
```

> ⚠️ **Lỗi thường gặp:** Telegram KHÔNG tự động gửi tin nhắn tới server như
> Facebook (Facebook cấu hình webhook trong dashboard). Với Telegram bạn **bắt
> buộc** phải gọi `setWebhook` để trỏ bot tới URL ngrok. Nếu quên bước này, bot
> sẽ không nhận được tin nhắn nào dù token đúng. Kiểm tra webhook đã đăng ký
> chưa bằng lệnh:
> ```bash
> curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
> ```
> Nếu `"url":""` nghĩa là chưa đăng ký — hãy chạy lệnh `setWebhook` ở trên.



## Luồng hoạt động & log

Server log rõ từng bước để dễ debug khi demo:

- `[facebook] Received message from PSID ...` — nhận webhook Facebook
- `[telegram] Received message from chat ...` — nhận webhook Telegram
- `[rocketchat] Creating visitor ...` — tạo visitor
- `[rocketchat] Room resolved: ...` — lấy room
- `[rocketchat] Sending visitor message ...` — gửi tin vào room
- `[poll] New agent message in room ... -> facebook:...` — polling phát hiện tin agent
- `[facebook] Sending message to PSID ...` / `[telegram] Sending message to chat ...` — gửi ra ngoài

## Bot AI tự động (optional)

Khi bật AI, tin nhắn của khách sẽ được AI xử lý trước khi chuyển cho agent:

- **AI trả lời được** (câu hỏi đơn giản: giờ mở cửa, giá, FAQ, chào hỏi...) →
  AI tự trả lời ngay trên Facebook/Telegram, **không tạo room** trên Omnichannel.
- **AI không xử lý được** (khiếu nại, hoàn tiền, kỹ thuật phức tạp, khách yêu cầu
  gặp người...) → chuyển sang agent người thật (tạo visitor + room như bình thường).

**Cấu hình trong `.env`:**
```
AI_ENABLED=true
AI_API_KEY=sk-...            # key của OpenAI (hoặc API tương thích)
AI_BASE_URL=https://api.openai.com/v1   # mặc định OpenAI, có thể đổi
AI_MODEL=gpt-4o-mini
```

> 💡 Module `ai.js` dùng **OpenAI-compatible Chat Completions API**, nên có thể
> trỏ tới bất kỳ endpoint tương thích nào (OpenAI, Azure, Groq, LLM local...).
> Nếu `AI_ENABLED=false` hoặc thiếu `AI_API_KEY`, hệ thống hoạt động như cũ
> (chuyển thẳng cho agent).

**Ví dụ dùng DeepSeek** (rẻ, tương thích OpenAI):
```
AI_ENABLED=true
AI_API_KEY=sk-...                    # key từ platform.deepseek.com
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-chat               # hoặc deepseek-reasoner (R1)
```


**Luồng hoạt động khi bật AI:**
```
khách gửi tin → webhook → forwardToRocketChat()
   ├─ AI_ENABLED? ── không → tạo room cho agent (như cũ)
   └─ có → gọi AI
        ├─ AI trả lời được → gửi câu trả lời thẳng về FB/TG (không tạo room)
        └─ AI không trả lời được → tạo room cho agent
```

## Xử lý lỗi


- **401 (token hết hạn)**: tự động re-login agent và retry 1 lần.
- **Lỗi gọi Rocket.Chat**: log rõ status + body để debug.
- **Lỗi gửi Facebook/Telegram**: log lỗi, không làm crash server.

## Ghi chú

- Mapping (visitor token, room ID, platform, platform user ID) được lưu trong
  `mapping.json` nên không mất dữ liệu khi restart server.
- Visitor token được sinh **deterministic** từ platform user id
  (`visitor_<PSID>` / `visitor_<chat_id>`) nên mỗi người dùng luôn map về cùng
  một visitor/room.
- Chỉ xử lý **tin nhắn text** ở bản demo này.
