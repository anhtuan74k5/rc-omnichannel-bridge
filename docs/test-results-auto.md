# Kết quả kiểm thử tự động (ma trận PLAN.md mục 5)

Chạy bằng `npm test` (node:test): **157 test, 157 pass, 0 fail**. Các bài mới nằm ở
`test/auto-webhook-security.test.js`, `test/auto-delivery-recovery.test.js`, `test/auto-load.test.js`.

Điều kiện: Rocket.Chat được stub trong tiến trình; Graph/Telegram dùng `scripts/e2e/mock-platforms.js`;
AI dùng server stub cục bộ; cổng ngẫu nhiên (không phải 3001); `MAPPING_FILE` tạm trong thư mục temp.
Không có yêu cầu nào ra khỏi máy. Đặt `AUTO_TEST_VERBOSE=1` để xem log khi chạy.

| Mã test | Mô tả | Kết quả | Độ trễ |
|---|---|---|---|
| T-F13 | Chữ ký thiếu/rỗng/sai scheme/không phải hex/cụt/khác secret/của body khác/body bị sửa → 401, không tạo mapping, không vào phòng | pass | - |
| T-F13 (replay) | Gửi lại đúng body đã ký 3 lần: 200 nhưng chỉ xử lý 1 lần (chữ ký Meta không có timestamp nên chống replay dựa vào `mid`) | pass | - |
| T-F14 | 14 payload hỏng (JSON sai, `null`, số, rỗng, `[]`, `object` khác `page`, `entry` rỗng/thiếu/null, `messaging` sai kiểu, thiếu sender, read receipt, echo, `attachments` sai kiểu): không crash, không tin rác. JSON hỏng trả 400 | **bug đã sửa** (400 trả HTML kèm stack trace và đường dẫn máy) | - |
| T-S04 | Body 1,5 MB vào `/webhook/facebook`, `/webhook/telegram`, `/webhook/rocketchat` → 413; server vẫn phục vụ | pass | - |
| T-H02 | Cùng `mid` gửi 5 lần đồng thời, rồi sau khi nạp lại mapping (giả lập restart): chỉ xử lý 1 lần; `mid` mới vẫn được xử lý | pass | - |
| T-S03 | 18 URL xấu (169.254.169.254 http/https, IPv6 metadata, localhost, 127.0.0.1, 10.x, host lạ, `fbcdn.net.evil.com`, `evilfbcdn.net`, userinfo `@`, http thường, ftp, file, javascript, rỗng) bị từ chối trước khi gọi mạng (0 request) | pass | - |
| T-S03 (redirect) | URL CDN hợp lệ trả 302 sang 169.254.169.254: không được tự theo redirect | **bug đã sửa** (thêm `redirect: 'manual'`) | - |
| T-F11 | File > 25 MB (khai báo và không khai báo content-length) bị từ chối; đúng 25 MB qua | pass | - |
| T-F11 (e2e) | Qua webhook: file 26 MB → khách nhận `mediaTooLarge`, agent nhận 1 tin trạng thái, không upload; URL CDN hết hạn (403) → khách nhận `mediaUploadFailed`; host lạ/metadata/localhost → 0 request ra ngoài | pass | - |
| T-S05 | Quét toàn bộ log của file test: không có app secret, page token, verify token, bot token, RC token, nội dung tin hay nội dung của request bị từ chối; chỉ có `length` | pass | - |
| T-S06 | 1 khách spam 100 tin: đúng 20 tin qua, AI bị gọi đúng 20 lần (không tính tin bị chặn), thông báo giới hạn gửi 1 lần, khách khác không bị ảnh hưởng | pass | - |
| T-F24 | Token 190 sticky: đúng 3 lần thử (không retry vô hạn), `[ALERT]` trong log, agent nhận 1 thông báo, `/health` hiện `credentialsRejectedAt.facebook`, không lộ token | **bug đã sửa** (trước đây `/health` không báo; thêm trường này) | - |
| T-F25 | Graph 500/503/429/code 4/timeout (1 lần) rồi thành công: gửi lại ở vòng kế, khách nhận đúng 1 lần (2 request: 1 lỗi + 1 ok), không trùng khi gọi lại | pass | khôi phục < 3 s (timeout giả lập 300 ms) |
| T-F25 (bền) | Graph 500 liên tục: dừng sau 3 lần, agent nhận 1 thông báo | pass | - |
| T-F23 (bổ sung) | Lỗi vĩnh viễn (code 10 / 551): 1 lần thử, agent biết ngay | pass | - |
| T-T19 | Bot bị chặn (403), chat không tồn tại (400 `chat not found`): phân loại permanent, 1 lần thử, agent được báo, không gửi lại | pass | - |
| T-T19 (401) | Bot token sai: `[ALERT]` + `/health`, dừng sau 3 lần | pass | - |
| T-T20 | Telegram 429 (`retry_after`), 5xx: lần 1 lỗi, lần 2 thành công, đúng 1 tin; không ngủ trong request | pass | < 3 s |
| T-A05 | AI trả 500 / timeout (400 ms) / trả rác: tin vẫn vào phòng agent; khách chỉ thấy câu chuyển agent lịch sự, không có lỗi thô | **bug đã sửa** (nhật ký ghi nguyên body lỗi của nhà cung cấp, có thể lặp lại API key) | fallback < 2 s |
| T-A05 (từ chối) | AI trả `handled:false`: đúng 1 thông báo handoff | pass | - |
| T-H06 | `mapping.json` cụt/rỗng/rác nhị phân/`null`: khởi động không crash, cảnh báo rõ, mapping mới hợp lệ | **bug đã sửa** (file hỏng bị ghi đè ở lần lưu kế → mất vĩnh viễn; nay đổi tên thành `mapping.json.corrupt-<ts>`) | - |
| T-H06 (ghi lỗi) | `renameSync` lỗi giữa chừng: file cũ nguyên vẹn, không còn file `.tmp` | pass | - |
| T-H09 | SIGTERM khi hàng đợi còn 4 tin (RC stub 250 ms/tin): đợi đủ, thoát code 0, dedupe đã lưu, cổng đóng | pass | thoát sau ~1 s |
| T-P01 | 100 tin tuần tự qua webhook thật (RC stub 20 ms): đúng thứ tự, không mất/trùng | pass | end-to-end p50 32,8 ms, p95 43,5 ms; ack webhook p50 9,1 ms, p95 11,7 ms |
| T-P02 | 20 khách x 5 tin đồng thời: đúng thứ tự từng khách, không mất/trùng/lẫn phòng | pass | end-to-end p50 524,7 ms, p95 619,5 ms (max 644 ms); ack p50 49 ms, p95 149 ms |

## Bug đã sửa (thay đổi nhỏ nhất)

1. **Lộ stack trace khi body hỏng (T-F14).** Express trả trang HTML có stack và đường dẫn máy.
   `index.js`: thêm error middleware cuối cùng, trả JSON ngắn `400`/`413`, log một dòng không có nội dung.
2. **SSRF qua redirect (T-S03).** `media/facebookFiles.js`: tải attachment với `redirect: 'manual'`.
3. **`/health` không báo token bị thu hồi (T-F24).** `index.js`: `alertCredentialsRejected()` ghi `[ALERT]`
   và `metrics`; `/health` có `credentialsRejectedAt.{facebook,telegram}` (mốc thời gian, không có bí mật).
4. **Log lặp lại nguyên body lỗi của AI (T-A05).** `constants/errors.js`: chỉ giữ `error.message`, che `sk-…`, cắt 200 ký tự.
5. **Mất mapping khi file hỏng (T-H06).** `mapping.js`: file không đọc được được đổi tên thành `.corrupt-<ts>` trước khi bắt đầu mới.
6. `scripts/e2e/mock-platforms.js`: thêm fault `tg-400-chat` (chat not found).

## Quyết định và ghi nhận (không sửa)

- **Replay chữ ký hợp lệ (T-F13):** kế hoạch ghi kỳ vọng 401, nhưng chữ ký của Meta không có timestamp nên không phân biệt được replay với retry. Chọn: 200 + chống trùng theo `mid`. Dedupe chỉ nhớ 100 key gần nhất mỗi khách.
- **Retry không có backoff trong tiến trình (T-F25/T-T20):** gửi lại diễn ra ở vòng poll/webhook kế (≥ 10 s), tối đa `ROCKETCHAT_MAX_MESSAGE_RETRIES` = 3 lần. `retry_after` của Telegram không được đọc cho tin gửi đi, nhưng khoảng cách vòng poll lớn hơn giá trị thường gặp. Chấp nhận được.
- **PSID có trong log** (`[timing] facebook:<psid>`, `psid` trong log.info). Plan T-S05 nhắc PSID; PSID là định danh nền tảng, không phải bí mật, nên chỉ kiểm token/nội dung. Nếu muốn che PSID cần quyết định riêng.
- **T-P02 p50 ≈ 0,5 s** chủ yếu do `mapping.save()` ghi đồng bộ cả file cho mỗi tin; chưa là vấn đề ở quy mô này.
- **T-H09:** gọi thẳng handler SIGTERM đã đăng ký (Windows không cho kiểm thử tín hiệu thật). Nhánh hết hạn 10 s đã có test `idle()` riêng.
- Không chạm cổng 3001, Rocket.Chat/Messenger/Telegram thật, `.env`, `mapping.json` thật.
