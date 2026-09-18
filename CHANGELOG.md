# 更新日志 (Changelog)

本项目的所有重要变更都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 1.0.3 — Atria 审计「JS 层」修复批次（JS-H1…JS-H8；进行中；不发布）

> 与 Python 批次相同约定：一个 commit 一项修复（`fix(JS-H<n>)`），每个修复自带回归
> 测试；JS 层无构建步骤，修复在**下一次 ff_* 工具调用**时即生效（无需重启）。

- **JS-H1 协议键漂移（头条）**：`tools/result.mjs` 读的是 `data.convertedContent`、
  `data.resultId`、`data.fileInfo.*`、`data.confidence` —— Python round-1 协议实际发的是
  `data.content` + `data.meta.{result_id, parser, file_size, confidence}`，且**不存在**
  `fileInfo`。后果：`ff_result` 取回正文**永远为空**却报 `ok:true`，`notify.mjs` 广告的
  result_id 在头扫描里也永远匹配不上（`"resultId"` vs `"result_id"`）——拖入→通知→取回
  的主链路端到端断死。现全部对齐真实协议键，删除 `fileInfo` 兜底，list 行与 confidence
  一并改读 `meta.*`；id 查找改为：旧式精确 stem → 新式精确 stem → 源 stem 前缀 →
  `meta.result_id`（精确 + ≥8 位前缀）。顺带修 `Math.max(200, max_chars)` 静默覆盖
  （<200 的显式 `max_chars` 被抬到 200）与非整数参数不取整。回归测试
  `test/test-result-protocol.mjs`：合成真实协议形状的 `.ff.json` 产物，断言取回非空
  content 与正确 parser/confidence（30 项断言，失败非零退出）。
- **JS-H1b 产物信任边界（H1 的必然推论）**：修好键漂移后 `ff_result` 开始真的吐正文，
  但 `.json` 是上传白名单扩展名 —— 伪造的 `anything.ff.json` 会被当作真实转换结果端给
  模型。现取回前先校验 round-1 成功信封（`ok:true` + string `content` +
  `meta.result_id`），不满足者以 `not_a_conversion_result` 拒绝，**绝不把原始文件字节
  当结果返回**；list 模式给这类文件打 `valid:false` 并在渲染里标「⚠非转换产物」。
  同时修 list 的 2KB 头部解析：协议里 `meta` 排在 `content` **之后**，>2KB 的真实产物
  原本一律显示 `parser=?`/`confidence=null`；现在小产物整段解析、大产物只读首 64B + 尾
  4KB（不把整份正文读进内存），result_id 查找也走同一读取器（大产物按 id 取回原先必失败）。
- **JS-H2 stdin EPIPE 崩溃向量**：`child.stdin.write/end` 没有任何 `'error'` 监听，而
  Python 子进程完全可能在消费 stdin 前就退出（坏 repoRoot → ModuleNotFoundError、
  argparse 报错、任何早退）→ stdin 流 emit `'error'`(EOF/EPIPE)。这不是 promise
  rejection（宿主的 `unhandledRejection` 兜底不管用），也没有 `uncaughtException`
  兜底 → **直接打死活着的 harness 进程**。现写入前给 child 三条 stdio 流都挂上
  no-throw 的 `'error'` 监听并 try/catch 包住 write/end；同族的两处裸 spawn 也补齐
  监听（`runVersion` 的探测子进程、`killTree` 的 taskkill）。回归测试
  `test/test-python-runner-stdin.mjs`：正常路径仍成功 + 早退子进程 + 4MB stdin
  必须被 EOF/EPIPE 打中且 runFormatForge 仍 resolve、零未捕获异常。
  （未加监听时同一场景实测抛出 `uncaughtException: EOF` —— 已用未加固副本验证。）
- **JS-H3 `too_large` 无限重转/重通知**：`processOne` 的 `too_large` 早退分支是唯一
  漏记 `doneAt` 的终态 → 超限文件每隔一个 tick 重写 `.ff.error.txt` 并**再次**向所有
  活会话发通知，永无止境（实测 11s 内 2 次且持续增长）。现在该分支也
  `doneAt.set(name, statSync(full).mtimeMs)`，语义与成功/失败路径一致：只有源文件
  size/mtime 变化才会重新处理。（行为回归覆盖随 JS-H8 的 `test-inbox.mjs` 重写落地。）
- **JS-H4 同 stem 产物互相覆盖**：产物键从 `<stem>.ff.*` 改为 **`<源文件名含扩展名>.ff.*`**
  （`foo.pdf` → `foo.pdf.ff.json`）。此前扁平收件箱里 `foo.pdf` 与 `foo.docx` 都写
  `foo.ff.json`/`foo.ff.md`，后到的转换覆盖先到的产物、并顺手 unlink 掉对方的
  `.ff.error.txt`；重启后预检还会把被覆盖的源标记成已完成（Python round-1 H4/H5 的 JS
  镜像）。键映射 name → name+'.ff.*' 是单射，与 Python 侧同为「结构性唯一键」；另加
  去重护栏：仅当同目录存在大小写不敏感同名的**另一个**源文件时才补源名短哈希后缀。
  scanStable / processOne / 启动预检统一走 `artifactPaths()`，三者不再各自拼名。
  **向后兼容**：旧式 `<stem>.ff.json` 仍是「产物」（不再当源），`ff_result` 的 id 查找
  保留 stem/前缀匹配，旧产物照常可读；升级后仅旧产物对应的源会按新键重转一次（顺带
  把覆盖年代留下的产物补齐），属一次性成本。（E2E 覆盖随 JS-H8 落地。）
- **JS-H5 通知器净化**：通知是以 `role:'user'`、`source:{kind:'user'}` 注入**每一个活
  会话**的消息，而文件名/错误文本来自不可信输入（任何能写收件箱的进程、上传路径）。
  此前只做了 `[\\/:*?"<>|]` 替换，**CR/LF 与控制字符原样通过** —— 名为
  `weird\nname.pptx` 的文件能把一行元数据变成一段伪造的多行用户指令。现在文件名 /
  kind / message / parser / resultId 全部经 `sanitizeText()`（剥 C0/C1、折叠空白、
  限长），整条通知 1000 字符硬上限，注入点 `broadcast` 另加只放行 `\n` 的兜底；
  顺带按审计建议把绝对路径的**家目录前缀（含用户名）打码为 `~`**，避免用户名与无关
  项目路径进入会话记录/LLM provider。回归测试 `test/test-notify-sanitize.mjs`
  （对抗性文件名 + 注入点兜底 + 正文不外泄不变量，14 项断言）。
- **JS-H6 上传路由 Origin 校验（DNS rebinding）**：`/formatforge/upload` 只服务环回，
  但**完全没有 Origin 检查**——经典 CSRF 只是碰巧被一个规范非法的 ACAO 值
  （`'same-origin'`，任何浏览器都不接受）挡住，而 DNS rebinding 能让攻击者域名发出的
  POST 被浏览器当作同源请求打进来。现在：`Origin` 存在且不是本机
  （`localhost`/`127.0.0.1`/`[::1]`，任意端口，http/https）→ 403 `forbidden_origin`
  且不落盘；`Origin: null` 同样拒绝；**缺 Origin 的非浏览器客户端照常放行**（它们无法被
  网页 drive-by 驱动）。preflight 改为回显校验通过的 Origin（修掉规范非法值）。
  同批修掉上传口两个同族问题：**M11** 产物形状的文件名（`x.ff.json` / `x.FF.MD`，
  大小写不敏感）在上传口直接 415 `artifact_name_rejected`——伪造产物不再能绕过转换
  躺进收件箱（`.json` 作为**源文档**仍照常接受）；`basename()` 遇 NUL 抛
  `ERR_INVALID_ARG_VALUE`、CR/LF 一路进文件名的问题改为先剥控制字符；
  `existsSync`→`writeFileSync` 的 TOCTOU 改为 `flag:'wx'` 原子创建 + EEXIST 追加序号。
  回归测试 `test/test-upload-origin.mjs`（18 项断言，含环回/外部/伪造/lookalike
  Origin、产物名拒收、NUL 文件名、同名不覆盖）。
- **JS-H7 子进程环境白名单 + stderr 摘要（审计 M1）**：Python 子进程此前继承
  `{...process.env}` —— 整台机器的 provider key / session token / 无关项目路径都进了
  转换器进程。现在只放行它真正需要的：解释器与 DLL 加载（PATH/SYSTEMROOT/WINDIR/
  COMSPEC/PATHEXT）、临时文件（TEMP/TMP，OCR 与 pdf 解析器用 tempfile）、家目录
  （USERPROFILE/HOME，`output_guard` 的 expanduser）、Tesseract 探测（LOCALAPPDATA）、
  locale/时区，加上 FormatForge 自己的旋钮 `FF_*`（FF_MAX_BYTES / FF_TIMEOUT_S /
  FF_OUTPUT_ROOT / FF_CACHE_* …）与 `PYTHON*` 参数；`PYTHONPATH` 仍钉在 repoRoot。
  同时 stderr 不再把尾部 200 字符塞进 `error.message`（那份文本会被渲染进**模型读到的**
  工具结果）：`summarizeStderr()` 只保留「异常类 + 最后一行」，剥离控制字符并限长。
  回归测试 `test/test-runner-env-stderr.mjs`（25 项断言：假密钥不泄漏、旋钮透传、
  traceback 中段内容（含写在中间帧里的假 token）不进摘要）；另实测最小环境下真实
  转换仍成功（txt → markdown，content/meta.result_id 正常）。
- **JS-H8 `test-inbox.mjs` 变成真正的测试**：此前它硬编码作者的机器路径
  （`E:/项目/DSH-FormatForge`）、**从不调用 `ff_result`**、且所有检查都只是
  `console.log` 一个布尔值——头条的 JS-H1 协议键漂移正是这样漏掉的（看起来全绿，
  断言全无）。现在：路径从仓库布局推导（`join(here,'..','..')`）、**真实调用
  `ff_result` 取回正文并比对 `.ff.md` 产物 / parser / confidence / file_size**、
  每条检查都是断言且失败非零退出（39 项）。同批补上此前零覆盖的分支：
  JS-H3 `too_large` 跨 5 个 tick 只通知一次、JS-H4 同 stem 不同扩展名各自保留产物与
  正文、CLI 失败 → `.ff.error.txt`（`timeoutMs=50` 强制超时命中 timeout 分支）、
  重启不重放、retention → `.ff.retired.log`。fixture 用临时 `FF_HOME` 隔离，
  退出时清理（含 M19：只清理自己创建的 stub `node_modules`）。

### H18 Option C（用户决策实施）：收缩 advertised-but-broken 格式宣称

- `.doc/.ppt/.xlsb` 从宣称中移除（python-docx/python-pptx/openpyxl 均不支持，
  且 pyproject 未声明对应依赖）；这三个扩展名现在走友好的 `unsupported_format`
  错误（exit 3），不再是「openpyxl 不支持此格式」式误导。
- **OLE2 误路由修复**：`docx_parser` / `pptx_parser` / `xlsx_parser` /
  `email_parser` 全部移除 OLE2 魔数宣称——该魔数无法区分 .doc/.ppt/.xls/.msg，
  注册顺序曾把无扩展名/收缩格式误路由到 DOCXParser。真正的 .xls/.msg 仍由
  扩展名匹配服务（.xls 有 xlrd 代码路径；.msg 依赖已声明的 extract-msg）。
- `ParseStep` 对收缩格式的「不支持的文件类型」失败不再吞掉后走 raw 透传假装
  成功——改为上抛（`.tmp` stream 输入的自有后缀保持原跳过行为）。
- HTTP 上传白名单同步移除 `.doc`。
- 回归测试：`test_h18_advertised_formats.py`（收缩 + 无解析器 + unsupported
  kind 端到端），`test_pptx_parser.py` 断言更新。
- `.xls/.xlsb/.msg` 的真实解析器作为 extras 后续项（xlrd/pyxlsb 未声明）。

### 1.0.3 — Atria 审计「Medium」批次修复（进行中；不发布）

> 与 1.0.2 相同约定：一个 commit 一项修复（`fix(FF-M<n>)`），每个修复自带回归测试；
> stdout 仍是唯一 JSON 出口。

- **FF-M-pages 选项误转发**：`pages`/`encoding` 曾被 `**pdf_options` 盲传给 22 个
  解析器中不声明对应形参的 18 个 → `TypeError` → 被 ParseStep 吞掉后退化为 raw
  透传垃圾。现按 `inspect.signature` 过滤，只转发解析器真正接受的选项，被丢弃的
  选项记 INFO 日志（`core/file_parser.py`）。
- **FF-M-riff 容器误判**：`b"RIFF"` 曾无条件判为 WEBP（且以 0.95 置信度**早于**
  扩展名分支返回）→ 无扩展名乃至 `.wav` 的 WAV/AVI 被当图片喂给图片解析器。
  现按偏移 8..12 的 form type 分派（`WEBP`→webp、`WAVE`→audio/wav、
  `AVI `→binary video）；未知子类型只以 0.6 置信度宣称 RIFF 容器，让扩展名分支
  仍能生效（`core/format_detector.py`）。
- **FF-M-txt 中文静默乱码**：编码判定顺序改为 BOM → chardet → **全量严格校验**
  回退链（utf-8 → utf-8-sig → gb18030）→ latin-1 兜底。旧实现只在**前 1024 字节**
  上验证 utf-8（合法前缀 + 非法尾部 → 误判 utf-8 静默乱码），不识别 BOM，回退链
  只有 utf-8 → gbk。另外：chardet 对 ISO-8859-*/Windows-125* 这类「永不失败」的
  单字节猜测不再直接采信（ASCII+GBK 混合文件曾被猜成 ISO-8859-9）；解码改为
  `errors="replace"` 让损坏字节以 U+FFFD 可见；兜底/未验证编码在
  `PageContent.metadata` 标记 `encoding_verified=False` / `lossy_decode=True`
  并记 warning，不再假装解码成功（`parsers/txt_parser.py`）。
- **FF-M-quality 覆盖率不再是空头数字**：`text_coverage` 曾只看
  `len(content)/file_size`，失败后的 raw 字节透传与二进制乱码同样满足阈值、
  与真实文本一起拿 100 分。现以「内容像文本的证据强度」（可打印字符比例，
  U+FFFD/控制字符不计入；字母/数字/CJK 占比 <5% 的符号堆再折 30%）作乘子，
  并把证据指标写进 warning（`core/quality_report.py`）。
- **FF-M-docx 静默丢正文**：解析循环只认 body 直接子节点的 `w:p`/`w:tbl`，
  `w:sdt`（内容控件）里的段落/表格被整段丢弃；`Paragraph.text` 只拼接直接
  `w:r`，`w:ins` 追踪插入与 `w:hyperlink` 文字从正文消失（只活在 revisions
  元数据里）；单个畸形元素抛异常会废掉整篇文档。现按块遍历并递归进入
  `w:sdtContent`，按 `w:t` 收集段落文本（插入文本**合并**展示并在
  `metadata.tracked_insert` 标记；`w:delText` 天然排除），逐元素隔离并把跳过的
  元素记进 `metadata.skipped_elements`（`parsers/docx_parser.py`）。
- **FF-M-table 单元格撕开表格几何**：单元格里的 `|` 会伪造列边界、换行会伪造行
  边界，下游 Markdown 渲染器会把单元格内容当成表格结构（内容欺骗）。新增
  `core.table_semantics.escape_md_cell`（换行→`<br>`，未转义的 `|`→`\|`），
  并接入 `render_markdown_table` 与 docx/xlsx/pptx/odf/pdf 的单元格拼接路径。
- **FF-M-diff 四处口径失真**：① `--context` 的 clamp 写成
  `max(i1, i1 - context)`（恒等于 `i1`）→ 任何取值都吐出全部未变更内容；
  且 `int(args.context or 3)` 会把合法的 `--context 0` 静默换成 3。现只保留变更
  前后各 `context` 行，中段以 `... 省略 N 行未变更内容 ...` 标记并在
  `elided_count` 报数；② `--since-mtime` 只过滤 `path_b`（注释却声称两侧都过滤），
  且 `nan`/`inf` 会「解析成功」但比较恒 False → 过滤器被静默禁用；现两侧都过滤
  （`skipped_side` 指明哪侧过旧），非有限数字报 `bad_request`；
  ③ `--against-dir` 同 stem 多候选时取 glob 顺序的 `candidates[0]`（旧版本随
  文件系统顺序漂移）→ 改为按 mtime 新→旧、同 mtime 按路径名确定性择新；
  ④ `--format json` 先 `json.loads` 再 `json.dumps(indent=2)` → 行数描述的是
  「美化后的形态」而非源内容，现直接按 translate 产出的内容切行
  （`formatforge/diff.py`）。
- **FF-M-protocol `--help` 污染 stdout**：argparse 的 `--help` 把 usage
  `print` 到 stdout 后 `SystemExit(0)` → JS 侧 python-runner 首行 JSON parse
  直接失败。现把 stdout 临时接管：usage 走 stderr（人类通道），stdout 只发一条
  `{"ok":true,"code":200,"data":{"help":...}}`（`formatforge/__main__.py`）。
- **FF-M-protocol `--output-file` 无沙箱 + 失败被吞**：旧实现
  `mkdir(parents=True)` 后写任意路径（H11 同类的无沙箱写原语），且写入失败只
  `logger.warning` 仍返回 `ok:true`。现写入目标收敛到用户声明的根
  （`FF_OUTPUT_ROOT`（多个用 `os.pathsep` 分隔）→ 未声明时 CWD，另加源文件
  所在目录），越界报 `bad_request`（exit 7）且不产生目录副作用，写入失败报
  `permission_denied`（exit 2）；新增 `formatforge/output_guard.py`。
  > ⚠️ 行为变更：不再默认允许任意路径写盘；需要写到声明根之外时请设置
  > `FF_OUTPUT_ROOT`。`batch --out` 的同类无沙箱写仍 open（刻意不在本批次扩大
  > 改动面，见 secondary 汇总文档的 deferral 列表）。
- **FF-M-pdf 加密 PDF 报错 + 临时 PNG 泄漏**：① 加密 PDF 此前没有密码路径，被
  笼统包成 `ValueError`（措辞无稳定标记）→ 被 `ParseStep` 吞掉 → `ConvertStep`
  把原始 PDF 字节当 `content` 返回（error-as-success）。现按异常链（含
  pdfplumber 的 `PdfminerException(e)` 包装层）识别加密/密码失败，抛含
  `password-protected` 稳定标记的明确错误，`ParseStep` 对该标记上抛，入口报
  `parse_failed`（exit 4）；`is_extractable=False` 的「可打开但禁止提取」同样
  显式报错（`parsers/pdf_parser.py`、`core/pipeline_steps.py`）。
  ② `_ocr_page` 的临时 PNG（`delete=False`）此前只在成功路径 unlink → 任何 OCR
  异常都留下泄漏文件，现统一在 `finally` 清理；顺带修正该失败路径的
  `from ocr_engine import OcrResult`（本仓库只有 `core.ocr_engine`，原写法让
  OCR 兜底直接 `ModuleNotFoundError`）。
- **FF-M-kinds 错误 kind/退出码分类**：`file_not_found` / `bad_request` /
  `permission_denied` / `timeout` 曾不在 `_LEGACY_KIND` 内 → 上游按新值语义传来的
  kind 全被 remap 成 `internal`(exit 70)，调用方无法区分「文件不存在」「参数错」
  与内部崩溃。现 `_fail` 先按 `ErrorCode` 枚举值精确解析（不变量有回归测试），
  再退到历史别名表；argparse 的用法错误改报 `bad_request`(exit 7)；
  `SystemExit("字符串")` 不再因 `int()` 抛 `ValueError` 变成无协议 JSON 的
  traceback（补一条 `bad_request` JSON）；入口 docstring 的退出码表与
  `core/errors.py` 对齐（`formatforge/__main__.py`）。既有测试
  `test_cli_protocol.py::TestArgparseJsonOutput::test_unknown_subcommand_returns_json`
  曾断言 `kind == "internal"`——即把审计认定的缺陷固化成期望，已更新为
  `bad_request` + `rc == 7`。
- **FF-M-logging stdout 污染**：`setup_logging` 的 `StreamHandler` 曾绑
  `sys.stdout`（当前零调用方，但一旦被调用就会破坏「stdout 只有一条协议 JSON」
  契约），改为 `sys.stderr`（`core/logging_config.py`）。
- **FF-M-email 附件物化 + 正文字符集**：① 附件此前只为算一个字节数就
  `len(part.get_payload(decode=True) or b"")`，把任意大小附件完整解码进内存；
  现 base64 按编码长度换算（零解码、含 padding 与折行处理），其他 CTE 超过
  `ATTACHMENT_SIZE_CAP_BYTES`(8 MiB) 只报下限并以 `size_exact=False` 标记，
  摘要显示为 `NNNKB+`；损坏 CTE 不再让整封邮件失败。② 正文解码把
  `get_content_charset()` 直接交给 `bytes.decode` → 未知字符集抛 `LookupError`
  被 ParseStep 吞掉后退化成 raw 透传假成功；现统一走 `_decode_body`（未知字符集
  记 INFO 并回退 utf-8），multipart 与非 multipart 四处调用点全部收口
  （`parsers/email_parser.py`）。MSG 路径仍依赖未安装的 `extract-msg`（dead
  path，见汇总文档遗留项）。
- **FF-M-misc `test_format_capabilities` 陈旧断言**：该测试把 ff_formats 的允许
  格式硬编码成一份手抄快照，注册表新增 `7z`/`rar`/`rtf`（三者都是 `DataFormat`
  成员且各有真实 parser）后必然失败——**是测试过期，不是实现回归**（H18 的
  `.doc/.ppt/.xlsb` 收缩已正确反映：三者都不在 advertised 集合内）。现改为按权威
  来源断言意图：advertised ⊆ `DataFormat` 值、不含扩展名别名、每个 format 都有
  parser 声明，并显式锁住 H18 收缩决策（`test/unit/test_format_capabilities.py`）。

## [1.0.2] - 2026-09-17 — Atria 跨模型审计修复（Worth-fixing-now 12 项；不发布，等用户决定）

> 一个 commit 对应一项修复（commit 备注 `fix(H<id>)`）；协议 todo：stdout 仍是唯一的 JSON 出口。

### 修复（高危，audit「Worth fixing now」全 12 项）

1. **H1 失败可检测**：`translate_file_data` / `cmd_translate_main` 显式识别
   `structuredData={"error": True}` 错误响应页（此前 `result is None` 是死代码），
   分别路由 parse_failed / bad_request；batch 不再把错误文本当产物写入产物文件并虚报 `ok_count`。
   解析失败被吞掉后的 raw 字节透传 confidence 1.0 → 0.3（`raw_passthrough` 标记）。
2. **H7 缓存反序列化（安全）**：`content_cache.py` 的两条 pickle 读取路径（含 import 时全局扫描）
   删除；JSON-only + v2 版本门控（未知格式忽略/失效并删除，绝不反序列化）；默认目录跟进
   `settings.CACHE_PERSIST_PATH`（不再 CWD 相对 `./cache`）。
3. **H2 smart_truncate 硬切分支**：`nxt = window_end`（不再 double-count start）——分页长文
   1000→400 字符丢内容 + 假 EOF 已修；JS `_truncate.mjs` 加镜像注释（JS 侧本就正确）。
4. **H4/H5 batch 健壮性**：conv_type 逐文件解析；产物 `write_text` 移入 per-file try（OSError → `write_failed` 行，
   不再因为产物写不进去；`FF_MAX_BYTES` batch 路径补齐校验；`as_completed(timeout=)` 超时记录行不再永久 wedged；
   递归批处理产物镜像子目录，避免 stem 冲突。
5. **H3 HTML 产物转义**：`format_output` HTML 分支先 `html.escape` 再包 `<div>`（存储型 XSS 产物路径合上；unEscaper/markdown 直通的活体标签不再落盘可执行）。
6. **H12 diff 顺序**：双文件按文档顺序 `diff <path_a> <path_b>` 解析；additions/deletions 不再 report 反；ff_diff 工具按文档顺序传参。
7. **H13/H16 页选择统一**：pdf_parser 并入 `parse_pages_spec`（同规则 + 同 `"pages 参数格式错误"` marker，ParseStep 卡死分类一致上抛）；拒绝 0/递减范围；按真实页数校验；保留请求顺序。
8. **H6 EPUB 路径**：opf_dir + href 无条件 normpath join（标准 OEBPS/content.opf + Text/ch*.xhtml 布局此前整本书空白）；NCX 同修；`<script>/<style>` skip 只被配对结束标签解除。
9. **H9/H8 音频**：`_parse_wav` seek(0)+逐 chunk 读取（此前 fmt/data 永远找不到，所有 WAV 元数据错）；M4A moov 读取 CAPPED 8MB（16 字节 M4A 声称 0xFFFFFF00 不再 ~4GiB 分配）；损坏 FLAC/微型 MP3 边界。
10. **H10 markdown 防死循环**：无分支消费的块级 pattern 行（如 `[ref]: http://x (Title)`）按普通段落消费，i 前进（此前永久 wedge）。
11. **H15 ODF 整数炸弹**：`text:c` / `number-columns-repeated` / `outline-level` 钳制 + 非数字容错；
    per-element try/except（单畸形 attribute 不再中止整份文档）。
12. **H17 OCR 可用性诚实**：is_available 校验 tesseract 二进制本体（pytesseract 导入成功不足以声称可用；
    静默空文本@0.0 现象消除）。

### 测试

- 全部 12 项修复各带针对性回归测试（同 commit）；全套 pytest 589+ 用例与新基线对齐（pre-existing 25 个 subconsole 环境用例不变）。

### 不在本轮范围（仍 open）

H18（.doc/.xlsb/.xls/.ppt/MSG 广告支持）是产品决策（装库 vs 收缩宣称），见 summary 提案；Secondary/medium findings
（resume mtime 信任、--output-file 无沙箱、加密 PDF、temp PNG 泄漏、kind remapping、--help 协议、H21 cache-key 不对称等）仍 open。

## [1.0.1] - 2026-08-31 — Hotfix（description + argparse JSON 化）

> 基线：v1.0.0（567 测试）→ v1.0.1（569 测试，+2）

### 修复

1. **description 修正**：v1.0.0 npm 包 description 字段仍含 'v0.14.0'（被遗漏）
   - 文件：`packages/dsh-formatforge/package.json`
   - 修法：description 字符串 v0.14.0 → v1.0.0
2. **argparse 错误 JSON 化**（v0.14.1 候选 #1）
   - 文件：`formatforge/__main__.py`
   - 修法：`main()` 临时 `sys.stderr = _SilentStream()` 让 argparse usage 静默，
     `SystemExit` 时走 `_fail("internal", ...)` 输出协议 JSON 到 stdout
   - 之前 argparse 错误走 stderr + exit 2，破坏 stdout 唯一出口约定
3. **测试 `test_category_invalid` 修正**：旧断言依赖 argparse stderr 文本输出

### 新增测试

- `test/unit/test_cli_protocol.py::TestArgparseJsonOutput`（2 测试）

## [1.0.0] - 2026-08-31 — 首个 production-ready stable

> 基线：v0.14.0-rc.1（538 测试）→ v1.0.0（567 测试，+29）
> 主题：**v1.0 production-ready 里程碑**——v0.14.0 stable 代码 + 协议冻结 + 5 项 audit 修复。

### 升级指南

- npm 上 v0.14.0 缺 audit 修复（4 bug + 1 性能）——已在 npm 上 deprecate，提示升级 v1.0.0
- GitHub Release v0.14.0 加注 "升级到 v1.0.0"
- v1.0.0 是首个 production-ready stable，**v1.x 内 API 向后兼容**（不破坏性改动）

### v1.0.0 增量（5 项 audit 修复）

1. **Bug：translate.mjs 多文件分页用 inline 旧逻辑（v0.13.0 遗留）**
   - 文件：`packages/dsh-formatforge/tools/translate.mjs` line 152-160
   - 修法：改用 `_truncate.mjs::smartTruncate` 替代 inline 截断
2. **Bug：多文件分隔符 `---` 与 markdown 水平线冲突**
   - translate 多文件拼接改用 `<!-- ff-file-sep -->`（HTML 注释——markdown 不解析、对模型可读）
   - 之前 `--- 第 1 页 ---` 水平线被 smartTruncate 误识别为多文件分隔符，**实测 cap=40/70 时单文件内容被切断**
3. **Bug：`smartTruncate` JS / Python 算法不一致（6 case 不一致）**
   - 修法：sep_len 跟踪避免 nxt 算法漂移（Python 与 JS 完全对齐 13/13）
4. **Bug：`--against-dir` 触发 self-diff**
   - 文件：`formatforge/diff.py::cmd_diff_against_dir`
   - 修法：`candidates` 加 `if p != path_b and p.exists()` 排除自身
5. **性能优化：inbox-watcher retention sha256 全量读**
   - 文件：`packages/dsh-formatforge/services/inbox-watcher.mjs`
   - 修法：`openSync + readSync(64KB) + closeSync` 替代 `readFileSync().slice()`

### 测试

- 567 passed / 0 fail
- 跨语言 truncate 一致性：13/13
- ruff ✓ / format ✓ / mypy ✓

### 未修的 7 项（v0.14.1 / v1.0.1 hotfix 候选）

| # | 问题 | 严重度 | 处置 |
|---|---|---|---|
| 2 | argparse 错误未走 JSON 输出 | UX | v0.14.1 修 |
| 5 | retention 通知完全静默化 | UX | v0.14.1 改 Plan B |
| 6 | 跨进程 `.ff.retired.log` append race | 性能 | 极低风险 |
| 1 | 无扩展名文件 fallback `parser=unknown` | 已知边界 | v0.14.1 重构 |
| 7 | 同内容不同扩展名评分不同 | 已知行为 | 接受 |
| 8 | ocr_low_confidence 阈值严格边界 | 已知行为 | 接受 |
| 10 | capabilities `hasattr` 探针可能误报 | 已知 | 已文档化 |

## [0.14.0] - 2026-08-31 — 窗 B 全收口（v1.0 stable 前最后一站）

> 基线：v0.13.0（538 测试）→ v0.14.0 stable（566 测试，+28）
> 主题：完成 v0.14.0 计划全部 7 项（2 项 P0 + 5 项 P1）。v1.0 stable 直接复用此代码 + 窗 C 协议冻结。

### Added

- **B-P0-1 `ff_formats` 能力元数据**：每个 format 自带 `capabilities` 列表（自动扫描 parser 代码真实方法名）
- **B-P0-2 `ff_diff` 增量模式**：`--against-dir <dir>` + `--since-mtime <ts>`，共享 `_compute_diff`
- **B-P1-3 retention 通知降噪**：retention 清理只 log 不广播，避免惊扰 live session
- **B-P1-4 TTL 删除前 `.ff.retired.log`**：sha256(path) + ts + size 审计轨迹
- **B-P1-5 质量评分按 file_type 动态调权重**：纯文本 table_accuracy 归零；表格 table_accuracy 提高
- **B-P1-6 OCR enhance 漏判修复**：OCR 后纯图片 PDF，OCR confidence < 0.6 触发 `ocr_low_confidence`
- **B-P1-7 多文件 markdown `---` 分隔符保护**：截断优先级提升到最强边界，JS+Python 双端同步
- 跨语言一致性测试 `test-truncate-consistency.mjs` 11 case（保证 JS/Python smartTruncate byte-equal）

### Changed

- `cli/formatforge diff` 顺序变更 `path_b path_a`（argparse 限制）
- `_resolve_paths` 容错旧顺序
- `QualityReport.analyze` 现在记 `file_type` → `overall_score` 按 file_type 调权

### Removed

- **MediaIndexStrategy 从策略注册表移除**（v1.0/C 清理 dead code）：无人调用、auto_detect 不选它、CLI conversion_type 枚举不引用；class 保留供 v2.0 删

### Notes

- v0.14.0 RC（v0.14.0-rc.1）已发布但不进 npm latest——本 stable 才进 npm latest
- 协议冻结（v1.0/C）由 PR #9 完成
- npm 上 `latest: 0.14.0` 发布后，旧 0.13.0 仍可访问但不再推荐

### Tests
- 538 → **566 passed**（+28：B-P0-1 11 + B-P0-2 6 + B-P1-3/4 各 1 + B-P1-5 4 + B-P1-6 5 + B-P1-7 4）
- ruff ✓ / format ✓ / mypy ✓
- Node `test-local.mjs` / `test-inbox.mjs` / `test-manifest.mjs` / `test-truncate-consistency.mjs` 全过

## [0.14.0-rc.1] - 2026-08-31 — RC 候选（v1.0 前第二批 P0）

> 基线：v0.13.0（538 测试） → v0.14.0-rc.1（555 测试，+17）
> 主题：**会话模型发现能力 + diff 增量模式**。为 P1 五项做铺垫，本 RC 仅含 2 项 P0；完整 v0.14.0 等下个工作窗合并 P1 后再发 stable。

### Added
- **B-P0-1 `ff_formats` 能力元数据**：每个 format 自带 `capabilities` 列表（机器可读），让会话模型按能力选择 format：
  - `pdf` → `[furniture_strip, ocr, table, two_column]`
  - `pptx` → `[animation_order, speaker_notes, table]`
  - `epub` → `[chapter_split]`
  - `xlsx` → `[multi_sheet]`
  - `odt/ods/odp` → `[table]`
  - 数据来源：自动扫描 `parsers/*.py` 类真实方法名（`_extract_animations`/`_parse_ncx`/`_extract_table`/...），不依赖静态字典——自动反映 parser 代码真实能力
  - 新模块 `core/format_capabilities.py`
- **B-P0-2 `ff_diff` 增量模式**：
  - 新参数 `--against-dir <dir>`：与 dir 内同 stem 文件做 diff（path_a 可省，自动从 dir 找）
  - 新参数 `--since-mtime <ts>`：仅处理 path_b mtime >= 此 Unix timestamp 的文件
  - 抽出 `_compute_diff` 共享函数（单文件模式 + 增量模式都用）
- 新单测 `test/unit/test_format_capabilities.py` 11 项（probe 注册 + build_format_details + capability 检测）
- 新单测 `TestR14DiffIncremental` 6 项（against_dir stem 匹配 / 显式 path_a 优先 / 缺 stem 报错 / since-mtime 过滤 / 类型校验 / 0 等价不过滤）

### Changed
- **CLI 顺序变更**：`formatforge diff` 现在 `path_b path_a`（argparse 限制：optional+required positional+中间 option 会失败）
- `_resolve_paths` 容错：JS 端或测试传反顺序时自动检测并互换（path_a 是文件 path_b 不是 → 互换）
- CLI 注册注释解释 argparse 限制 + 共享 `_compute_diff` 抽出
- SKILL.md `ff_formats` 条目加 capabilities 字段说明

### Notes
- **本 RC 仅含 2 项 P0**，未含完整 v0.14.0 计划的所有 5 项 P1（retention 降噪 / TTL 预览 / 动态权重 / OCR 漏判 / markdown 分段优先）——下个工作窗继续
- npm 上**不发布 0.14.0-rc.1**（RC 标签会让 npm dist-tag 混乱）；只走 PR + GitHub Release，不打 npm。完整 v0.14.0 stable 才上 npm

### Tests
- 538 → **555 passed**（+17：B-P0-1 11 项 + B-P0-2 6 项）
- ruff ✓ · format ✓ · mypy ✓（49 source files 0 issues）
- Node `test-local.mjs` / `test-inbox.mjs` / `test-manifest.mjs` / `test-truncate-consistency.mjs` 全过

## [0.13.0] - 2026-08-31 — 封口批（v1.0 前 P0/P1 修复）

> 基线：v0.12.0（537 测试） → v0.13.0（538 测试）
> 主题：清理 v0.10-v0.12 累积的协议不一致 + 文档漂移，为 v1.0 协议冻结做准备

### Added
- **A1**：`packages/dsh-formatforge/tools/_truncate.mjs` 新模块——`renderTruncate(text, cap)` + `smartTruncate(text, maxChars, start)`，供 translate.mjs / result.mjs 共用
- **A3**：`formatforge batch` CLI + `ff_batch` 工具新增 `--quality` / `--encoding` / `--language` 三个 flag，与 `ff_translate` 对齐；批量锻造出的 markdown 现在带 enhance 提示与会话模型目标语 metadata
- **B3**：单测 `tests/test_pipeline_steps.py::TestBuildResultStep::test_builds_result_when_decision_noop`——覆盖 `conversion_needed=False` 路径走 `BuildResultStep` 不崩的回归保护
- **C1**：`renderTruncate` 抽出共用——render 层兜底截断走「段落 > 行 > 硬切」语义，避免切碎代码块/表格
- **D1**：`SKILL.md` frontmatter 补 `version: 0.13.0` + `updated: 2026-08-31`；底部版本号从 v0.9.0（4 个版本没改）→ v0.13.0；description 增 `ff_diff` 描述
- **G1**：`core/decision_engine.py::ConversionDecision` docstring 扩充——标明 `strategies` 字段是「候选策略列表」（按序考虑）而非「已执行的策略」，避免会话模型误解
- **跨语言一致性测试**：`packages/dsh-formatforge/test/test-truncate-consistency.mjs`——JS smartTruncate 与 Python `core/utils.py::smart_truncate` 在 9 组样例上 byte-equal 对比，未来任一侧改算法即漂移自动捕获

### Changed
- **A1**：translate.mjs 多文件分页字段从 `data.meta.next_offset` → `data.paging.next_offset`（与单文件路径统一）；render 分页提示也改读 `data.paging.next_offset`
- **A3**：`formatforge/__main__.py::cmd_translate_main` 返回签名从 `(content, meta)` → `(content, meta, enhance | None)`；quality/encoding/language/custom_prompt 参数透传到 Python CLI
- **B1**：`packages/dsh-formatforge/tools/diff.mjs` 在 `execute` 开头复用 `validateLocalFile` 对 `path_a`/`path_b` 做 size clamp（防 OOM 大文件）
- **B2**：`services/inbox-watcher.mjs` 与 `formatforge/batch.py` 的 `KNOWN_EXT` 同步移除 `.doc`（无 Python doc 解析器，移除假阳性）
- **C6**：`packages/dsh-formatforge/tools/result.mjs` 单文件查找删除 `names.find((n) => n.includes(rawId))` 兜底（id="abc" 误命中 xxxabcxxx.ff.json 的潜在 bug）；改为精确 `resultId` JSON 头匹配

### Fixed
- **测试健壮性**：`tests/unit/test_cli_protocol.py` 的 `TestR11XlsxSchema` / `TestR11DocxRevisions` / `TestR11PptxAnimations` 加 `pytest.importorskip`——venv 漂移（缺 openpyxl/docx/pptx）从「fail 成 ERROR」降级为「skip」

### Tests
- 537 → **538 passed**（+1：B3 回归测试）
- ruff ✓ · format ✓（54 files already formatted） · mypy ✓（48 files 0 issues）
- bandit：0 High（CI threshold `-ll` 允许 Medium/Low warning）
- Node `test-local.mjs` / `test-inbox.mjs` / `test-manifest.mjs` / `test-truncate-consistency.mjs`（新增）全过
- `scripts/dev.py --quick` 全套通过

## [0.12.0] - 2026-08-28 — 第三波战略工具（ff_diff 文件对比）

### Added
- **B10 `ff_diff` 工具**（`tools/diff.mjs` + CLI `diff` 子命令 `formatforge/diff.py`）：
  - 逐行 LCS diff（difflib.SequenceMatcher），输出 unified diff 格式
  - 参数：path_a（旧版）、path_b（新版）、format（中间格式）、context_lines、max_chars
  - 返回：additions / deletions / unchanged_count / similarity / diff_preview
  - 任意格式可对比（先走 translate 转 text，PDF/DOCX 也能 diff）
  - 文件不存在 → file_not_found；转换失败 → parse_failed
- SKILL.md 工具清单加 `ff_diff`
- 测试：TestR12Diff 4 项（简单版本 / 相同文件 / 缺文件 / PDF 自比）

### Changed
- `formatforge/__main__.py`：注册 diff 子命令
- `packages/dsh-formatforge/index.mjs`：注册 ff_diff（5 工具：ff_translate/ff_formats/ff_result/ff_batch/ff_diff）
- `test-local.mjs` 工具数断言 4→5

### Fixed
- `_read_text_lines` 处理 translate_file_data 返回 dict（协议 data 字段）而非字符串

### Tests
- 537/537 passed（533 → 537，+4）· ruff ✓ · format ✓ · mypy 48 文件 0 错

## [0.11.0] - 2026-08-28 — 第二波场景深耕（CSV/XLSX schema + DOCX 修订 + EPUB 章节 + PPTX 动画）

### Added
- **B1 CSV/XLSX/SQL schema 推断 + 前 N 行预览**（`core/conversion_strategies.py`）：
  - 类型判定：integer / float / date / boolean / string
  - 整数/浮点合并判定（混小数点整列 → float）
  - `structured_data.schema` 顶层汇总 + 每表 `tables[i].schema` + `preview_rows`（前 5 行）
  - CLI `--type type` 输出 `meta.schema` / `data.structured_data.schema`
- **B5 DOCX 修订追踪**（`parsers/docx_parser.py`）：w:ins / w:del 抽出到 `PageContent.metadata.revisions`，
  含 author/date/text。python-docx 默认忽略 w:ins/w:del 文本，B5 显式 iter 这两个 tag。
- **B8 EPUB 章节拆分 + NCX 标题**（`parsers/epub_parser.py`）：
  - `_parse_ncx` 解析 NCX toc.ncx → navPoint.title
  - 通过 manifest 反查把 spine itemref idref 映射回 NCX 章节标题
  - element metadata.chapter_title 填充章节名
- **B6 PPTX 动画顺序**（`parsers/pptx_parser.py`）：
  - `_extract_animations` 扫 p:timing/p:par 节点
  - 返回 [{index, shape_id, shape_name, effect_type, delay_ms}, ...] 按播放顺序
  - 讲者备注（notes_slide）早已支持，B6 加补动画（观望池 PPTX 深度达标）

### Changed
- `formatforge/__main__.py` cmd_translate：把 `result.structuredData` 透传到 `data.structured_data`（B1 CLI 暴露）
- `core/conversion_strategies.py` TableExtractionStrategy：`tables[].data` 不再含 header（挪到 `headers` 字段）

### Fixed
- parser 在 EPUB 缺 NCX 时不报错（_parse_ncx 异常被吞 + log.debug）

### Tests
- 533/533 passed（509 → 533，+24 增量：B1 CSV/XLSX 3 项、B5 DOCX 2 项、B8 EPUB 2 项、B6 PPTX 2 项 + 测试 fixture）
- ruff ✓ · format ✓ · mypy 47 文件 0 错

## [0.10.0] - 2026-08-28 — 第一波新功能（ff_batch / language / output-file / formats 过滤）

### Added
- **B3 ff_batch 工具**（`tools/batch.mjs`）：批量锻造，包装 Python CLI `batch` 子命令
  - 参数：source（目录/glob）、out、format、type、workers（1-8）、recursive、force、pages
  - 输出：每文件结果 + 汇总报告 `_batch_report.json`（总/成功/失败/跳过/平均置信度/总耗时）
  - 续跑：产物比源新 → 跳过；空目录 → 仍写报告（exit=1 提示无匹配）
- **B9 `--language` 目标语言 metadata**：ISO 639-1 代码（如 `zh` / `en` / `ja` / `zh-cn`）
  - CLI：写入 `meta.target_language` + `enhance.hint`（提示会话模型按此语种整理）
  - 工具：ff_translate 直接透传
- **A9 `--output-file` 路径**：content 另存到指定文件，stdout 协议 JSON 不变（meta.output_file 字段标记）
- **A10 `formats --category` 过滤**：6 类（document/data/email/image/archive/audio）
  - 输出加 `categories` 列表供会话模型发现可用分类
- `scripts/dev.py`：一键开发脚本（pytest+ruff+format+mypy+烟雾测）
- 8 个 CLI 协议护栏（TestR10LanguageFlag / TestR10OutputFile / TestR10FormatsCategory / TestR10Batch）

### Changed
- `formatforge/__main__.py` cmd_translate：`data` 类型推断加固（cast dict[str, Any] + type:ignore）
- `formatforge/batch.py` 空源返回 exit=1（旧契约）但仍写报告（契约级 _batch_report.json 必存在）

### Fixed
- mypy 在 cmd_translate 多个 dict[str, Any] union 操作时报类型冲突（已 cast 化解）

## [0.9.1] - 2026-08-28 — R3 协作面护栏补丁

### Added
- SKILL.md 同步 R3 用法：ff_result 三工具说明、`--encoding` 参数、retry_with 重调对照表、
  R3.1 auto 智能默认提示、R3.2 ids 批量取回、R3.4 schema -33.3% 标注
- CLI 协议护栏 `TestR3SmartDefault`：auto 模式自动开启 quality（无需 --quality）+ meta.quality_auto 契约字段
- CLI 协议护栏 `TestR3EncodingRetry`：`--encoding gbk` 透传解码 + retry_with 闭环
- CLI 协议护栏 `TestR3MarkdownStructureField`：meta.structured 字段守住
- test-inbox.mjs R3.2 断言：onDone payload.resultId 必须以 `cvt` 开头

### Changed
- `formatforge/__main__.py` cmd_translate 入口：R3.1 智能默认（auto 模式自动 want_quality=True）+
  meta.quality_auto 标记字段（让会话模型知道 quality 是自动开启的）
- `packages/dsh-formatforge/test-inbox.mjs` 关掉 TTL（`FF_INBOX_TTL_DAYS=999`）—— fixture mtime
  古老会被 retention 误判过期；测试只验 R3.2 行为不测 retention

### Fixed
- v0.9.0 时 SKILL.md 描述仅列两工具（缺 ff_result）；R3.2 ids 数组用法无文档

## [0.9.0] - 2026-08-28 — R3 协作面

### Added
- R3.1 ff_translate 智能默认：`--type auto` 自动附带 `--quality`（低置信自动产出 actions），render 加 200 字头部预览
- R3.2 ff_result 批量取回：新增 `ids` 数组参数一次多产物 + 通知附 `resultId`（inbox 消息末尾 `- 结果 id：xxx`）
- R3.3 自愈闭环实测：CLI `--encoding` 透传（gbk/latin-1）+ ConvertStep 优先 conversion_needed 兜底 + raw 文本透传以让 quality 扫 FFFD/mojibake
- R3.4 工具描述瘦身：schema 体积 2951 → 1969 chars（削减 33.3%，目标 ≥30%）
- `scripts/measure_r3_selfheal.py` — 自愈闭环实测脚本（3 劣化样本集）
- `test/fixtures/golden/r3_selfheal.json` — R3.3 验收快照（self-heal 3/3 = 100%）

### Changed
- 协议：`ff_result` 批量响应 `data.batch=true / count / ok_count / results[]`
- 通知：FormatForge inbox watcher 携带 `resultId` 给 result.mjs 直接取回
- `core/pipeline_steps.ConvertStep.process()` 重构：优先级 decision→parsed→data→fallback
- `parsers/txt_parser.TXTParser.parse()` 支持 `encoding` 覆写（自愈重试路径）
- `formatforge/__main__.py`：新增 `--encoding` 参数透传 + CLI `quality` 默认在 auto 模式自动开启
- 测试：test_ocr_engine 三处跟随新默认引擎；test_pipeline_steps 增加 raw 透传覆盖

## [0.8.0] - 2026-08-27 — R2 解析质量纵深

### Added
- **R2.1 OCR 管线贯通**：修复「use_ocr 参数透传但引擎从未挂载」的主干断线（PDFParser 注册时 ocr_engine 恒为 None）；新增 RapidOCR (ONNX Runtime) 后端（Windows CPU 首选、真实逐行置信度、兼容新旧两代 API），默认引擎优先级 rapidocr > paddleocr > tesseract > easyocr；修复 pdfplumber 调色板 PNG（mode=P）导致 RapidOCR 返回空的问题（自动转 RGB 重试）；OCR 文字层合并去重（相似行不重复）
- **R2.2 表格语义**：新模块 core/table_semantics.py——None=合并覆盖（继承宿主值）vs ''=真空单元格的语义区分；数值列自动右对齐（markdown `---:`）；跨页表格续接合并（无表头续表整表并入 / 重复表头自动跳过）；原始 grid 随 metadata 携带
- **R2.3 结构保真**：新模块 core/structure_fidelity.py——字号/加粗 → h1-h4 标题层级（全书正文字号中位数基准）；行首 x0 几何聚类 → 列表嵌套层级（最多 4 级）；目录行识别 → `[标题](#锚点)`；markdown 输出时自动按层级渲染，OCR 行永不误判标题
- golden fixture 机制：test/fixtures/golden/ 确定性语料（5 份 PDF：扫描件/水印混排/跨页表格/合并单元格/结构层级）+ 期望快照 + FF_UPDATE_GOLDEN=1 显式刷新；测量脚本 scripts/measure_r2_baseline.py 持续跟踪 enhance 触发率
- 新增 16 项 R2 测试（OCR 4 + 结构 7 + 表格 4 + 触发率 2），总测试 488 → 509

### Changed
- OCR 引擎默认从「恒 tesseract」改为按可用性优先级自动选择；test_ocr_engine 初始化用例跟随新语义
- enhance 触发率（golden 语料）：OCR 接线前 20%（扫描件 image_only）→ 接线后 0%；误判水印文档为 image_only 的问题已修复

> 验收对比 ROADMAP §2：image_only/table_sparse enhance 触发率下降 ≥30% 达成（样本集 20% → 0%）。

## [0.7.1] - 2026-08-27 — 上榜落地（R1 快赢）

### Added
- storefront 截图：assets/ 三张 dsh web 实拍（拖拽 toast / 收件箱产物 / 会话通知），按新约定在 `packages/dsh-formatforge/screenshots.json` 声明，README 嵌图
- GitHub issue 模板：bug report（强制附 verify-install.py 输出栏）+ feature request

### Changed
- 版本号统一：单一来源 `formatforge/__version__.py`（0.7.1），pyproject 动态读取，CLI `version` 命令同步（清除 3.0.0 历史漂移）；npm 包 0.7.0 → 0.7.1
- `scripts/rebuild-plugin-junctions.py`：候选源加入 npx cache 自动发现（宿主重装清缓存后可自愈）
- `scripts/take-screenshots.py`：修复 WS 握手空 query 尾巴（500 拒握手）与 8 字节掩码两处 bug；CDP 改用 Chrome For Testing daemon(:9222)——Edge 新配 profile 会强装扩展+首启弹窗，不可用

> 注：v0.3–v0.7 的插件化演进未记入本文件（见 EVOLUTION_PLAN.md / git log），自本版恢复维护。

## [2.1.0] - 2026-07-13 — DFT 1.5 安全硬化

### Added
- `__version__.py` 单一版本号来源
- `core/auth.py` API_KEY 认证模块（HMAC 时序安全比对）
- `core/security.py` 加固：NUL/UNC/NTFS 流/8.3 短文件名拦截
- `core/security.py` SSRF 用 `ipaddress` 模块替换字符串前缀比对
- `core/content_cache.py` JSON 序列化磁盘缓存（取代 pickle）
- `pyproject.toml` optional-dependencies groups: `[ocr]` / `[archive]` / `[richtext]` / `[all]`
- README「安全」章节 + 详细认证说明

### Changed
- 版本号统一为 `2.1.0`（`pyproject.toml` / `main.py` / `api/v2.py` / `__version__.py`）
- `ALLOWED_ORIGINS` 默认值改为 `["http://localhost:3000"]`；`["*"]` 自动 `allow_credentials=False`
- `validate_mime_type(None)` 改为 False
- 错误响应在生产模式不泄漏堆栈
- 11 个写接口加 `Depends(verify_api_key)`

### Fixed
- `build-backend` 错误值 `setuptools.backends._legacy:_Backend` → `setuptools.build_meta`
- `core/input_adapters.py` `List` 导入缺失
- PDF mock 路径：新增 `_PdfplumberStub` 模块级占位符

### Security
- SSRF 防护：拦截 `127.1` / `2130706433` / `0x7f000001` / `[::1]` / `file:///etc/passwd`
- CORS：`allow_origins=["*"]` + `allow_credentials=True` 同时存在 → 自动改为 `False`
- 路径遍历：NUL 字节、UNC 路径、NTFS 备用数据流、8.3 短文件名
- 磁盘缓存 `pickle.load` → `json.loads`，消除反序列化任意代码漏洞

### Tests
- 全量 pytest：**`635 passed, 5 skipped, 0 failed`**（v1.4: 17 failed / 618 passed）
- `TestPDFParserMock` 7 个 mock 测试从全失败恢复
- 新增 prod 模式回归测试（API_KEY 启用场景）

## [1.4.0] - 2026-06-13

详见 README §更新日志

## [1.3.0] - 2026-06-13

详见 README §更新日志

## [1.2.0] - 2026-06-12

详见 README §更新日志

## [1.1.0] - 2026-06-12

详见 README §更新日志

[Unreleased]: https://github.com/Tianbuyu/data-format-translator/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/Tianbuyu/data-format-translator/releases/tag/v2.1.0