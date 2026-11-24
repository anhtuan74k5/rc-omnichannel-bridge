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

Khi khởi động, log có dòng `[facebook] Token OK` / `[telegram] Token OK`. Nếu thấy
`Token check FAILED` hoặc `Token expires soon`, tạo lại token (mục 2) rồi khởi động lại;
bridge vẫn chạy nhưng gửi tin sẽ lỗi cho đến khi sửa.

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| `fb:check` báo `Session has expired` / `code 190` | Token hết hạn hoặc bị thu hồi | Làm lại mục 2 |
| Meta báo "Không thể xác minh URL gọi lại" | Bridge/ngrok chưa chạy, hoặc verify token lệch | Bật bridge + ngrok, kiểm tra mục 4 và 6 |
| Log bridge: `Rejected webhook with missing or invalid signature` | `FB_APP_SECRET` sai, hoặc app Meta khác | So lại mục 3, khởi động lại bridge sau khi sửa `.env` |
| Trình duyệt mở URL ngrok ra trang cảnh báo ngrok | Bình thường với gói free khi mở bằng trình duyệt; Meta gọi webhook không bị ảnh hưởng | Bỏ qua |
| Log bridge: `Rocket.Chat API error 429 … wait 10 seconds` lặp lại | Gọi `messages.history` vượt giới hạn của Rocket.Chat | Bản mới tự chia ngân sách giữa các phòng. Muốn nhanh hơn: Rocket.Chat Administration > Settings > Rate Limiter > API tăng giới hạn, rồi tăng `ROCKETCHAT_POLL_MAX_CALLS_PER_MINUTE` trong `.env` và khởi động lại bridge |
| Agent trả lời nhưng khách nhận chậm (khoảng 10 giây trở lên) | Polling: độ trễ = chu kỳ × số phòng ít hoạt động | Bình thường với polling; phòng đang chat được ưu tiên. Giải pháp tận gốc là dùng Omnichannel webhook (xem PLAN.md, G1) |
| Log bridge: `EADDRINUSE ... port: 3001` | Đang có một bản bridge khác giữ cổng | Chạy `scripts\restart-bridge.ps1` (tự dừng bản cũ) |
| Khách nhắn nhưng AI không trả lời | AI đang im vì agent đã nhận cuộc trò chuyện (30 phút) | Khách gõ `/bot`, hoặc chờ hết `AI_RESUME_AFTER_MINUTES` |
| Phòng có dòng `⚠️ [Bridge] Không gửi được …` | Lỗi gửi vĩnh viễn (khách chặn, ngoài 24 giờ…) hoặc token hỏng | Đọc lý do trong dòng đó; token hỏng thì làm lại mục 2 |
| ngrok báo `ERR_NGROK_4018` | Chưa thêm authtoken | Làm mục 5.2 |
| ngrok báo domain đang được dùng ở nơi khác | Một tunnel khác đang chạy cùng domain | Tắt tunnel cũ (`taskkill /IM ngrok.exe /F`) |
| Nhắn vào Page nhưng bridge không nhận gì | Tài khoản chưa có vai trò trong app, hoặc Page chưa đăng ký field `messages` | Mục 7, mục 6 bước 5 |
| Gửi ra Messenger lỗi `code 10` / `(#200)` | Ngoài cửa sổ 24 giờ hoặc thiếu quyền | Khách phải nhắn trước; kiểm tra quyền `pages_messaging` |
| Ảnh/file khách gửi không vào Rocket.Chat | File > 25 MB, hoặc URL không thuộc CDN Facebook | Xem log `[facebook] Failed to handle`; đổi `FB_MAX_MEDIA_BYTES` nếu cần |

## 10. Điều khiển Claude từ điện thoại (Remote Control)

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

## 11. Khi bí mật bị lộ

- Lộ `FB_PAGE_ACCESS_TOKEN`: ở mục 2 bấm biểu tượng thùng rác (gỡ Page khỏi app)
  rồi thêm lại, tạo token mới; cập nhật `.env`.
- Lộ `FB_APP_SECRET`: ở mục 3 bấm **Đặt lại**, dán secret mới vào `.env`, khởi
  động lại bridge.
- Lộ authtoken ngrok: <https://dashboard.ngrok.com/get-started/your-authtoken> >
  **Reset**, rồi chạy lại `ngrok config add-authtoken`.
- Không bao giờ dán các giá trị này vào chat, issue, ảnh chụp màn hình hay commit.

## 12. Chỉ số vận hành, tên khách và giới hạn

- `GET /health` (qua ngrok hoặc `localhost:3001`) hiện số phòng, độ sâu hàng đợi
  Facebook, lần poll cuối, số lần bị 429 và số tin bị giới hạn tốc độ. Nếu
  `lastAgentPollAt` đứng yên nhiều phút thì vòng poll đang kẹt.
- Dòng log `[timing] ...` cho biết chặng nào chậm (AI, Rocket.Chat hay gửi lại khách).
- Visitor mới trong Rocket.Chat mang tên thật của khách nếu lấy được; nếu Page chưa
  có quyền đọc hồ sơ thì vẫn là `FB <psid>`.
- Khách gửi quá `RATE_LIMIT_PER_MINUTE` tin/phút sẽ nhận **một** thông báo chậm lại,
  các tin dư bị bỏ và AI không bị gọi. Khi chạy test thủ công, đừng gửi dồn quá số này.
- Khi `TELEGRAM_POLLING=true`, `POST /webhook/telegram` trả `404`.
