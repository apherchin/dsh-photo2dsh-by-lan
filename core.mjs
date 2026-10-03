/**
 * 纯逻辑层：**不做任何 I/O**，因此可以离线测。
 *
 * 这里放的每一条规则都来自真机实测，注释里标了原因——不要因为"看起来多余"而删掉。
 */

/** 单张照片的体积上限（字节）。iPhone/iPad 原图 PNG 实测可到 12.4 MB，留足余量。 */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** 配置文档字节上限：超过就按默认值工作，绝不解析一个巨型文件。 */
export const MAX_DOCUMENT_BYTES = 256 * 1024;

/** 配置文档 schema 版本。 */
export const SCHEMA = 1;

/** token 长度（十六进制字符数 ⇒ 128 bit 需要 32 个字符）。 */
export const TOKEN_BYTES = 16;

export const EXT_OF = { jpeg: ".jpg", png: ".png", gif: ".gif", webp: ".webp", bmp: ".bmp" };

const FORMAT_CN = { jpeg: "JPEG", png: "PNG", gif: "GIF", webp: "WebP", bmp: "BMP", unknown: "未知格式" };

/** 人类可读的体积。响应体与通知都用它，因为用户看的是 iPad 上的中文短句。 */
export function humanSize(bytes) {
	if (!Number.isFinite(bytes) || bytes < 0) return "?";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 格式的中文标签。 */
export function formatLabel(kind) {
	if (FORMAT_CN[kind]) return FORMAT_CN[kind];
	if (kind.startsWith("heif")) return "HEIC/HEIF";
	if (kind.startsWith("MULTIPART")) return "畸形的 multipart 信封";
	return kind;
}

/**
 * 由**魔术字节**判定真实格式。
 *
 * ⚠️ 绝不能用 `Content-Type` 头或文件扩展名代替：真机实测快捷指令送来时头声明
 * `image/jpeg`，而实际字节是 PNG。信头就会把 PNG 命名成 .jpg，后面所有工具链都踩坑。
 */
export function sniff(buf) {
	if (!buf || buf.length < 12) return "unknown";
	const h = buf.subarray(0, 12).toString("hex");
	if (h.startsWith("ffd8ff")) return "jpeg";
	if (h.startsWith("89504e470d0a1a0a")) return "png";
	if (buf.subarray(4, 8).toString() === "ftyp") {
		const brand = buf.subarray(8, 12).toString();
		if (/heic|heix|hevc|hevx|mif1|msf1/.test(brand)) return `heif(${brand})`;
		return `isobmff(${brand})`;
	}
	if (h.startsWith("47494638")) return "gif";
	if (h.startsWith("52494646") && buf.subarray(8, 12).toString() === "WEBP") return "webp";
	if (buf.subarray(0, 2).toString() === "BM") return "bmp";
	if (buf.subarray(0, 2).toString() === "--") return "MULTIPART-ENVELOPE(未解析)";
	return "unknown";
}

/** 嗅探结果对应的落盘扩展名；未知格式时为 undefined（由调用方决定回退）。 */
export function extensionFor(kind) {
	return EXT_OF[kind];
}

/**
 * 文件名的安全化：只留 `[\w.\-]`，去掉任何目录成分。
 * 这是防路径穿越的第一道且是唯一一道闸——不要依赖调用方已经清过。
 */
export function safeName(raw) {
	const base = String(raw ?? "upload").split(/[\\/]/).pop() ?? "upload";
	const cleaned = base.replace(/[^\w.\-]+/g, "_");
	const trimmed = cleaned.slice(-80) || "upload";
	return trimmed.startsWith(".") ? `x${trimmed}` : trimmed;
}

/**
 * 本地时区时间戳（`YYYYMMDDHHMMSS`）。
 * ⚠️ 不能用 `toISOString()`——那是 UTC，晚上 8 点后拍的照片会被记成前一天、目录也会落错日期。
 */
export function localStamp(d = new Date()) {
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 本地时区的人类可读时间。 */
export function localReadable(d = new Date()) {
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 本地时区的日期目录名 `YYYY-MM-DD`。 */
export function localDateDir(d = new Date()) {
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 落盘文件名：`<本地时间戳>-<sha256 前 8>-<清洗后的原名><嗅探所得扩展名>`。
 * 哈希前缀让"肉眼核对"成为可能；序列号由 `store.mjs` 在重名时追加。
 */
export function targetName(base, digest, kind, stamp = localStamp()) {
	const ext = extensionFor(kind) ?? ".bin";
	const cleaned = safeName(base);
	const stem = (cleaned.replace(/\.[^.]*$/, "") || "photo").slice(0, 40);
	return `${stamp}-${String(digest).slice(0, 8)}-${stem}${ext}`;
}

/**
 * 判定来源是否为本机/私网地址（IPv4 私网 + 回环 + IPv6 回环/链路本地/唯一本地）。
 *
 * ⚠️ **它挡不住"网页跳板"**：恶意网页通过**你自己的浏览器**发请求时，服务端看到的
 * `remote` 是 `127.0.0.1`——完全符合"私网"。那一路必须靠 `isLoopbackOrigin` 的
 * `Origin` 检查来挡。两者是**互补**的，缺一不可。
 */
export function isPrivate(remote) {
	const ip = String(remote ?? "").replace(/^::ffff:/, "");
	if (ip === "127.0.0.1" || ip === "::1" || ip.startsWith("127.")) return true;
	if (/^fe80:/i.test(ip)) return true;            // IPv6 链路本地
	if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true; // IPv6 唯一本地 fc00::/7
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
	if (!m) return false;
	const a = Number(m[1]);
	const b = Number(m[2]);
	if (a === 10) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 169 && b === 254) return true;
	return false;
}

/**
 * 是否来自**本机回环**。
 * ⚠️ 与 `isPrivate` 不是一回事：`isPrivate` 把整个 192.168/10/172.16 网段都算进来，
 * 而设置页含 token，**只能对回环开放**——用 `isPrivate` 会把 token 发给全局域网。
 */
export function isLoopback(remote) {
	const ip = String(remote ?? "").replace(/^::ffff:/, "");
	return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("127.");
}

/**
 * 某个 `Origin` 头值是否来自本机回环。
 *
 * **这是防"网页跳板"的关键**：浏览器发起的跨源请求一定会带 `Origin`，
 * 而 iOS 快捷指令这类**原生客户端根本不带**。所以：
 *   - 不带 `Origin` ⇒ 放行（快捷指令走这条）
 *   - 带 `Origin` 且指向回环（PC 上设置页的上传表单）⇒ 放行
 *   - 带 `Origin` 且指向别处 ⇒ **一律拒绝**
 *
 * 有了它，"关掉 token"的风险才会从"互联网上的人也能灌你磁盘"降到
 * "只有同一局域网内的设备"。**无论 token 开不开都应该做这道检查。**
 */
export function isLoopbackOrigin(origin) {
	if (typeof origin !== "string" || origin.trim() === "") return false;
	try {
		const host = new URL(origin.trim()).hostname.replace(/^\[|\]$/g, "");
		return isLoopback(host) || host === "localhost";
	} catch {
		return false;
	}
}

/** 手机端要填的上传地址。 */
export function buildUploadUrl({ ip, port, token }) {
	return `http://${ip}:${port}/u/${token}`;
}

/** 端口合法性。 */
export function validPort(value) {
	const n = Number(value);
	return Number.isSafeInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
}

/** 配置文档的默认值。`dir` 由调用方注入（需要 DSH_HOME 或工作区路径，属于 I/O 层的事）。 */
export function defaultDocument(dir) {
	return {
		schema: SCHEMA,
		dir,
		port: 8787,
		host: "0.0.0.0",
		lanIp: "",
		token: "",
		maxBytes: DEFAULT_MAX_BYTES,
		notify: true,
		requireToken: true,
		// 只接受局域网来源。**默认开**：它是"关掉 token 之后唯一的来源闸门"。
		lanOnly: true,
	};
}

/**
 * 归一化一份候选配置。
 *
 * **绝不抛**：任何坏字段都退成兜底值并把原因收进 `problems`，
 * 这样一份手改坏的配置文件不会让整个插件起不来。
 * @returns `{ doc, problems }`
 */
export function normalizeDocument(raw, fallback) {
	const problems = [];
	const base = { ...fallback };
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { doc: base, problems: ["配置文档不是对象，已按默认值工作"] };
	}

	if (typeof raw.dir === "string" && raw.dir.trim() !== "") base.dir = raw.dir.trim();
	else if (raw.dir !== undefined) problems.push("dir 不是非空字符串，已忽略");

	const port = validPort(raw.port);
	if (port !== undefined) base.port = port;
	else if (raw.port !== undefined) problems.push(`port 不合法（${JSON.stringify(raw.port)}），已忽略`);

	if (typeof raw.host === "string" && raw.host.trim() !== "") base.host = raw.host.trim();
	else if (raw.host !== undefined) problems.push("host 不是非空字符串，已忽略");

	// 空字符串 = 自动枚举（合法）
	if (typeof raw.lanIp === "string") base.lanIp = raw.lanIp.trim();
	else if (raw.lanIp !== undefined) problems.push("lanIp 不是字符串，已忽略");

	if (typeof raw.token === "string" && raw.token.length >= 16) base.token = raw.token;
	else if (raw.token !== undefined && raw.token !== "") problems.push("token 太短（<16 字符），已忽略");

	const max = Number(raw.maxBytes);
	if (Number.isSafeInteger(max) && max >= 1024 && max <= 2 * 1024 * 1024 * 1024) base.maxBytes = max;
	else if (raw.maxBytes !== undefined) problems.push("maxBytes 超出合理范围，已忽略");

	if (typeof raw.notify === "boolean") base.notify = raw.notify;
	else if (raw.notify !== undefined) problems.push("notify 不是布尔值，已忽略");

	if (typeof raw.requireToken === "boolean") base.requireToken = raw.requireToken;
	else if (raw.requireToken !== undefined) problems.push("requireToken 不是布尔值，已忽略");

	if (typeof raw.lanOnly === "boolean") base.lanOnly = raw.lanOnly;
	else if (raw.lanOnly !== undefined) problems.push("lanOnly 不是布尔值，已忽略");

	return { doc: base, problems };
}

/**
 * 解析配置文档文本。**绝不抛**：坏 JSON 退成 `fallback` 并把原因写进 `problems`。
 * @returns `{ doc, problems }`
 */
export function parseDocumentText(text, fallback) {
	if (typeof text !== "string" || text.trim() === "") {
		return { doc: { ...fallback }, problems: [] };
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { doc: { ...fallback }, problems: [`配置文档不是合法 JSON（${error.message}），已按默认值工作`] };
	}
	return normalizeDocument(parsed, fallback);
}

/** 序列化配置文档（缩进 2 空格 + 末尾换行，便于用户手改与 diff）。 */
export function serializeDocument(doc) {
	return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * 把 `dir` 与候选子路径拼起来，并断言结果仍在 `dir` 之内。
 *
 * 防路径穿越的**最后一道**断言：即使前面的清洗被绕过，越界也会在这里被抓住。
 * @returns 绝对化的目标路径；越界时返回 `undefined`。
 */
export function joinWithin(dir, name) {
	if (typeof dir !== "string" || dir === "" || typeof name !== "string") return undefined;
	const sep = dir.includes("\\") ? "\\" : "/";
	const trimmedDir = dir.replace(/[\\/]+$/, "");
	if (name.includes("/") || name.includes("\\") || name === "." || name === "..") return undefined;
	if (name.startsWith(".")) return undefined;
	return `${trimmedDir}${sep}${name}`;
}

/** 可接受的图片格式（按魔术字节判定后的结果）。HEIC 必须收——真机实测快捷指令原样透传。 */
export function isPhotoKind(kind) {
	return /^(jpeg|png|gif|webp|bmp)$/.test(kind) || kind.startsWith("heif");
}

/** 从 multipart 的 Content-Type 里取 boundary。 */
export function boundaryOf(ctype) {
	const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(ctype ?? ""));
	if (!m) return undefined;
	return (m[1] ?? m[2]).trim();
}

/**
 * 极简 multipart 解析。
 * 只在"兜底路径"上使用（安卓 / curl / 浏览器表单）；iPhone 主路径是 raw body。
 */
export function parseMultipart(buf, boundary) {
	const delim = Buffer.from(`--${boundary}`);
	const out = [];
	let idx = buf.indexOf(delim);
	if (idx < 0) return out;
	idx += delim.length;
	while (idx < buf.length) {
		if (buf.subarray(idx, idx + 2).toString() === "--") break;
		if (buf.subarray(idx, idx + 2).toString() === "\r\n") idx += 2;
		const headerEnd = buf.indexOf("\r\n\r\n", idx);
		if (headerEnd < 0) break;
		const headerText = buf.subarray(idx, headerEnd).toString("utf8");
		const bodyStart = headerEnd + 4;
		const next = buf.indexOf(delim, bodyStart);
		if (next < 0) break;
		let bodyEnd = next;
		if (buf.subarray(bodyEnd - 2, bodyEnd).toString() === "\r\n") bodyEnd -= 2;
		out.push({ headerText, body: buf.subarray(bodyStart, bodyEnd) });
		idx = next + delim.length;
	}
	return out;
}

/** 从 multipart 各段里挑出"最像文件"的那一段（优先带 filename 的、其次最大的）。 */
export function pickFilePart(parts) {
	const named = parts.filter((p) => /filename=/i.test(p.headerText));
	const pool = named.length ? named : parts;
	let best = null;
	for (const p of pool) if (!best || p.body.length > best.body.length) best = p;
	return best;
}

/** 从 multipart 段的头里取文件名。 */
export function nameOfPart(part) {
	const m = /filename\*?=(?:"([^"]*)"|([^;\r\n]+))/i.exec(part?.headerText ?? "");
	if (!m) return "upload";
	const raw = (m[1] ?? m[2]).trim();
	try {
		return safeName(decodeURIComponent(raw));
	} catch {
		return safeName(raw);
	}
}

/** 从请求行目标里取 `?name=`。 */
export function nameOfTarget(target) {
	const m = /[?&]name=([^&\s]+)/.exec(String(target ?? ""));
	if (!m) return "upload";
	try {
		return safeName(decodeURIComponent(m[1]));
	} catch {
		return safeName(m[1]);
	}
}

/** 从请求行目标里取 `?note=`（快捷指令可以让用户带一句备注）。 */
export function noteOfTarget(target) {
	const m = /[?&]note=([^&\s]+)/.exec(String(target ?? ""));
	if (!m) return "";
	try {
		return decodeURIComponent(m[1]).slice(0, 500);
	} catch {
		return m[1].slice(0, 500);
	}
}

/** `?as=json` → 机器可读响应（测试台与脚本用）。 */
export function wantsJson(target) {
	return /(?:[?&])as=json(?:&|$)/i.test(String(target ?? ""));
}

/**
 * 虚拟/隧道网卡的识别特征。
 *
 * ⚠️ 为什么必须有这个：本机实测有**三个**私网 IPv4 —— `172.28.80.1`（Hyper-V）、
 * `192.168.200.1`（Hyper-V vSwitch）、`192.168.5.22`（真网卡）。如果只按"192.168 优先 +
 * 字典序"挑，会挑中 `192.168.200.1`（`"192.168.2…" < "192.168.5…"`），**手机永远连不上**。
 * 所以先按"是不是虚拟网卡"分层，再比数值（不是字典序）。
 */
const VIRTUAL_ADAPTER = /hyper-v|vmware|virtualbox|vethernet|wsl|docker|loopback|tap[- ]|bluetooth|tailscale|zerotier|npcap|openvpn|radmin|hamachi|wi-?fi direct|wireless ?direct|virtual|vpn|隧道|虚拟/i;

/** 私网网段优先级：家用/办公最常见的排前面。 */
function ipRank(ip) {
	if (ip.startsWith("192.168.")) return 0;
	if (ip.startsWith("10.")) return 1;
	return 2;
}

/** 把点分十进制转成整数，用于**数值**比较（字典序会选错，见 VIRTUAL_ADAPTER 的注释）。 */
function ipValue(ip) {
	return ip.split(".").reduce((acc, part) => acc * 256 + (Number(part) || 0), 0);
}

/**
 * 枚举所有可用的局域网 IPv4，按"最可能是手机该连的那个"排序。
 *
 * 这同时服务于两件事：① 自动挑选；② **把候选全列给用户看**，让他在自动挑错时能手选。
 * @returns `Array<{ address, adapter, virtual }>`
 */
export function listLanAddresses(interfaces) {
	const out = [];
	for (const [adapter, list] of Object.entries(interfaces ?? {})) {
		for (const entry of list ?? []) {
			if (entry?.family !== "IPv4" || entry.internal) continue;
			if (!isPrivate(entry.address)) continue;
			out.push({ address: entry.address, adapter, virtual: VIRTUAL_ADAPTER.test(adapter) });
		}
	}
	return out.sort((a, b) => {
		if (a.virtual !== b.virtual) return a.virtual ? 1 : -1;
		if (ipRank(a.address) !== ipRank(b.address)) return ipRank(a.address) - ipRank(b.address);
		return ipValue(a.address) - ipValue(b.address);
	});
}

/** 自动挑一个最可能对的局域网 IPv4；挑不出来返回 undefined。 */
export function pickLanAddress(interfaces) {
	return listLanAddresses(interfaces)[0]?.address;
}
