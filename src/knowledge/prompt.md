# Prompt: Hiển thị đúng định dạng Rocket.Chat → Telegram

> Trạng thái: **đã triển khai** trong patch đi kèm (31/31 test pass, gồm 14 test
> cũ). File này vừa là đặc tả, vừa là prompt để giao cho agent/dev khác áp dụng
> hoặc kiểm tra lại. Phạm vi: chỉ chiều **agent Rocket.Chat → Telegram**.

## 1. Vai trò và mục tiêu

Bạn đang làm việc trong `rc-omnichannel-bridge` (Node.js 22, CommonJS, Express,
`node --test`). Khi agent Omnichannel soạn tin bằng toolbar của Rocket.Chat,
Telegram phải hiển thị **đúng định dạng** thay vì chữ thô `**...**`, `__...__`,
`~~...~~`, `` `...` ``, ```` ``` ````.

Không được làm mất tin nhắn, không làm hỏng tin hệ thống/AI, không làm vỡ các
luồng media, retry, polling đang chạy.

## 2. Kết quả rà soát (nguyên nhân gốc)

| Vị trí | Phát hiện |
|---|---|
| `telegram.js` `sendMessage()` | Body chỉ có `{ chat_id, text }`, **không có `parse_mode`** nên Telegram coi mọi thứ là text thô. |
| `textFormat.js` `rcToTelegramText()` | Có comment cố ý: "Markdown is intentionally sent as raw text ... to avoid Telegram escaping errors". Chỉ đổi shortcode emoji và tách tin 4096 ký tự. |
| `index.js` `pollAgentMessages()` | Điểm duy nhất agent → Telegram: `telegram.sendMessage(entry.platformUserId, text)` và `telegram.sendMedia(..., text)` (caption). |
| `index.js` `sendReplyToPlatform()` | Dùng chung cho **câu trả lời AI** và tin hệ thống, cùng gọi `telegram.sendMessage`. Nếu bật định dạng toàn cục, tên file như `my_file_v2.pdf` hoặc output Markdown của LLM sẽ bị biến đổi ngoài ý muốn. |
| `telegram.js` `sendTelegramMedia()` | Caption cắt cứng `slice(0, 1024)` và không có `parse_mode`. Cắt cứng sẽ làm hỏng tag HTML nếu bật định dạng. |
| `sendPhoto()` | Bất kỳ lỗi 400 nào cũng fallback sang `sendDocument`, nên lỗi parse entity sẽ bị xử lý sai nếu không chặn trước. |
| `rocketchat.js` | Agent message lấy từ `messages.history`, trường `msg` là **Markdown thô** của Rocket.Chat. |
| `facebook.js` | Messenger không hỗ trợ định dạng text; xem mục 8. |

## 3. Telegram có hỗ trợ không? → Chọn Option 1

Theo Bot API (Formatting options), Telegram hỗ trợ **đủ tất cả** định dạng cần dùng:

| Rocket.Chat (cả dạng đơn và đôi) | Telegram HTML | Hỗ trợ |
|---|---|---|
| `*b*`, `**b**` | `<b>` | Có |
| `_i_`, `__i__` | `<i>` | Có |
| `~s~`, `~~s~~` | `<s>` | Có |
| `` `code` `` | `<code>` | Có |
| ```` ```code``` ```` (có thể kèm ngôn ngữ) | `<pre>` / `<pre><code class="language-x">` | Có |
| `[nhãn](url)` | `<a href>` | Có |

Ràng buộc từ tài liệu Telegram cần tuân thủ:

- `bold/italic/underline/strikethrough/spoiler` lồng được nhau, **nhưng không
  chứa hoặc nằm trong `pre`/`code`**. Các entity khác không lồng nhau.
- HTML: chỉ cần escape `<`, `>`, `&`; chỉ hỗ trợ named entity `&lt; &gt; &amp; &quot;`.
- Mode `Markdown` (legacy) **không có strikethrough**; MarkdownV2 yêu cầu escape
  nhiều ký tự và một ký tự sót sẽ làm API trả `400 can't parse entities`.
- Giới hạn 4096 ký tự được tính **sau khi parse** (không tính tag); caption 1024.

Toolbar Rocket.Chat sinh `**`, `__`, `~~`; parser của Rocket.Chat chấp nhận cả
dạng đơn. Phải hỗ trợ **cả hai dạng**. (Phần này dựa trên mô tả của người dùng và
README của `@rocket.chat/message-parser`; cần xác nhận một lần bằng tin thật.)

## 4. Quyết định thiết kế (best practice)

1. **Dùng `parse_mode: "HTML"`, không dùng MarkdownV2.** Ít ký tự cần escape, ít
   khả năng lỗi cả tin.
2. **Tự viết converter nhỏ, không thêm dependency.** Project đang gọn (4 dependency).
3. **Chỉ render tin của agent** (opt-in `{ markdown: true }`). Mặc định
   `sendMessage`/`sendMedia` vẫn gửi nguyên văn, nên tin hệ thống, thông báo upload
   và câu trả lời AI không đổi hành vi.
4. **Stash trước, định dạng sau:** code block, inline code, link, URL trần được cất
   vào placeholder (`\uE000n\uE001`) trước khi áp emphasis. Nhờ đó không định dạng
   trong code, và `snake_case`, `2 * 3 * 4`, `~100 và ~200`, `https://x.com/a_b_/c_`
   không bị biến đổi (dùng lookbehind/lookahead Unicode `\p{L}\p{N}`).
5. **Hạ cấp theo tầng thay vì lỗi:** đầy đủ → chỉ code/link → text thường.
   Validator `isWellFormedTelegramHtml` chặn lồng sai và code/pre trong bold/italic.
6. **Không gửi `parse_mode` khi tin không có định dạng nào.**
7. **Fallback khi API từ chối:** nếu Telegram trả `400` kiểu *can't parse entities /
   unsupported start tag / unmatched end tag*, gửi lại đúng phần đó bằng text thường
   **một lần**. Lỗi 400 khác (chat not found...) không retry.
8. **Tách tin trên nguồn Markdown**, không tách trên HTML để không cắt đôi tag. Fence
   ``` bị cắt giữa chừng được đóng ở cuối chunk và mở lại (cùng ngôn ngữ) ở đầu chunk
   sau; fence chưa đóng của chính tác giả được giữ nguyên.
9. **Feature flag** `TELEGRAM_RENDER_MARKDOWN` (mặc định `true`) để tắt ngay khi cần.
10. **Link chỉ cho `http`, `https`, `tg`, `mailto`.** `javascript:` và scheme khác
    giữ nguyên dạng text.
11. **Không log nội dung tin**, chỉ log độ dài và cờ `formatted`.

## 5. Phạm vi thay đổi

| File | Thay đổi |
|---|---|
| `textFormat.js` | Thêm `rcMarkdownToTelegramHtml`, `isWellFormedTelegramHtml`, `buildTelegramMessages`, `splitPreservingFences`. Giữ nguyên `rcToTelegramText`, `splitTelegramText`, `telegramToRcText`. |
| `telegram.js` | `sendMessage(chatId, text, options)` và mọi `send*`/`sendMedia` nhận `options.markdown`. Thêm `telegramApiError` (có `status`, `description`), `isEntityParseError`, `sendTextPart` (fallback plain), `parse_mode` cho caption, bỏ `slice(0, 1024)`. |
| `index.js` | 2 chỗ trong `pollAgentMessages`: text và caption của agent truyền `{ markdown: true }`. |
| `constants/config.js` | `ENV.telegramRenderMarkdown`. |
| `.env.example`, `README.md` | Tài liệu biến `TELEGRAM_RENDER_MARKDOWN` và bảng định dạng. |
| `test/text-format.test.js`, `test/telegram-format.test.js` | Test mới (mục 6). |

Không đụng: `facebook.js`, `rocketchat.js`, `ai.js`, `documents.js`, `mapping.js`,
luồng Telegram → Rocket.Chat.

## 6. Tiêu chí nghiệm thu

`npm test` phải xanh (hiện 31 test). Các hành vi bắt buộc:

- `**đậm**` → `<b>đậm</b>`; `__nghiêng__` → `<i>nghiêng</i>`; `~~gạch~~` → `<s>gạch</s>`;
  dạng đơn tương đương.
- `` `a<b>&c` `` → `<code>a&lt;b&gt;&amp;c</code>`; fence có/không ngôn ngữ → `<pre>`
  / `<pre><code class="language-js">`; ```` ```một dòng``` ```` hoạt động.
- Không format trong code: `` `**x** _y_` `` giữ nguyên bên trong `<code>`.
- Giữ nguyên (không `parse_mode`): `snake_case_name`, `file_name_v2.pdf`, `2 * 3 * 4`,
  `~100 và ~200`, `a < b && c > d`, `**`, ```` ```unclosed ````, URL chứa `_`.
- `*a _b* c_` (lồng sai) → text thường; `` **`x`** `` → chỉ `<code>`, dấu `**` giữ nguyên.
- `[x](javascript:alert(1))` không thành link.
- `sendMessage(chatId, text)` mặc định: body đúng `{ chat_id, text }`, không `parse_mode`.
- `{ markdown: true }`: có `parse_mode: "HTML"`; khi 400 entity → đúng 1 lần gửi lại
  text thường; 400 khác → throw, không retry.
- Caption media: render + fallback tương tự; không có option thì giữ nguyên.
- Tin dài có code block: mọi chunk có số fence chẵn, HTML hợp lệ, nguồn ≤ 4096.

## 7. Kiểm thử thủ công trên Telegram thật

Test tự động dùng mock `fetch` và **chưa gọi Telegram thật**. Trước khi release, dùng
agent Rocket.Chat gửi lần lượt rồi đối chiếu trên Telegram:

1. Chọn In đậm / In nghiêng / Strikethrough từ toolbar, gõ chữ vào giữa, gửi.
2. Inline code và multi-line code (thử có và không có tên ngôn ngữ).
3. Một dòng trộn: `**đậm _nghiêng_** thường ~~gạch~~`.
4. Chuỗi không được đổi: `my_file_v2.pdf`, `2 * 3 * 4`, `https://example.com/a_b_c`.
5. Code chứa `<div>` và `&` → hiển thị đúng ký tự.
6. Tin > 4096 ký tự có code block ở giữa → nhiều tin liên tiếp, code block đẹp ở từng tin.
7. Gửi ảnh/PDF kèm caption `**ghi chú**` → caption đậm.
8. Đặt `TELEGRAM_RENDER_MARKDOWN=false`, restart → quay về chữ thô.

## 8. Ngoài phạm vi / rủi ro đã ghi nhận (làm sau)

- **Facebook Messenger:** không hỗ trợ định dạng, tin agent vẫn hiện `**...**`.
  Nên thêm hàm `stripRcMarkdown` dùng chung parser và gọi trong `facebook.sendMessage`
  theo nguyên tắc "không hỗ trợ thì chỉ hiện chữ".
- **Telegram → Rocket.Chat:** `message.entities` bị bỏ qua nên chữ đậm/nghiêng/code của
  khách mất định dạng. Cần map entity (offset tính theo UTF-16) sang Markdown RC.
- **Câu trả lời AI** gửi nguyên văn có chủ đích. Nếu muốn render, thêm cờ riêng và
  chỉ bật cho nội dung đã được sanitize.
- **Trùng tin khi retry:** `sendMessage` gửi nhiều phần tuần tự; nếu phần 2 lỗi thì
  `pollAgentMessages` retry cả tin và phần 1 bị gửi lại. Nên lưu tiến độ theo từng phần.
- **Blockquote `>`, heading `#`, danh sách:** chưa render (Telegram có `<blockquote>`,
  không có heading). Giữ text thô để tránh sai lệch hiển thị.
- `debug-dumps/`, `mapping.json`, `data/` chứa chat ID và visitor token thật; đã nằm
  trong `.gitignore`, không đưa vào zip/commit khi chia sẻ.
- Caption nay cũng được đổi shortcode emoji (`:smile:` → 😄) giống tin thường.

## 9. Rollback

Đặt `TELEGRAM_RENDER_MARKDOWN=false` và restart bridge: mọi tin agent quay về văn bản
thô như trước. Không cần revert code.
