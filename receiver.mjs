/**
 * 宽容的原始 TCP 接收端。
 *
 * 为什么不用 `node:http`（这是被真机故障逼出来的设计决定，别退回去）：
 *   iPad 快捷指令发出的请求头**并不严格**。用内置 http 服务器时实测报
 *   `HPE_INVALID_HEADER_TOKEN` → 服务器判定请求非法 → 整条连接被判死 → 快捷指令等到超时。
 *   但**照片字节其实完整地在流里**，只要按 `Content-Length` 取就完好无损。
 *   ⇒ **宽容必须在服务端**：不能要求用户把手机配置调到完美。
 *
 * 宽容的边界（安全上不放宽）：
 *   - token 校验照旧（由上层 `handle` 决定）
 *   - 体积上限照旧
 *   - 落盘前仍按魔术字节判型（见 `core.mjs`）
 *
 * 真机实测覆盖过的形态（都有回归用例）：
 *   ① 请求行里混入换行（URL 被断成两行）  ② 头里含无冒号的垃圾行
 *   ③ 客户端等 `Expect: 100-continue` 才发体  ④ `Transfer-Encoding: chunked`
 *   ⑤ 完全没有 `Content-Length`（退化成魔术字节扫描 + 空闲判定）
 */
import { createServer } from "node:net";

/** 空闲多久没新数据就认为"发完了"（仅在拿不到 Content-Length 时使用）。 */
const IDLE_MS = 2500;
/** 头部字节上限，防止有人用无限头把内存撑爆。 */
const HEAD_LIMIT = 64 * 1024;

const REASON = {
	200: "OK",
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	405: "Method Not Allowed",
	413: "Payload Too Large",
	415: "Unsupported Media Type",
	431: "Request Header Fields Too Large",
	500: "Internal Server Error",
};

/** 构造响应字节。必须带原因短语——`HTTP/1.1 200` 这种缺 `OK` 的响应行严格客户端可能不认。 */
export function buildResponse(status, ctype, body) {
	const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""), "utf8");
	const reason = REASON[status] ?? "OK";
	const head = `HTTP/1.1 ${status} ${reason}\r\n`
		+ `Content-Type: ${ctype}\r\n`
		+ `Content-Length: ${payload.length}\r\n`
		+ "Connection: close\r\n"
		+ "Cache-Control: no-store\r\n\r\n";
	return Buffer.concat([Buffer.from(head, "latin1"), payload]);
}

/** 在任意位置找图片起始；用于放弃严格解析后的兜底抢救。 */
export function findMagic(buf) {
	const patterns = [
		Buffer.from([0xff, 0xd8, 0xff]),
		Buffer.from([0x89, 0x50, 0x4e, 0x47]),
		Buffer.from([0x47, 0x49, 0x46, 0x38]),
		Buffer.from("ftyp", "latin1"),
		Buffer.from("RIFF", "latin1"),
	];
	let best = -1;
	for (const p of patterns) {
		const i = buf.indexOf(p);
		if (i >= 0 && (best < 0 || i < best)) best = i;
	}
	return best;
}

/** chunked 传输编码的最小解码器；解不出来返回 null，交给兜底路径。 */
export function dechunk(buf) {
	const out = [];
	let i = 0;
	while (i < buf.length) {
		const nl = buf.indexOf("\r\n", i);
		if (nl < 0) return null;
		const size = parseInt(buf.subarray(i, nl).toString("latin1").trim().split(";")[0], 16);
		if (!Number.isFinite(size)) return null;
		i = nl + 2;
		if (size === 0) break;
		if (i + size > buf.length) return null;
		out.push(buf.subarray(i, i + size));
		i += size + 2;
	}
	return Buffer.concat(out);
}

/** 把字节渲染成"看得见控制字符"的形式，便于日志定位。 */
export function visibleDump(buf, max = 700) {
	const head = buf.subarray(0, 512);
	const repr = [...head].map((b) => {
		if (b === 13) return "<CR>";
		if (b === 10) return "<LF>\n";
		if (b === 9) return "<TAB>";
		if (b >= 32 && b <= 126) return String.fromCharCode(b);
		return `<${b.toString(16).padStart(2, "0")}>`;
	}).join("");
	return `len=${buf.length} REPR: ${repr.slice(0, max)}`;
}

/**
 * 从原始字节里解析出一个请求。
 *
 * @returns `{ ok: true, request }` 或 `{ ok: false, status, message }`
 *   `request` = `{ method, target, headerText, ctype, ua, body, framing }`
 */
export function parseRequest(buf, maxBytes) {
	const sep = buf.indexOf("\r\n\r\n");
	if (sep < 0) return { ok: false, status: 400, message: "没有找到头结束标记" };
	const headerText = buf.subarray(0, sep).toString("latin1");
	const firstLine = headerText.split("\r\n")[0];
	const method = (/^([A-Z]+)\s/.exec(firstLine)?.[1] ?? "?").toUpperCase();
	const target = (/^[A-Z]+\s+(\S*)/.exec(firstLine)?.[1] ?? "").trim();
	const ctype = (/content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1] ?? "").trim();
	const ua = (/user-agent:\s*([^\r\n]+)/i.exec(headerText)?.[1] ?? "").trim().slice(0, 200);
	// 锚到行首（m 标志），免得把 `X-Origin` 之类的自定义头也匹配进来
	const origin = (/^origin:\s*([^\r\n]*)/im.exec(headerText)?.[1] ?? "").trim().slice(0, 200);
	const clRaw = /content-length:\s*(\d+)/i.exec(headerText)?.[1];
	const teChunked = /transfer-encoding:\s*chunked/i.test(headerText);

	const bodyHead = buf.subarray(sep + 4);
	let body = null;
	let framing = "none";

	if (clRaw !== undefined) {
		const need = Number(clRaw);
		if (need > maxBytes) return { ok: false, status: 413, message: "体超过上限" };
		if (bodyHead.length < need) {
			return { ok: false, status: 400, message: `体不完整：期待 ${need}，实收 ${bodyHead.length}` };
		}
		body = bodyHead.subarray(0, need);
		framing = "content-length";
	} else if (teChunked) {
		const decoded = dechunk(bodyHead);
		if (decoded) {
			body = decoded;
			framing = "chunked";
		} else {
			return { ok: false, status: 400, message: "chunked 解码失败" };
		}
	} else if (method !== "GET" && method !== "HEAD") {
		const at = findMagic(bodyHead);
		if (at >= 0) {
			body = bodyHead.subarray(at);
			framing = "magic-scan";
		}
	}

	return { ok: true, request: { method, target, headerText, ctype, ua, origin, body, framing } };
}

/**
 * 起一个宽容接收端。
 *
 * @param options.host - 绑定地址，默认 `0.0.0.0`（仅局域网需要）。
 * @param options.port - 端口。
 * @param options.maxBytes - 请求体上限。
 * @param options.log - `(line: string) => void`，**不得抛**。
 * @param options.handle - `(request) => { status, ctype, body } | Promise<...>`；不得抛（内部已 try/catch）。
 */
export function createReceiver({ host = "0.0.0.0", port, maxBytes, log = () => {}, handle }) {
	const hardLimit = maxBytes + 1024 * 1024;
	let server = null;
	let bound = null;

	const server2 = createServer((socket) => {
		const remote = socket.remoteAddress ?? "-";
		const chunks = [];
		let total = 0;
		let head = Buffer.alloc(0);
		let headerEnd = -1;
		let expected = null;
		let sent100 = false;
		let settled = false;
		let idle = null;
		socket.on("error", () => {});

		const armIdle = () => {
			clearTimeout(idle);
			idle = setTimeout(() => {
				if (!settled) void finish(Buffer.concat(chunks));
			}, IDLE_MS);
		};

		const reply = (status, ctype, body) => {
			if (socket.writable) socket.end(buildResponse(status, ctype, body));
			else socket.destroy();
		};

		socket.on("data", (chunk) => {
			if (settled) return;
			chunks.push(chunk);
			total += chunk.length;
			if (total > hardLimit) {
				settled = true;
				clearTimeout(idle);
				log(`[recv] 413 超过上限（已收 ${total} B，上限 ${maxBytes} B）`);
				reply(413, "text/plain; charset=utf-8", `❌ 文件太大（上限 ${(maxBytes / 1024 / 1024).toFixed(0)} MB）\n`);
				return;
			}

			if (headerEnd < 0) {
				const joined = Buffer.concat(chunks);
				const end = joined.indexOf("\r\n\r\n");
				if (end >= 0) {
					headerEnd = end;
					head = joined.subarray(0, end);
					const headerText = head.toString("latin1");
					// 有客户端会带 Expect: 100-continue 并等服务器点头才发体；不回应就空等到超时
					if (!sent100 && /expect:\s*100-continue/i.test(headerText)) {
						sent100 = true;
						if (socket.writable) socket.write("HTTP/1.1 100 Continue\r\n\r\n");
					}
					const cl = /content-length:\s*(\d+)/i.exec(headerText);
					expected = cl ? Number(cl[1]) : null;

					// ⚠️ 无体的请求必须**立刻**回，不能等空闲超时：GET/HEAD 永远没有体，
					// `Content-Length: 0` 也没有。实测漏了这条，每个 `GET /ping` 要白等 2.5 秒。
					const methodNow = (/^([A-Z]+)\s/.exec(headerText.split("\r\n")[0])?.[1] ?? "").toUpperCase();
					if (methodNow === "GET" || methodNow === "HEAD" || expected === 0) {
						void finish(Buffer.concat(chunks));
						return;
					}
				} else if (joined.length > HEAD_LIMIT) {
					settled = true;
					clearTimeout(idle);
					log("[recv] 431 头部过长");
					reply(431, "text/plain; charset=utf-8", "header too long\n");
					return;
				}
			}

			// 体一收齐就立刻处理，不要等空闲超时（否则每次上传白等 2.5 秒）
			if (headerEnd >= 0 && expected !== null && total - (headerEnd + 4) >= expected) {
				void finish(Buffer.concat(chunks));
				return;
			}
			armIdle();
		});

		socket.on("end", () => {
			if (!settled) void finish(Buffer.concat(chunks));
		});
		socket.on("close", () => clearTimeout(idle));

		async function finish(buf) {
			if (settled) return;
			settled = true;
			clearTimeout(idle);
			try {
				const parsed = parseRequest(buf, maxBytes);
				if (!parsed.ok) {
					log(`[recv] ${parsed.status} ${parsed.message}｜${visibleDump(buf)}`);
					reply(parsed.status, "text/plain; charset=utf-8", `❌ 请求无法解析：${parsed.message}\n`);
					return;
				}
				const result = await handle({ ...parsed.request, remote, raw: buf });
				reply(result.status, result.ctype, result.body);
			} catch (error) {
				// 处理器绝不外抛：一律回 500，并把原因留在日志里
				log(`[recv] 500 处理器抛错：${error?.stack ?? error}`);
				reply(500, "text/plain; charset=utf-8", "❌ 服务器内部错误，请看 PC 日志\n");
			}
		}
	});

	server2.on("error", (error) => {
		log(`[recv] server error ${error?.code} ${error?.message}`);
	});

	return {
		/** 开始监听。**绝不抛**：失败只记日志并返回 `{ ok: false, error }`。 */
		start() {
			return new Promise((resolve) => {
				try {
					server2.once("error", (error) => resolve({ ok: false, error }));
					server2.listen(port, host, () => {
						server = server2;
						bound = server2.address();
						resolve({ ok: true, address: bound });
					});
				} catch (error) {
					resolve({ ok: false, error });
				}
			});
		},
		/** 停止监听。幂等、**绝不抛**。 */
		stop() {
			return new Promise((resolve) => {
				try {
					if (!server) return resolve();
					server.close(() => resolve());
					// 兜底：万一有挂着的连接让 close 不回调
					setTimeout(resolve, 500);
				} catch {
					resolve();
				}
			});
		},
		/** 当前实际绑定的地址（未启动时为 null）。 */
		address() {
			return bound;
		},
	};
}
