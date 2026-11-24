# Lint baseline

Ghi nhận khi thêm ESLint (flat config, `eslint.config.js`). Chưa sửa mã ứng dụng để tránh xung đột với việc tái cấu trúc đang diễn ra.

Kết quả `npm run lint`: **0 error, 9 warning**.

## Theo quy tắc

| Quy tắc | Mức | Số lượng |
| --- | --- | --- |
| `no-unused-vars` | warn | 6 |
| `no-useless-assignment` | warn | 3 |
| `eqeqeq`, `no-var`, `prefer-const` | warn | 0 |

`no-useless-assignment` thuộc bộ recommended của ESLint 10 (mặc định `error`); đã hạ xuống `warn` để CI không đỏ.

## Theo file

| File | Dòng | Quy tắc | Ghi chú |
| --- | --- | --- | --- |
| `ai.js` | 236 | no-unused-vars | `err` trong catch không dùng |
| `index.js` | 26 | no-unused-vars | `DEFAULTS` gán nhưng không dùng |
| `media/facebookFiles.js` | 57 | no-useless-assignment | giá trị `name` gán không được dùng |
| `rocketchat.js` | 70, 313 | no-useless-assignment | giá trị `body` gán không được dùng |
| `textFormat.js` | 129 | no-unused-vars | `err` trong catch không dùng |
| `test/auto-delivery-recovery.test.js` | 23 | no-unused-vars | `telegram` |
| `test/auto-webhook-security.test.js` | 49 | no-unused-vars | `delay` |
| `test/media.test.js` | 27 | no-unused-vars | `ok` |

## Nghi vấn bug (cần người xem)

Không có lỗi rõ ràng. Ba cảnh báo `no-useless-assignment` (`media/facebookFiles.js:57`, `rocketchat.js:70`, `rocketchat.js:313`) có thể là biến gán rồi bị ghi đè trước khi dùng; nên xem lại logic sau khi refactor xong. Các dòng trên theo mã trước khi di chuyển file vào `src/`.

## Cách xử lý sau này

Sửa các cảnh báo sau khi refactor ổn định, rồi nâng quy tắc lên `error` hoặc dùng `eslint --max-warnings 0`.

## Quyết định

- Không bật Prettier: sẽ định dạng lại hàng loạt file; chỉ dùng `.editorconfig`.
- `.editorconfig` đặt `end_of_line = lf` (index git lưu LF; working tree Windows có thể là CRLF do autocrlf).
