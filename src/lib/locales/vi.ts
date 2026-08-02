import type { MessageKey } from "@/lib/locales/en.js";

/**
 * Vietnamese. The `Record<MessageKey, string>` annotation is the completeness
 * guarantee: a key added to `en.ts` and not here fails `pnpm typecheck`.
 *
 * Vietnamese does not inflect for number, so both halves of a `_one`/`_other`
 * pair carry the same text. They stay as two entries rather than collapsing so
 * the key sets match exactly across catalogs.
 */
export const vi: Record<MessageKey, string> = {
	"common.hint.move_confirm": "(↑/↓ để di chuyển, Enter để xác nhận)",
	"common.hint.move_select_confirm":
		"(↑/↓ để di chuyển, Space để chọn, Enter để xác nhận)",
	"common.hint.help": "Chạy `codevhub --help` để xem tất cả các lệnh.",
	"common.happy_coding": "Chúc bạn code vui vẻ! 🎉",
	"common.done": "Xong!",
	"common.file_one": "{count} tệp",
	"common.file_other": "{count} tệp",

	"tasklist.install.running": "Đang cài đặt {label}...",
	"tasklist.install.done": "Đã cài đặt {label}",
	"tasklist.install.failed": "Cài đặt {label} thất bại: {error}",
	"tasklist.update.running": "Đang cập nhật {label}...",
	"tasklist.update.done": "Đã cập nhật {label}",
	"tasklist.update.failed": "Cập nhật {label} thất bại: {error}",
	"tasklist.warning": "Cảnh báo: {warning}",
	"tasklist.unknown": "không xác định",
	"tasklist.unknown_error": "lỗi không xác định",

	"banner.tagline": "Trung tâm AI Coding Agent",

	"tool_select.title.install": "Chọn (các) AI agent để cài đặt",
	"tool_select.title.config": "Chọn (các) AI agent để cấu hình",
	"tool_select.locked.install": "(luôn được cài đặt)",
	"tool_select.locked.config": "(luôn được cấu hình)",
	"editor_select.title":
		"Chọn (các) trình soạn thảo để cài đặt tiện ích mở rộng",
	"auth_method.title": "Chọn phương thức cấu hình",
	"auth_method.new": "Lấy API Key mới",
	"auth_method.manual": "Tôi đã có API Key riêng",
	"auth_method.existing": "Dùng lại API Key hiện có",
	"auth_method.skip": "Bỏ qua cấu hình",

	"setup.complete.restart_terminal": "Xong! Hãy khởi động lại terminal.",
	"setup.complete.reload_shell_prefix": "Xong! Chạy ",
	"setup.complete.reload_shell_suffix": " để tải lại shell.",

	"common.continue_question": "Tiếp tục?",
	"common.retry_hint": "Nhấn Enter để thử lại, Ctrl-C để thoát",
	"common.field_required": "{field} là bắt buộc",

	"install.hint.vscode_continue":
		"Bạn có thể tự cài đặt tiện ích Continue sau.",
	"install.hint.jetbrains_continue":
		"Bạn có thể tự cài đặt plugin Continue sau.",
	"install.hint.vscode_claude_code":
		"Bạn có thể tự cài đặt tiện ích Claude Code sau.",
	"install.hint.jetbrains_claude_code":
		"Bạn có thể tự cài đặt plugin Claude Code sau.",
	"install.codegraph_failed": "Chưa cài được CodeGraph: {error}",
	"update.codegraph_failed": "Chưa cập nhật được CodeGraph: {error}",
	"update.detecting": "Đang kiểm tra các agent đã cài đặt...",
	"update.nothing": "Không có gì để cập nhật.",
	"update.title": "Đang cập nhật các gói",

	"configure.title": "Cấu hình công cụ",
	"configure.configured": "Đã cấu hình {tool}",
	"configure.failed": "Cấu hình thất bại: {error}",

	"confirm.title": "Lưu ý — CoDev sẽ thay đổi cài đặt của bạn.",
	"confirm.revert_prefix":
		"Để quay lại trạng thái trước khi dùng CoDev, hãy chạy ",

	"checklist.env_passed_one": "{count} kiểm tra môi trường đã đạt",
	"checklist.env_passed_other": "{count} kiểm tra môi trường đã đạt",
	"checklist.field.what": "Điều đã xảy ra",
	"checklist.field.cause": "Nguyên nhân",
	"checklist.field.fix": "Cách khắc phục",
	"checklist.field.context": "Bối cảnh",
	"checklist.field.raw": "Chi tiết gốc",

	"activity.commands": "Lệnh đã chạy",
	"activity.endpoints": "Điểm cuối đã kết nối",
	"activity.no_response": "không có phản hồi",

	"proxy_prompt.title": "Cấu hình proxy",
	"proxy_prompt.examples": "Ví dụ:",
	"proxy_prompt.example.ip_port": "IP và cổng",
	"proxy_prompt.example.host_port": "tên máy chủ và cổng",
	"proxy_prompt.example.with_login": "proxy cần đăng nhập",
	"proxy_prompt.example.full_url":
		"URL đầy đủ (mặc định là http:// nếu bạn bỏ qua)",
	"proxy_prompt.failed_with_proxy":
		"Kiểm tra mạng thất bại mặc dù đã cấu hình proxy ({proxy}).",
	"proxy_prompt.wrong_address":
		"Nếu địa chỉ đó sai, hãy nhập địa chỉ đúng và CoDev sẽ chạy lại các kiểm tra với nó.",
	"proxy_prompt.failed_no_proxy":
		"Kiểm tra mạng thất bại. Nếu máy này ra Internet qua proxy, hãy nhập proxy ở đây và CoDev sẽ chạy lại các kiểm tra với nó.",
	"proxy_prompt.not_written":
		"Không có gì được ghi xuống đĩa — điều này chỉ áp dụng cho lần chạy này.",
	"proxy_prompt.field.keep":
		"Proxy (host:port), hoặc Enter để giữ proxy hiện tại: ",
	"proxy_prompt.field.skip": "Proxy (host:port), hoặc Enter để bỏ qua: ",
	"proxy_prompt.retrying": "Đang thử lại qua {proxy}…",
	"proxy_prompt.skipped": "Đã bỏ qua.",
	"proxy_prompt.error.port_only":
		'"{input}" trông chỉ là số cổng. Hãy nhập cả host, ví dụ 10.0.0.1:{input}',
	"proxy_prompt.error.invalid":
		"Địa chỉ này không giống proxy. Hãy dùng host:port, ví dụ 10.0.0.1:8080",

	"login.title": "Đăng nhập",
	"login.failed": "Đăng nhập thất bại: {reason}",
	"login.signed_in": "✓ Đã đăng nhập",
	"login.signed_in_as": "✓ Đã đăng nhập với {email}",
	"login.starting": "Đang bắt đầu đăng nhập...",
	"login.waiting": "Đang chờ hoàn tất đăng nhập trên trình duyệt...",
	"login.browser_didnt_open": "Trình duyệt không mở? Đăng nhập tại đây ",
	"login.copied": "(đã sao chép!)",
	"login.press_c": "(nhấn C để sao chép)",
	"login.paste_caption":
		"Sau khi đăng nhập, hãy sao chép mã hiển thị và dán vào đây:",
	"login.no_keyboard":
		"Terminal này không nhận được bàn phím nên không dùng được cách dán mã — hãy hoàn tất đăng nhập trên trình duyệt.",

	"paste_back.caption_1":
		"Sau khi bạn đăng nhập, trang web sẽ hiển thị một mã ủy quyền.",
	"paste_back.caption_2":
		'Dùng nút "Copy code" trên trang, rồi dán mã vào đây:',
	"paste_back.completing": "Đang hoàn tất đăng nhập...",
	"paste_back.submit_hint": "Nhấn Enter để gửi.",

	"fetch_key.title": "Đang lấy API Key mới",
	"fetch_key.pending": "Đang lấy API key từ gateway...",
	"fetch_key.success": "✓ Đã lấy API key thành công.",
	"fetch_key.failed": "Lấy API key thất bại: {reason}",
	"fetch_key.empty": "Gateway trả về API key rỗng.",
	"fetch_key.empty_again": "Gateway lại trả về API key rỗng.",
	"fetch_key.manual_hint":
		"Nhấn Enter để nhập thông tin thủ công, Ctrl-C để thoát",

	"manual_creds.title": "Nhập thông tin API",
	"manual_creds.field.provider_name": "Tên nhà cung cấp",
	"manual_creds.field.api_url": "URL API",
	"manual_creds.field.api_key": "API Key",
	"manual_creds.empty": "(trống)",
	"manual_creds.hint":
		"Nhấn Enter để xác nhận từng trường (Tên nhà cung cấp là tùy chọn).",

	"admin_login.title": "Đăng nhập quản trị",
	"admin_login.field.username": "Tên đăng nhập",
	"admin_login.field.password": "Mật khẩu",
	"admin_login.signing_in": "Đang đăng nhập...",
	"admin_login.attempt": "(lần thử {n} trên {max})",
	"admin_login.gave_up": "({max} lần thử thất bại — dừng lại)",
	"admin_login.only_admin":
		"Chỉ tài khoản ADMIN/SUPERADMIN mới đăng nhập được ở đây — người dùng thường hãy dùng `codevhub login`.",

	"model_select.title": "Chọn model mặc định",
	"model_select.loading": "Đang lấy danh sách model...",
	"model_select.failed": "Lấy danh sách model thất bại: {error}",

	"login.admin.logged_in_as": "✓ Đã đăng nhập với {username} ({role})",
	"login.signing_out": "Đang đăng xuất phiên trước",
	"login.revoking": "Đang thu hồi token...",

	"remove.confirm":
		"Mọi thứ sẽ được hoàn nguyên về trạng thái trước khi dùng CoDev. Bạn có muốn tiếp tục?",
	"remove.aborted": "Đã hủy.",
	"remove.running": "Đang gỡ các thành phần CoDev...",
	"remove.kept_one":
		"Đã giữ lại {count} tệp cấu hình không do CoDev tạo — các thiết lập của bạn được giữ nguyên:",
	"remove.kept_other":
		"Đã giữ lại {count} tệp cấu hình không do CoDev tạo — các thiết lập của bạn được giữ nguyên:",
	"remove.some_failed": "✗ Một số bước thất bại:",
	"remove.success_prefix": "Đã gỡ thành công. Bây giờ bạn có thể chạy ",
	"remove.success_suffix":
		" để gỡ gói CoDev. Hãy khởi động lại terminal để áp dụng.",

	"upload.uploading": "Đang tải log lên...",
	"upload.browser_url":
		"Nếu trình duyệt không mở, hãy truy cập URL này thủ công:",
	"upload.no_keyboard":
		"Terminal này không nhận được bàn phím — hãy hoàn tất đăng nhập trên trình duyệt.",
	"upload.failed": "✗ Tải lên thất bại",
	"upload.none_found": "Không tìm thấy hội thoại nào cho dự án này.",
	"upload.looked_in": "codevhub đã tìm trong:",
	"upload.launch_hint":
		"Nếu bạn đã dùng AI agent ở đây, hãy chắc chắn bạn khởi chạy nó từ thư mục này.",
	"upload.uploaded": "✓ Đã tải lên {uploaded}/{found} log hội thoại",
	"upload.skipped": "Đã bỏ qua {count} log không thay đổi",
	"upload.failed_logs": "Thất bại {count} log:",
	"upload.more": "(+{count} nữa)",
	"upload.source": "Nguồn: {dir}",

	"skill_pull.title": "Cài đặt skill {name}",
	"skill_pull.title_generic": "Cài đặt skill",
	"skill_pull.resolving": "Đang phân giải skill...",
	"skill_pull.installing": "Đang cài đặt...",
	"skill_pull.install_to": "Cài đặt {name} vào:",
	"skill_pull.location.current": "Thư mục hiện tại (khuyến nghị)",
	"skill_pull.location.global": "Toàn hệ thống",
	"skill_pull.which_agents": "Dành cho agent nào?",
	"skill_pull.toggle_hint": "space để chọn · enter để xác nhận",
	"skill_pull.no_keyboard":
		"Terminal này không nhận được bàn phím nên không thể hiển thị các bước chọn khi cài đặt.\nHãy dùng --here, --global hoặc --dir <path> để chỉ định vị trí mà không cần chúng.",

	"skill_push.title": "Đăng skill lên hub",
	"skill_push.step.uploading": "Đang tải lên",
	"skill_push.step.saving": "Đang lưu thông tin",
	"skill_push.step.submitting": "Đang gửi để duyệt",
	"skill_push.step.approving": "Đang phê duyệt (quản trị)",
	"skill_push.mode.draft": "Lưu thành bản DRAFT (chưa gửi duyệt).",
	"skill_push.mode.auto_approve":
		"Tải lên, gửi duyệt và tự phê duyệt thành PUBLIC (chỉ quản trị).",
	"skill_push.mode.submit": "Tải lên và gửi để duyệt.",
	"skill_push.no_keyboard":
		"Terminal này không nhận được bàn phím nên không thể hiển thị bước xác nhận.\nHãy chạy lại với --json để đăng mà không cần xác nhận.",
	"skill_push.preparing": "Đang chuẩn bị gói...",
	"skill_push.archive_one": "{fileName}  ({count} tệp, {size})",
	"skill_push.archive_other": "{fileName}  ({count} tệp, {size})",
	"skill_push.and_more": "  … và {count} tệp nữa",
	"skill_push.excluded": "Đã loại trừ: {list}",
	"skill_push.confirm": "Đăng skill này?",
	"skill_push.checking_signin": "Đang kiểm tra đăng nhập...",
	"skill_push.publishing": "Đang đăng",
	"skill_push.cancelled": "Đã hủy.",

	"model.loading": "Đang tải thông tin đăng nhập đã lưu...",
	"model.no_creds_prefix":
		"Không tìm thấy thông tin đăng nhập CoDev. Hãy chạy ",
	"model.no_tools_prefix":
		"Không tìm thấy công cụ AI nào được CoDev cấu hình. Hãy chạy ",
	"model.run_install_suffix": " trước.",
	"model.re_auth":
		"API key đã lưu bị từ chối — đang làm mới thông tin đăng nhập trước khi tiếp tục.",
	"model.reauth_failed":
		"Việc xác thực lại không tạo được key hợp lệ. Hãy chạy 'codevhub install' để làm mới thông tin đăng nhập.",
	"model.update_configs_title": "Cập nhật cấu hình công cụ",
	"model.updating": "Đang cập nhật cấu hình công cụ...",
	"model.updated_prefix": "Model mặc định đã đổi thành ",
	"model.updated_middle": " cho ",
	"model.opencode_prefix": "Trong ",
	"model.opencode_suffix":
		", bạn có thể đổi model bất cứ lúc nào bằng /models.",

	"doctor.group.environment": "Môi trường",
	"doctor.group.network": "Mạng",
	"doctor.group.account": "Tài khoản & thông tin đăng nhập",
	"doctor.group.llm": "Truy cập LLM",
	"doctor.group.state": "Máy này",
	"doctor.step.activity": "Hoạt động",
	"doctor.step.result": "Kết quả",
	"doctor.summary.ok":
		"✓ Mọi thứ đều ổn. Bạn đã sẵn sàng chạy `codevhub install`.",
	"doctor.summary.warned":
		"▲ {warned} cảnh báo. `codevhub install` vẫn chạy được, nhưng hãy đọc các ghi chú bên dưới trước.",
	"doctor.summary.failed":
		"✗ {failed} kiểm tra thất bại. Hãy khắc phục trước khi chạy `codevhub install`.",
	"doctor.summary.failed_with_warnings":
		"✗ {failed} kiểm tra thất bại, {warned} cảnh báo. Hãy khắc phục trước khi chạy `codevhub install`.",
	"doctor.next_steps": "Các bước tiếp theo",
	"doctor.report_saved":
		"Báo cáo đầy đủ đã lưu tại {path} — hãy đính kèm khi mở ticket hỗ trợ.",

	"setup.abort": "Đã hủy.",
	"setup.preflight.title": "Đang kiểm tra môi trường của bạn",
	"setup.preflight.hint":
		"Hãy chạy `codevhub doctor` để kiểm tra đầy đủ — npm, mạng, đăng nhập và truy cập LLM — kèm hướng dẫn thiết lập.",
	"setup.installing.packages": "Đang cài đặt các gói",
	"setup.installing.codegraph": "Đang cài đặt CodeGraph",
	"setup.refresh.title": "Làm mới cấu hình CoDev",
	"setup.saved_key.title": "Đang kiểm tra API key đã lưu",
	"setup.saved_key.verifying": "Đang xác minh với gateway...",
	"setup.saved_key.valid": "API key đã lưu vẫn hợp lệ.",
	"setup.saved_key.invalid":
		"API key đã lưu không còn hợp lệ; hãy chọn phương thức khác.",
	"setup.saved_key.unverifiable": "Không xác minh được API key đã lưu: {error}",
	"setup.model_list.title": "Danh sách model",
	"setup.model_list.fallback":
		"Không lấy được danh sách model ({error}); đang dùng model dự phòng {model}.",
	"setup.gateway.title": "Đang xác minh quyền truy cập gateway",
	"setup.gateway.sending": "Đang gửi yêu cầu thử tới {model}…",
	"setup.gateway.the_model": "model",
	"setup.gateway.ok": "Gateway đã chấp nhận yêu cầu thử.",
	"setup.gateway.warning_hint":
		"Cấu hình vẫn được ghi, nhưng các agent của bạn sẽ gặp đúng lỗi này — hãy khắc phục quyền truy cập gateway (quyền dùng model, ngân sách, hoặc khu vực/IP) rồi khởi chạy lại.",
	"setup.codegraph.title": "Thiết lập CodeGraph",
	"setup.codegraph.running": "Đang thiết lập CodeGraph…",
	"setup.codegraph.incomplete": "Thiết lập CodeGraph chưa hoàn tất.",
	"setup.codegraph.wired": "Đã kết nối CodeGraph vào {targets}.",
	"setup.ripgrep.title": "Tìm kiếm tệp",
	"setup.ripgrep.failed":
		"Không chuẩn bị được ripgrep cho CoDev Code: {error}. Việc tìm kiếm tệp có thể không có kết quả trên Windows — hãy cài ripgrep (winget install BurntSushi.ripgrep.MSVC) rồi khởi động lại agent.",

	"help.body":
		'CoDev \u2014 Trung t\u00e2m AI Coding Agent\n\nC\u00e1ch d\u00f9ng: codevhub [l\u1ec7nh] [t\u00f9y ch\u1ecdn]\n\nCh\u1ea1y `codevhub` kh\u00f4ng k\u00e8m l\u1ec7nh s\u1ebd m\u1edf CoDev Code, agent l\u1eadp tr\u00ecnh t\u00edch h\u1ee3p, t\u1ea1i\nth\u01b0 m\u1ee5c hi\u1ec7n t\u1ea1i (`codev` m\u1edf tr\u1ef1c ti\u1ebfp). M\u1ecdi l\u1ec7nh kh\u00f4ng c\u00f3 trong danh s\u00e1ch d\u01b0\u1edbi\n\u0111\u00e2y c\u0169ng \u0111\u01b0\u1ee3c chuy\u1ec3n ti\u1ebfp t\u1edbi n\u00f3 \u2014 `codevhub run "fix the tests"`,\n`codevhub serve`, `codevhub models`, v.v.\n\nL\u1ec7nh c\u1ee7a hub:\n  doctor              Ki\u1ec3m tra m\u00f4i tr\u01b0\u1eddng v\u00e0 m\u1ea1ng tr\u01b0\u1edbc khi c\u00e0i \u0111\u1eb7t\n                      (phi\u00ean b\u1ea3n Node, npm, proxy/TLS, \u0111\u0103ng nh\u1eadp, truy c\u1eadp LLM;\n                      --force \u0111\u1ec3 th\u1eed \u0111\u0103ng nh\u1eadp th\u1eadt thay v\u00ec d\u00f9ng phi\u00ean \u0111\u00e3 l\u01b0u)\n  install             C\u00e0i \u0111\u1eb7t v\u00e0 c\u1ea5u h\u00ecnh c\u00e1c AI coding agent\n  config              C\u1ea5u h\u00ecnh c\u00e1c AI coding agent \u0111\u00e3 c\u00f3\n  update              C\u1eadp nh\u1eadt c\u00e1c AI coding agent \u0111\u00e3 c\u00e0i\n  init                X\u00e2y d\u1ef1ng knowledge graph\n  upload              Xu\u1ea5t v\u00e0 t\u1ea3i log l\u00ean module gi\u00e1m s\u00e1t\n                      (--force, -f \u0111\u1ec3 t\u1ea3i l\u1ea1i to\u00e0n b\u1ed9 h\u1ed9i tho\u1ea1i)\n  model               \u0110\u1ed5i model m\u1eb7c \u0111\u1ecbnh\n  restore [agent]     Kh\u00f4i ph\u1ee5c c\u1ea5u h\u00ecnh tr\u01b0\u1edbc CoDev c\u1ee7a m\u1ed9t agent\n                      (kh\u00f4ng c\u00f3 tham s\u1ed1 th\u00ec x\u1eed l\u00fd m\u1ecdi agent)\n  logs                Hi\u1ec3n th\u1ecb l\u1ea7n ch\u1ea1y g\u1ea7n nh\u1ea5t trong log ch\u1ea9n \u0111o\u00e1n\n                      (--path t\u1ec7p m\u1edbi nh\u1ea5t, --trace <id> m\u1ed9t l\u1ea7n ch\u1ea1y, --verbose chi ti\u1ebft h\u01a1n)\n  login               \u0110\u0103ng nh\u1eadp SSO (--force \u0111\u1ec3 b\u1ecf qua phi\u00ean \u0111\u00e3 l\u01b0u,\n                      --admin \u0111\u1ec3 \u0111\u0103ng nh\u1eadp qu\u1ea3n tr\u1ecb t\u01b0\u01a1ng t\u00e1c, ho\u1eb7c\n                      --username <u> --password <p> \u0111\u1ec3 \u0111\u0103ng nh\u1eadp qu\u1ea3n tr\u1ecb kh\u00f4ng t\u01b0\u01a1ng t\u00e1c)\n  logout              \u0110\u0103ng xu\u1ea5t (c\u1ea3 SSO v\u00e0 phi\u00ean qu\u1ea3n tr\u1ecb)\n  remove              Ho\u00e0n nguy\u00ean m\u00e1y n\u00e0y v\u1ec1 tr\u1ea1ng th\u00e1i tr\u01b0\u1edbc CoDev (--yes \u0111\u1ec3 b\u1ecf qua x\u00e1c nh\u1eadn)\n  --version, -v       Hi\u1ec3n th\u1ecb phi\u00ean b\u1ea3n\n  --help, -h          Hi\u1ec3n th\u1ecb tr\u1ee3 gi\u00fap n\u00e0y\n\nSkill hub:\n  skill search <query>   T\u00ecm ki\u1ebfm tr\u00ean skill hub c\u00f4ng khai\n                         (--json \u0111\u1ec3 xu\u1ea5t d\u1ea1ng m\u00e1y \u0111\u1ecdc,\n                         --limit <n> \u0111\u1ec3 gi\u1edbi h\u1ea1n k\u1ebft qu\u1ea3, m\u1eb7c \u0111\u1ecbnh 20)\n  skill pull <name>      T\u1ea3i v\u00e0 c\u00e0i m\u1ed9t skill cho c\u00e1c agent c\u1ee7a b\u1ea1n\n                         (s\u1ebd h\u1ecfi v\u1ecb tr\u00ed v\u00e0 agent; --here ho\u1eb7c --global \u0111\u1ec3\n                         ch\u1ecdn ph\u1ea1m vi, --agent <list> ho\u1eb7c --all-agents \u0111\u1ec3 ch\u1ecdn\n                         agent, --dir <path> cho \u0111\u01b0\u1eddng d\u1eabn ch\u00ednh x\u00e1c, --force \u0111\u1ec3\n                         ghi \u0111\u00e8; --json \u0111\u1ec3 xu\u1ea5t d\u1ea1ng m\u00e1y \u0111\u1ecdc)\n  skill push <path>      \u0110\u0103ng m\u1ed9t skill (th\u01b0 m\u1ee5c c\u00f3 SKILL.md, ho\u1eb7c t\u1ec7p .zip)\n                         (xem tr\u01b0\u1edbc v\u00e0 x\u00e1c nh\u1eadn tr\u01b0\u1edbc khi t\u1ea3i l\u00ean; --draft-only \u0111\u1ec3 d\u1eebng\n                         \u1edf DRAFT, --auto-approve cho qu\u1ea3n tr\u1ecb, --json \u0111\u1ec3 xu\u1ea5t d\u1eef li\u1ec7u)\n',

	"cli.node_too_old":
		"CoDev yêu cầu Node.js >= {min} (khuyến nghị Node {recommended}). Phiên bản hiện tại: {current}.\nDưới {min}, Node hoàn toàn bỏ qua HTTP_PROXY/HTTPS_PROXY, nên không thể đăng nhập sau proxy của công ty.\nTải về: {url}",
	"cli.login.credentials_together":
		"codevhub login: phải cung cấp đồng thời --username và --password.",
	"cli.logged_out": "Đã đăng xuất.",
	"cli.not_logged_in": "Chưa đăng nhập.",
	"cli.unknown_agent": "Agent không hợp lệ: {agent}. Hợp lệ: {valid}.",
	"cli.unknown_agents": "Agent không hợp lệ: {agents}. Hợp lệ: {valid}.",
	"cli.unknown_skill_subcommand":
		"Lệnh con skill không hợp lệ: {sub}. Hợp lệ: search, pull, push.",
	"cli.codegraph_dir_created":
		"Đã tạo thư mục {dir} trong dự án. Bạn có thể commit nó nếu muốn chia sẻ knowledge graph với cả nhóm.",
	"cli.no_tools_for_hook":
		"Không tìm thấy công cụ nào do CoDev cài. Hãy chạy `codevhub install` trước, hoặc chỉ định agent cụ thể: `codevhub hook claude|codex|opencode`.",
	"cli.shims_installed": "Đã cài shim vào {dir}",
	"cli.shims_patched": "  đã cập nhật {path}",
	"cli.shims_path_updated": "  đã cập nhật PATH của người dùng",
	"cli.shims_none": "Không có shim nào của CoDev được cài.",
	"cli.shims_removed": "Đã gỡ {count} shim khỏi {dir}",
	"cli.shims_cleaned": "  đã dọn {path}",
};
