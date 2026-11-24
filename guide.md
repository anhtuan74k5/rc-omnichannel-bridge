# Hướng dẫn lấy key/token và chạy Facebook Messenger + ngrok

File này **không chứa bí mật**. Mọi giá trị bí mật nằm trong `.env`, file này đã
được `.gitignore` bỏ qua, tuyệt đối không commit hay gửi cho người khác.

## 0. Tổng quan: cần những gì

| Biến trong `.env` | Là gì | Lấy ở đâu | Hết hạn? |
|---|---|---|---|
| `FB_PAGE_ACCESS_TOKEN` | Token để bridge gửi tin thay mặt Page | Mục 2 | Token tạo ở Messenger API settings là loại `PAGE`, **không hết hạn** |
| `FB_PAGE_ID` | ID của Page OmniChannel | Mục 1 | Không |
| `FB_APP_SECRET` | Khóa bí mật của app, dùng kiểm tra chữ ký webhook | Mục 3 | Không (trừ khi bấm "Đặt lại") |
| `FB_VERIFY_TOKEN` | Chuỗi bạn tự đặt để Meta xác minh webhook | Mục 4 | Không |
| URL webhook | `https://<domain-ngrok>/webhook/facebook` | Mục 5 và 6 | Cố định nếu dùng static domain |

Thông tin hiện tại của bạn (không bí mật):

- App: **Omnichat**, App ID `1548946176881451`, đang ở chế độ **Development**.
- Page: **OmniChannel**, Page ID `1143291825541627`.
- Domain ngrok cố định (miễn phí): `haphazard-spinal-gradation.ngrok-free.dev`.
- Webhook URL: `https://haphazard-spinal-gradation.ngrok-free.dev/webhook/facebook`.
- Cổng bridge: `PORT=3001`.

> Vì sao trước đây Facebook ngừng chạy? Token cũ **đã hết hạn** (lỗi Graph
> `code 190`), không phải do ngrok. Nguyên nhân là token dạng ngắn hạn. Dùng
> đúng cách ở mục 2 thì không bị nữa.

## 1. Lấy Page ID

1. Mở <https://developers.facebook.com/apps/1548946176881451/use_cases/customize/messenger_api_settings/>
   (Meta for Developers > app **Omnichat** > Trường hợp sử dụng > Tùy chỉnh >
   **Cài đặt API Messenger**).
2. Mở mục **2. Tạo mã truy cập**. Dưới tên Page **OmniChannel** có dãy số: đó là
   Page ID.
3. Điền vào `.env`: `FB_PAGE_ID=<dãy số>`.

## 2. Lấy Page Access Token

1. Cùng trang ở mục 1, mục **2. Tạo mã truy cập**, bấm **Tạo** cạnh Page
   OmniChannel.
2. Tick **Tôi hiểu**. Meta **chỉ hiển thị token một lần**.
3. Bấm **Sao chép**, dán vào `.env`: `FB_PAGE_ACCESS_TOKEN=EAA...` (một dòng, không
   dấu cách, không ngoặc kép). Nếu lỡ đóng hộp thoại, bấm **Tạo** lại để lấy token
   mới; token cũ vẫn còn hiệu lực cho tới khi bạn thu hồi.
4. Kiểm tra bằng lệnh:

   ```powershell
   npm run fb:check
   ```

   Kết quả mong đợi: toàn bộ dòng `OK`, trong đó có `Token không hết hạn` và `Có
   quyền pages_messaging`.

Nếu thấy `Session has expired` / `code 190`: token hết hạn hoặc bị thu hồi, làm
lại mục này.

## 3. Lấy App Secret

1. Mở <https://developers.facebook.com/apps/1548946176881451/settings/basic/>.
2. Ở ô **Khóa bí mật của ứng dụng** bấm **Hiển thị**, Meta hỏi lại **mật khẩu
   Facebook** của bạn (phải tự nhập).
3. Sao chép giá trị (32 ký tự hex), dán vào `.env`: `FB_APP_SECRET=<giá trị>`.
4. **Không bấm "Đặt lại"** trừ khi bị lộ secret; đặt lại sẽ làm webhook bị `401`
   cho tới khi bạn cập nhật `.env`.

Bridge dùng secret này để kiểm tra header `X-Hub-Signature-256` của mọi request
tới `/webhook/facebook`. Thiếu secret thì bridge vẫn chạy nhưng ghi cảnh báo
`FB_APP_SECRET is not set` và không xác thực webhook.

## 4. Đặt Verify Token

Đây là chuỗi **bạn tự chọn**, không lấy từ Meta. Tạo một chuỗi ngẫu nhiên:

```powershell
$b = New-Object byte[] 16; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
```

Lệnh trên in ra 32 ký tự hex ngẫu nhiên (đừng dùng `Get-Random -Count`, nó lấy mẫu
không lặp nên token ngắn và yếu).

Dán vào `.env`: `FB_VERIFY_TOKEN=<chuỗi>`, và nhập **đúng chuỗi đó** vào ô **Xác
minh mã** ở mục 6. Hai nơi lệch nhau thì Meta báo xác minh thất bại.

## 5. ngrok: cài đặt, authtoken và domain cố định

### 5.1 Cài ngrok (một lần)

```powershell
winget install ngrok.ngrok
```

Mở lại terminal, kiểm tra `ngrok version`.

### 5.2 Lấy authtoken (một lần)

1. Đăng nhập <https://dashboard.ngrok.com>.
2. Mở <https://dashboard.ngrok.com/get-started/your-authtoken>, bấm sao chép.
3. Lưu vào cấu hình ngrok trên máy (không cần đưa vào `.env`):

   ```powershell
   ngrok config add-authtoken <authtoken>
   ```

### 5.3 Domain cố định (một lần)

1. Mở <https://dashboard.ngrok.com/domains>. Mọi tài khoản đều có **1 dev
   domain miễn phí**, dạng `xxx-xxx-xxx.ngrok-free.dev`. Đây là domain của bạn:
   `haphazard-spinal-gradation.ngrok-free.dev`.
2. Domain này **không đổi** giữa các lần chạy, nên **không phải sửa callback URL
   trên Meta nữa**.

### 5.4 Chạy tunnel (mỗi lần dev)

```powershell
ngrok http --url=haphazard-spinal-gradation.ngrok-free.dev 3001
```

Giữ cửa sổ này mở. Nếu đổi `PORT` trong `.env` thì đổi `3001` cho khớp.

## 6. Khai báo webhook trên Meta (một lần, hoặc khi đổi domain/verify token)

Bridge và ngrok **phải đang chạy** trước khi bấm lưu, vì Meta sẽ gọi thử vào URL.

1. Mở trang Cài đặt API Messenger (mục 1), mở **1. Đặt cấu hình webhook**.
2. **URL gọi lại**: `https://haphazard-spinal-gradation.ngrok-free.dev/webhook/facebook`
3. **Xác minh mã**: đúng `FB_VERIFY_TOKEN` trong `.env`.
4. Bấm **Xác minh và lưu**.
5. Ở mục **2. Tạo mã truy cập**, bảo đảm Page OmniChannel đã đăng ký field
   **`messages`** (hiện có `messages`, `message_deliveries`, `message_reads`,
   `messaging_optins`...).

## 7. Cho tài khoản nhắn thử

App đang ở chế độ **Development**: chỉ tài khoản có vai trò trong app (Quản trị
viên, Nhà phát triển, Người thử nghiệm) mới nhắn cho Page được và nhận được phản
hồi.

- Tài khoản Facebook của chính bạn (người tạo app) dùng được ngay.
- Thêm người khác: Meta for Developers > **Vai trò trong ứng dụng** > **Vai
  trò** hoặc **Người dùng thử nghiệm** > thêm bằng tên/ID Facebook, người đó phải
  chấp nhận lời mời.
- Muốn **người lạ** nhắn được: phải qua **App Review** để xin quyền
  `pages_messaging` và chuyển app sang **Live**. Đây là bước riêng, không liên
  quan code.

## 8. Quy trình mỗi lần dev (checklist)

1. Bật Rocket.Chat (Docker), mở `http://localhost:3000`.

   ```powershell
   cd D:\Github\rocketchat-compose-2.0.0
   docker compose -f compose.database.yml -f compose.yml up -d
   ```

2. Chạy bridge (chỉ **một** bản). Cách khuyên dùng: script tự dừng bản cũ rồi chạy một bản
   mới ở nền, log nằm ở `%TEMP%\bridge.log` và `%TEMP%\bridge.err`:

   ```powershell
   cd D:\Github\rc-omnichannel-bridge
   powershell -File scripts\restart-bridge.ps1
   ```

   Sau mỗi lần sửa code hoặc `.env`, chạy lại đúng lệnh này. (Có thể dùng `npm run dev`,
   nhưng trên Windows `--watch` hay báo `EADDRINUSE` khi tự khởi động lại và hai bản cùng
   chạy sẽ tranh cổng 3001.)

3. Chạy ngrok (mục 5.4) trong terminal khác.
4. Kiểm tra: `npm run fb:check`, và mở
   `https://haphazard-spinal-gradation.ngrok-free.dev/health` phải ra
   `{"status":"ok",...}`.
5. Nhắn vào Page OmniChannel từ tài khoản có vai trò; tin xuất hiện trong
   Omnichannel của Rocket.Chat. Agent trả lời trong Rocket.Chat, tin sẽ về
   Messenger sau tối đa vài chục giây (bridge poll mỗi 10 giây).

## 9. Xử lý sự cố

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| `fb:check` báo `Session has expired` / `code 190` | Token hết hạn hoặc bị thu hồi | Làm lại mục 2 |
| Meta báo "Không thể xác minh URL gọi lại" | Bridge/ngrok chưa chạy, hoặc verify token lệch | Bật bridge + ngrok, kiểm tra mục 4 và 6 |
| Log bridge: `Rejected webhook with missing or invalid signature` | `FB_APP_SECRET` sai, hoặc app Meta khác | So lại mục 3, khởi động lại bridge sau khi sửa `.env` |
| Trình duyệt mở URL ngrok ra trang cảnh báo ngrok | Bình thường với gói free khi mở bằng trình duyệt; Meta gọi webhook không bị ảnh hưởng | Bỏ qua |
| Log bridge: `Rocket.Chat API error 429 … wait 10 seconds` lặp lại | Gọi `messages.history` vượt giới hạn của Rocket.Chat | Bản mới tự chia ngân sách giữa các phòng. Muốn nhanh hơn: Rocket.Chat Administration > Settings > Rate Limiter > API tăng giới hạn, rồi tăng `ROCKETCHAT_POLL_MAX_CALLS_PER_MINUTE` trong `.env` và khởi động lại bridge |
| Agent trả lời nhưng khách nhận chậm (khoảng 10 giây trở lên) | Polling: độ trễ = chu kỳ × số phòng ít hoạt động | Bình thường với polling; phòng đang chat được ưu tiên. Giải pháp tận gốc là Omnichannel webhook của Rocket.Chat (mục 10) |
| Log bridge: `EADDRINUSE ... port: 3001` | Đang có một bản bridge khác giữ cổng | Chạy `scripts\restart-bridge.ps1` (tự dừng bản cũ) |
| Khách nhắn nhưng AI không trả lời | AI đang im vì agent đã nhận cuộc trò chuyện (30 phút) | Khách gõ `/bot`, hoặc chờ hết `AI_RESUME_AFTER_MINUTES` |
| Phòng có dòng `⚠️ [Bridge] Không gửi được …` | Lỗi gửi vĩnh viễn (khách chặn, ngoài 24 giờ…) hoặc token hỏng | Đọc lý do trong dòng đó; token hỏng thì làm lại mục 2 |
| ngrok báo `ERR_NGROK_4018` | Chưa thêm authtoken | Làm mục 5.2 |
| ngrok báo domain đang được dùng ở nơi khác | Một tunnel khác đang chạy cùng domain | Tắt tunnel cũ (`taskkill /IM ngrok.exe /F`) |
| Nhắn vào Page nhưng bridge không nhận gì | Tài khoản chưa có vai trò trong app, hoặc Page chưa đăng ký field `messages` | Mục 7, mục 6 bước 5 |
| Gửi ra Messenger lỗi `code 10` / `(#200)` | Ngoài cửa sổ 24 giờ hoặc thiếu quyền | Khách phải nhắn trước; kiểm tra quyền `pages_messaging` |
| Ảnh/file khách gửi không vào Rocket.Chat | File > 25 MB, hoặc URL không thuộc CDN Facebook | Xem log `[facebook] Failed to handle`; đổi `FB_MAX_MEDIA_BYTES` nếu cần |

## 10. Rocket.Chat Omnichannel webhook (agent → khách trong < 3 giây)

Mặc định bridge hỏi Rocket.Chat tối đa 8 lần/phút bằng polling nên tin agent tới khách chậm
10–30 giây. Với webhook, Rocket.Chat tự đẩy từng tin agent tới bridge ngay khi agent gửi.
Polling vẫn chạy làm dự phòng (xem 10.2).

Đã đọc từ mã nguồn Rocket.Chat 8.9.0 (Docker `rocketchat-compose-2.0.0`, chỉ đọc):
Rocket.Chat gọi `POST <URL webhook>` với JSON, header `X-RocketChat-Livechat-Token` chứa
**Secret token**; chỉ coi là thành công khi bridge trả `200` (5xx/429 thì thử lại tối đa 5 lần).

| Tùy chọn trong Rocket.Chat | `type` trong payload | Bridge làm gì |
|---|---|---|
| Send request on agent message | `Message`, `messages[0].agentId` có giá trị | Gửi tin/file tới khách ngay (cùng đường gửi với polling) |
| Send request on visitor message (tùy chọn) | `Message`, không có `agentId` | Chỉ là tín hiệu "webhook còn sống" |
| Send request on chat close | `LivechatSession`, có `closedAt` | Polling chạy ngay và đóng phòng |
| Send request on chat taken / start / forward | `LivechatSessionTaken` / `Start` / `Forwarded` | Chỉ là tín hiệu "còn sống" (không đổi trạng thái AI) |

### 10.1 Bật webhook (làm trên giao diện admin Rocket.Chat, một lần)

1. Sinh một secret ngẫu nhiên riêng cho webhook này:
   ```powershell
   [Convert]::ToBase64String([byte[]](1..32 | ForEach-Object { Get-Random -Maximum 256 }))
   ```
2. Thêm vào `.env` của bridge rồi khởi động lại bridge (`scripts\restart-bridge.ps1`):
   ```env
   ROCKETCHAT_WEBHOOK_SECRET=<secret vừa sinh>
   ```
   Khi chạy, log có dòng `[startup] Rocket.Chat webhook: http://localhost:3001/webhook/rocketchat`.
3. Rocket.Chat: **Administration → Omnichannel → Webhooks**:
   - **Webhook URL**: `http://host.docker.internal:3001/webhook/rocketchat`
     (Rocket.Chat chạy trong Docker, bridge chạy trên máy host; đổi `3001` theo `PORT`).
   - **Secret token**: đúng giá trị `ROCKETCHAT_WEBHOOK_SECRET`.
   - Bật **Send request on agent message** (bắt buộc).
   - Nên bật thêm **Send request on visitor message** (làm tín hiệu sống, xem 10.2) và
     **Send request on chat close**.
   - Lưu.
4. Kiểm tra: agent trả lời một tin trong phòng; tin tới khách ngay (không phải đợi chu kỳ
   polling) và `GET /health` có `rocketChatWebhook.alive: true`.

### 10.2 Cơ chế dự phòng

- Webhook "sống" = bridge nhận một sự kiện hợp lệ trong `ROCKETCHAT_WEBHOOK_SILENCE_MS`
  (mặc định 5 phút). Khi sống, polling chỉ chạy mỗi `ROCKETCHAT_WEBHOOK_FALLBACK_POLL_MS`
  (mặc định 60 giây) để bắt tin sót; khi im lặng quá ngưỡng, polling trở lại tốc độ bình thường.
- Gửi qua webhook thất bại (lỗi tạm thời): polling chạy ngay ở lượt kế tiếp để thử lại.
- Webhook và polling dùng chung bộ nhớ id tin đã xử lý và một hàng đợi theo từng khách,
  nên một tin không bao giờ gửi hai lần.
- Hạn chế: webhook im lặng thật sự (không ai nhắn) trông giống webhook hỏng; bật "visitor
  message" để tin của khách cũng là một tín hiệu sống. Nếu webhook hỏng giữa lúc đang sống,
  tin agent trễ tối đa 60 giây (polling dự phòng) và sau 5 phút polling nhanh trở lại.
- Tin agent do app/blocks sinh ra (Rocket.Chat đóng gói `blocks` thành JSON) không đi qua
  webhook; polling dự phòng gửi chúng.
- Muốn tắt: xóa `ROCKETCHAT_WEBHOOK_SECRET` (route trả `503`, polling như cũ).

### 10.3 Sự cố

| Triệu chứng | Nguyên nhân | Cách xử lý |
|---|---|---|
| Log `[rc-webhook] Rejected request with missing or invalid token` | Secret token trong Rocket.Chat khác `.env` | Nhập lại cho khớp, khởi động lại bridge |
| Rocket.Chat không gọi được bridge | URL sai, hoặc dùng `localhost` trong Docker | Dùng `host.docker.internal`; kiểm tra tường lửa cho cổng bridge |
| `/health` có `alive: false` dù đã cấu hình | Chưa có sự kiện nào trong ngưỡng im lặng | Bật "visitor message", gửi một tin thử |

## 11. Điều khiển Claude từ điện thoại (Remote Control)

Remote Control nối phiên Claude Code trên máy với tài khoản claude.ai của bạn, để
xem và chỉ đạo phiên từ điện thoại.

1. Bật: công tắc **Remote Control** trên thanh công cụ của phiên trong app Claude
   desktop (hoặc nhờ Claude bật trong phiên). Phiên hiện tại đã được bật.
2. Trên điện thoại: mở app **Claude** (iOS/Android) đăng nhập cùng tài khoản, vào
   tab **Code**; hoặc mở <https://claude.ai/code> bằng trình duyệt.
3. Chọn đúng phiên (cùng tên và thư mục `rc-omnichannel-bridge`) rồi nhắn lệnh.
4. Tắt: gạt công tắc Remote Control về tắt khi không dùng.

Lưu ý:

- **Máy tính phải bật, không ngủ và có mạng**, vì mọi lệnh vẫn chạy trên máy này
  (bridge, ngrok, Docker cũng ở đây). Điện thoại chỉ là bộ điều khiển.
- Ai có quyền vào tài khoản claude.ai của bạn thì điều khiển được phiên. Hãy bảo vệ
  tài khoản (mật khẩu mạnh, bật 2FA) và tắt Remote Control khi không cần.
- Các lệnh cần phê duyệt (chạy lệnh, sửa file) vẫn hỏi bạn; duyệt ngay trên điện thoại.
- Đừng dán token, secret vào khung chat trên điện thoại.

## 12. Khi bí mật bị lộ

- Lộ `FB_PAGE_ACCESS_TOKEN`: ở mục 2 bấm biểu tượng thùng rác (gỡ Page khỏi app)
  rồi thêm lại, tạo token mới; cập nhật `.env`.
- Lộ `FB_APP_SECRET`: ở mục 3 bấm **Đặt lại**, dán secret mới vào `.env`, khởi
  động lại bridge.
- Lộ authtoken ngrok: <https://dashboard.ngrok.com/get-started/your-authtoken> >
  **Reset**, rồi chạy lại `ngrok config add-authtoken`.
- Không bao giờ dán các giá trị này vào chat, issue, ảnh chụp màn hình hay commit.
