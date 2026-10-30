# Hướng dẫn sử dụng Claude Code Control Center

Công cụ phân tích **cục bộ, chỉ-đọc** cho dữ liệu sử dụng và cấu hình Claude Code. Chỉ chạy trên `127.0.0.1`, không telemetry, không gọi API ngoài, không có giá tiền.

> **Lưu ý quan trọng:** mọi số liệu "event facts" là **cấu trúc nguồn quan sát được, chưa được xác thực trên transcript thật**. Chúng không phải số prompt, số turn, tỷ lệ thành công hay năng suất.

---

## 1. Chạy nhanh

```bash
pnpm install          # lần đầu
pnpm build            # lần đầu hoặc sau khi sửa mã
CLAUDE_CONTROL_DB_PATH=/duong/dan/tuyet/doi/usage.db pnpm start
```

Mở http://127.0.0.1:3210.

- Cổng cố định `3210`, chỉ bind `127.0.0.1`. Request có header `Host` khác `127.0.0.1:3210` hoặc `localhost:3210` bị từ chối (403).
- `pnpm dev` chạy chế độ phát triển (cùng cổng).
- Không đặt `CLAUDE_CONTROL_DB_PATH`: dùng đường dẫn mặc định
  `~/Library/Application Support/claude-code-control-center/usage.db`.
- Dashboard **chỉ mở database ở chế độ đọc**: không tạo, không migrate, không ghi. Database thiếu thì trang hiện trạng thái trống và không tạo gì.

---

## 2. Đưa dữ liệu vào (chỉ khi bạn chủ động)

Dashboard không tự tìm transcript hay cấu hình. Dữ liệu vào database qua hai lệnh tường minh.

### 2.1 Ingest một transcript (`pnpm ingest`)

Mỗi lần chạy xử lý **đúng một tệp `.jsonl`** do bạn chỉ định.

```bash
pnpm ingest help

# Bước 1: xem trước (chỉ đọc metadata, không mở tệp, không tạo gì). In ra token xác nhận.
pnpm ingest preview /duong/dan/tuyet/doi/session.jsonl

# Bước 2: ingest, bắt buộc có --db và token từ bước 1
pnpm ingest run --db /duong/dan/tuyet/doi/usage.db --token <token> /duong/dan/tuyet/doi/session.jsonl
```

Quy tắc:

- Đường dẫn phải tuyệt đối, dạng thật (không symlink, không `..`, không ký tự đại diện), đuôi `.jsonl`, tối đa 64 MiB.
- `--db` bắt buộc, **không có giá trị mặc định** cho lệnh này.
- Token gắn với đường dẫn và metadata của tệp. Token của tệp khác hoặc tệp đã đổi bị từ chối (`TOKEN_MISMATCH`).
- Kết quả chỉ gồm số đếm và mã lỗi cố định, không bao giờ in nội dung hay đường dẫn trong lỗi.
- Mã thoát: `0` thành công, `2` bị từ chối trước khi làm gì, `3` lỗi sau khi bắt đầu (giao dịch được rollback).

### 2.2 Tùy chọn `--prompt-size` (mặc định TẮT)

```bash
pnpm ingest run --db <db> --token <token> --prompt-size <tệp>
```

- Đọc văn bản của event `user` **trong bộ nhớ** chỉ để ghi một bucket kích thước thô: `empty`, `xs` (1–50 ký tự), `s` (51–200), `m` (201–1000), `l` (1001–5000), `xl` (>5000), hoặc `unsupported`.
- Không có cờ này: nội dung **không bao giờ được đọc**, trạng thái là `not-read`.
- Không bao giờ lưu, in hay log: nội dung, trích đoạn, hash của nội dung, độ dài chính xác.
- Chỉ dùng được với `run`, tối đa một lần.
- Tệp đã có bucket sẽ **không bị hạ** về `not-read` nếu sau đó chạy không có cờ.

### 2.3 Làm mới event facts cho tệp đã ingest

Database tạo trước khi có event facts thì chưa có facts. Chạy **lại đúng lệnh `run` cho tệp đó**:

- Chỉ facts của tệp đó được thu thập hoặc thay thế (cùng một giao dịch).
- Bản ghi usage, session và tổng token **giữ nguyên**.
- Tệp bạn không nêu tên không bị đụng đến. Không có backfill hàng loạt hay duyệt thư mục.
- Chạy lại nhiều lần cho cùng tệp cho cùng kết quả (idempotent).
- Nếu ghi facts lỗi: mã `FACTS_FAILED`, toàn bộ lần chạy được rollback.

### 2.4 Quét cấu hình (`pnpm config:scan`)

```bash
pnpm config:scan --db /duong/dan/tuyet/doi/usage.db \
  --user-root /duong/dan/thu-muc-cau-hinh-claude \
  --project-root /duong/dan/du-an
```

- Cần ít nhất một trong `--user-root` hoặc `--project-root`. Chỉ quét các tệp được nhận diện (CLAUDE.md, settings, rules, agents, skills).
- "Có trên đĩa" **không có nghĩa là đang được nạp**; mức kích hoạt luôn là chưa xác minh. Token ước tính = byte / 4.
- Kết quả chỉ là số tổng hợp.

---

## 3. Các trang của dashboard

| Trang | Đường dẫn | Nội dung |
|---|---|---|
| Overview | `/` | Trạng thái quét, tổng token đã settle, các mục chưa giải quyết |
| Usage | `/usage` | Token theo model, theo ngày UTC, theo session; bộ lọc `from`/`to`, bật/tắt sidechain |
| Configuration audit | `/config` | Kiểm kê cấu hình và các phát hiện tĩnh |
| Recommendations | `/recommendations` | Gợi ý để con người xem xét (không áp dụng gì, không tuyên bố tiết kiệm) |
| **Event facts** | `/analytics` | Thống kê cấu trúc event/tool (xem mục 4) |
| Data quality | `/quality` | Trạng thái bản ghi, trường token không hợp lệ, chẩn đoán lần quét gần nhất |
| Run history | `/history` | Lịch sử các lần quét, mới nhất trước |
| Source coverage | `/sources` | Các nguồn database đã thấy và lịch sử từng nguồn |

Về tổng token (Overview/Usage): chỉ tính bản ghi **accepted**; các nhóm xung đột (conflicting) hoặc mơ hồ (ambiguous) hiển thị riêng dưới dạng khoảng/phương án, không cộng vào tổng. Đây không phải số tiền thanh toán và có thể thiếu so với bộ đếm của Claude Code.

---

## 3b. Biểu đồ

Các biểu đồ dùng thư viện **Recharts**; mỗi biểu đồ luôn đi kèm **bảng dữ liệu tương ứng** ngay bên dưới (bản thay thế dễ tiếp cận). Rê chuột hoặc dùng phím Tab vào biểu đồ để xem tooltip. Màu sáng/tối tự theo hệ điều hành.

| Trang | Biểu đồ |
|---|---|
| Overview | Token đã settle theo loại bộ đếm (một thanh xếp chồng) |
| Usage | Token theo ngày UTC (cột xếp chồng, cũ → mới); token theo model (thanh xếp chồng) |
| Event facts | Nguồn theo trạng thái facts; event theo trạng thái kích thước; tool theo bucket (kept / duplicates); event và tool theo ngày UTC |
| Data quality | Bản ghi theo trạng thái kế toán |

Quy ước: mỗi loại token giữ **một màu cố định** ở mọi biểu đồ (Input xanh dương, Output cam, Cache read xanh ngọc, Cache creation vàng); `not-read` và `unsupported` có màu **khác** các bucket đo được nên không thể nhầm với độ dài 0; ngày không có dữ liệu **không được vẽ** (không phải số 0); bucket tool bằng 0 bị lược khỏi biểu đồ nhưng vẫn có trong bảng. Biểu đồ không bao giờ trộn token vào event facts.

---

## 4. Trang Event facts (`/analytics`)

Thứ tự từ trên xuống:

1. **Facts coverage** (đọc trước tiên). Các trạng thái:
   - *No sources*: database không có nguồn nào.
   - *Facts not collected*: có nguồn nhưng chưa thu thập facts, **không hiện số liệu** (không hiển thị số 0).
   - *Partial coverage*: chỉ một số nguồn có facts; số liệu chỉ bao gồm các nguồn đó.
   - *Complete for stored sources*: mọi nguồn đã lưu có facts. Không có nghĩa là toàn bộ hoạt động Claude Code.
   - Các thẻ: Stored sources, Collected (current), Collected (older logic), Not collected.
2. **User events**, kèm cảnh báo `unverified-source-structure`: số event có kiểu nguồn là `user` (không phải prompt/turn), chia main / sidechain / sidechain unknown, và bảng 8 trạng thái kích thước:
   `empty`, `xs`, `s`, `m`, `l`, `xl`, `unsupported`, `not-read`.
   - `not-read` = chưa đọc nội dung; `unsupported` = đã đọc nhưng không phải văn bản được hỗ trợ. **Cả hai đều không phải độ dài 0.**
3. **Tool calls**: số `tool_use` theo bucket cố định (12 tên tích hợp sẵn + `other` + `unknown`).
   - *Occurrences*: mọi block, kể cả lặp. *Kept*: một cho mỗi tool-use id cộng mọi lời gọi không có id. *Duplicates*: phần lặp. *Anonymous*: không có id, không bao giờ gộp.
   - Đây là đếm cấu trúc đã parse, **không chứng minh tool đã chạy hay thành công**.
4. **Daily facts (UTC)**: bảng theo ngày UTC, mới nhất trước; lát cắt "undated" cho facts không có timestamp hợp lệ; bộ lọc ngày (`From`/`To`, dạng `YYYY-MM-DD`, tối đa 366 ngày).
5. **Sessions**: tham chiếu mờ 8 ký tự (không phải session id của Claude, không nhận dạng người dùng/thiết bị/dự án), phân trang 50 mỗi trang. Bấm vào để xem chi tiết (trạng thái kích thước, tool theo bucket, các ngày của session). Tham chiếu không tồn tại hoặc mơ hồ cho trạng thái "không tìm thấy".

Trang không hiển thị token, không có nút ingest/backfill/xóa/bật `--prompt-size`.

### Thông báo trạng thái thường gặp

| Hiện tượng | Ý nghĩa | Cách xử lý |
|---|---|---|
| "No database yet" | Chưa có file database | Tạo bằng `pnpm ingest run ...` hoặc trỏ `CLAUDE_CONTROL_DB_PATH` |
| "No completed usage scan" | Database có nhưng chưa có lần quét hoàn tất | Ingest một tệp |
| `SCHEMA_OUTDATED` | Database cũ hơn schema hiện tại | Chạy `pnpm ingest run --db <db> ...` một lần để nâng cấp; trang không tự migrate |
| "Facts not collected" | Nguồn cũ chưa có facts | Chạy lại `run` cho từng tệp (mục 2.3) |
| `QUERY_FAILED` | Truy vấn lỗi | Chỉ hiện mã cố định, không có chi tiết |

---

## 5. API chỉ-đọc

Tất cả là `GET`, không body, phản hồi dạng `{ "state", "data", "errorCode" }` với `state` ∈ `ok`, `no-database`, `no-completed-scan`, `unavailable`. Tham số sai trả `400` chỉ nêu tên tham số.

```
/api/status
/api/usage/summary   /api/usage/models   /api/usage/days   /api/usage/sessions   /api/usage/quality
/api/config/summary  /api/config/findings
/api/recommendations
/api/runs            /api/runs/detail?id=
/api/sources         /api/sources/detail?ref=
/api/analytics/summary
/api/analytics/trends            ?from=&to=&limit=&offset=
/api/analytics/tools
/api/analytics/sessions          ?limit=&offset=
/api/analytics/sessions/detail   ?id=<16 hex>&limit=&offset=
```

Tham số chung: `limit` 1–200 (mặc định 50), `offset` 0–100000, `from`/`to` là ngày UTC `YYYY-MM-DD`, `sidechain=include|exclude` (chỉ các API usage). Tham số lạ hoặc lặp bị từ chối.

Ví dụ:

```bash
curl -s http://127.0.0.1:3210/api/analytics/summary
curl -s "http://127.0.0.1:3210/api/analytics/trends?from=2026-04-01&to=2026-04-30"
```

Mọi payload analytics có `"validation": "unverified-source-structure"` và một `note` giải thích.

---

## 6. Bảo đảm riêng tư

- **Không bao giờ lưu:** prompt, phản hồi, tham số hay kết quả của tool, nội dung tệp, đường dẫn, giá trị môi trường, bí mật.
- **Tên tool:** chỉ lưu nếu thuộc danh sách cố định (`Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Task`, `TodoWrite`); mọi tên khác, kể cả `mcp__*`, thành `other`.
- **ID:** session id và tool-use id chỉ được lưu dưới dạng fingerprint có salt cục bộ; giao diện chỉ hiện tiền tố ngắn.
- **Tách biệt:** event facts độc lập với kế toán usage, không bao giờ làm thay đổi tổng token đã settle.
- **Không suy luận** danh tính, thiết bị, IP, dự án hay kết quả công việc.
- Tệp database tạo với quyền `0600`, thư mục `0700`.

---

## 7. Giới hạn đã biết

- Ngữ nghĩa transcript thật **chưa được xác thực**: event `user` nào là prompt, cách `tool_result` xuất hiện, tính duy nhất của tool-use id, ý nghĩa sidechain, vai trò của `requestId`/`parentUuid`.
- Mỗi lần `ingest run` chỉ một tệp, mỗi tệp cần một `preview` để lấy token; chưa có backfill hàng loạt.
- Làm mới facts để lại một dòng "unchanged" trong lịch sử chạy.
- Phát hiện thay đổi tệp dựa trên metadata; một thay đổi giữ nguyên mọi metadata thì không phát hiện được.
- Chỉ macOS. Giao diện được thử trên Chromium headless (desktop 1280×900 và mobile 375×667), chưa thử bằng trình đọc màn hình.

---

## 8. Khắc phục sự cố

| Vấn đề | Cách làm |
|---|---|
| Cổng 3210 đang bận | Tắt tiến trình đang giữ cổng (`lsof -nP -iTCP:3210 -sTCP:LISTEN`) |
| `pnpm start` báo thiếu bản build | Chạy `pnpm build` trước |
| Lỗi `NOT_CANONICAL` khi ingest | macOS: `/tmp` thực ra là `/private/tmp`; dùng đường dẫn thật |
| Muốn đổi database | Dừng server, chạy lại với `CLAUDE_CONTROL_DB_PATH` khác |
| Muốn xem nguồn đã có trong database | Trang `/sources` |

Kiểm tra chất lượng mã: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `npx tsc -p tsconfig.cli.json --noEmit`, `pnpm build`.
