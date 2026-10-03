/**
 * dsh-photo2dsh-by-lan —— 宿主半边。
 *
 * 职责：把手机经局域网送来的照片落盘到**用户可配置的目录**，并对外提供配置读写路由
 * （面板里的配置卡片通过它读写）。**不做 UI**；UI 在 `client.js`。
 *
 * ⚠️ 两条铁律（本项目实测得来，违反会出真事故）：
 *   1. `apply` **绝不能抛错** —— 渲染端有"每条 client entry 都必须 active"的全有全无门禁，
 *      但宿主侧抛错同样会让插件变 failed。所有可能失败的动作都必须就地降级。
 *   2. **不要把 `connection` 放进硬门禁 `inject`** —— 收照片是主功能、配置卡片是附加；
 *      拿不到 `connection` 只该丢卡片，绝不该连带弄丢"收照片"本身。所以用嵌套注入。
 */
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

import {
	SCHEMA, TOKEN_BYTES,
	boundaryOf, buildUploadUrl, defaultDocument, formatLabel, humanSize, isLoopback, isLoopbackOrigin, isPhotoKind, isPrivate,
	nameOfPart, nameOfTarget, noteOfTarget, normalizeDocument, parseDocumentText, parseMultipart,
	pickFilePart, listLanAddresses, serializeDocument, sniff, wantsJson,
} from "./core.mjs";
import { createReceiver } from "./receiver.mjs";
import { createNotifier } from "./notify.mjs";
import { landPhoto } from "./store.mjs";

/** Cordis 插件名（日志前缀）。 */
export const name = "photo2dsh-by-lan";

/**
 * 硬门禁：**故意留空**。
 * 本插件的核心能力（bind 端口收照片）不依赖任何注入服务；
 * `connection`（配置路由）走嵌套注入，见 `registerConfigRoute`。
 */
export const inject = [];

/** 包名。补丁里那一行的 `name` 必须与它逐字相同，客户端半边才挂得上。 */
export const PACKAGE_NAME = "dsh-photo2dsh-by-lan";

/** 面板配置卡片的读写路由（同源 fetch；与其它 `/api/*` 共用鉴权闸门）。 */
export const CONFIG_PATH = "/api/photo2dsh-by-lan.config";

const NOTIFY_MAX_PER_MINUTE = 10;

//#region 路径与日志

/** DSH home。测试与本地验证可用 `DSH_HOME` 指到临时目录，**绝不碰真的** `~\.dsh`。 */
export function dshHome() {
	return process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? ".", ".dsh");
}

/** 配置文档路径。 */
export function configPath(home = dshHome()) {
	return join(home, "photo2dsh-by-lan.json");
}

/** 运行日志路径（排查用；`GET /health` 会带出尾部若干行）。 */
export function logPath(home = dshHome()) {
	return join(home, "photo2dsh-by-lan.log");
}

function makeLogger(ctx) {
	return (text) => {
		const line = `${new Date().toISOString()} ${text}`;
		try {
			ctx?.logger?.info?.(`photo2dsh-by-lan: ${text}`);
		} catch {
			// 宿主 logger 不可用也不能影响功能
		}
		appendFile(logPath(), `${line}\n`).catch(() => {});
	};
}

//#endregion

//#region 配置文档

/** 原子写配置文档：先写 `.tmp` 再 rename（绝不做原地截断）。 */
export async function writeDocument(path, doc) {
	const text = serializeDocument(doc);
	const temporary = `${path}.tmp`;
	await mkdir(dirname(path), { recursive: true }).catch(() => {});
	await writeFile(temporary, text, "utf8");
	await rename(temporary, path);
}

/** 读配置文档。**绝不抛**：读不到/写坏都退成默认值并把原因带出来。 */
export async function readDocument(path, fallback) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return { doc: { ...fallback }, problems: [] };
		return { doc: { ...fallback }, problems: [`配置文档不可读（${error?.code ?? error}），已按默认值工作`] };
	}
	if (text.length > 256 * 1024) {
		return { doc: { ...fallback }, problems: ["配置文档过大（>256KB），已按默认值工作"] };
	}
	return parseDocumentText(text, fallback);
}

/**
 * 解析出"最终生效"的配置。
 * 层级：内置默认值 ← 补丁行 config ← 用户配置文档（面板写入的那份最优先）。
 */
export async function resolveConfig(rowConfig = {}) {
	const defaultDir = join(dshHome(), "photo-inbox");
	const base = defaultDocument(defaultDir);

	// 补丁行的 config 只作为"部署级默认"，不覆盖用户文档
	const fromRow = normalizeDocument(rowConfig ?? {}, base);

	const user = await readDocument(configPath(), fromRow.doc);

	let doc = user.doc;
	const problems = [...fromRow.problems, ...user.problems];

	// token 不存在就生成一个并持久化 —— 这是"可迁移"的关键：装到任何机器上都自动有 token
	if (typeof doc.token !== "string" || doc.token.length < 16) {
		doc = { ...doc, token: randomBytes(TOKEN_BYTES).toString("hex"), schema: SCHEMA };
		try {
			await writeDocument(configPath(), doc);
		} catch (error) {
			problems.push(`token 无法持久化（${error?.message ?? error}），重启后会换新 token`);
		}
	}

	return { doc, problems };
}

//#endregion

//#region 响应体

const REASON_CN = {
	jpeg: "JPEG", png: "PNG", gif: "GIF", webp: "WebP", bmp: "BMP",
};

/** 落盘成功后给手机的**中文短句**（不是 JSON —— 用户在「快速查看」里要看得懂）。 */
export function uploadedText({ kind, bytes, file, when }) {
	const lines = [
		"✅ 照片已收到",
		"",
		`格式：${formatLabel(kind)}（${humanSize(bytes)}）`,
		`文件：${file}`,
		`时间：${when}`,
		"",
		"已存入 PC 的收件箱文件夹",
	];
	if (kind === "png") {
		lines.push("", "提示：这是 PNG，体积通常是 JPEG 的数倍。", "   若想变小，可在快捷指令里加「转换图像 → JPEG」。");
	} else if (kind.startsWith("heif")) {
		lines.push("", "提示：收到 HEIC。Windows 与部分工具读它需要额外解码器，", "   建议在快捷指令里加「转换图像 → JPEG」。");
	}
	lines.push("");
	return lines.join("\n");
}

/** 配置卡片与 `/health` 用的状态快照（**绝不含 token 明文以外的机密**；token 本就归用户所有）。 */
export function stateSnapshot(state) {
	const candidates = listLanAddresses(networkInterfaces());
	const auto = candidates[0]?.address;
	// 用户手填优先；空字符串 = 自动枚举
	const chosen = typeof state.doc.lanIp === "string" && state.doc.lanIp !== "" ? state.doc.lanIp : auto;
	return {
		ok: true,
		dir: state.doc.dir,
		port: state.doc.port,
		host: state.doc.host,
		lanIp: state.doc.lanIp,
		maxBytes: state.doc.maxBytes,
		notify: state.doc.notify,
		requireToken: state.doc.requireToken,
		lanOnly: state.doc.lanOnly,
		token: state.doc.token,
		uploadUrl: buildUploadUrl({ ip: chosen ?? "<这台PC的IP>", port: state.doc.port, token: state.doc.token }),
		lan: chosen ?? null,
		lanAuto: auto ?? null,
		lanCandidates: candidates,
		listening: state.bound !== null,
		boundPort: state.bound?.port ?? null,
		listenError: state.listenError ?? null,
		received: state.received,
		lastUpload: state.lastUpload,
		problems: state.problems,
		logPath: logPath(),
		configPath: configPath(),
		startedAt: state.startedAt,
	};
}

//#endregion

//#region 请求处理

function text(status, body) {
	return { status, ctype: "text/plain; charset=utf-8", body };
}
function html(status, body) {
	return { status, ctype: "text/html; charset=utf-8", body };
}
function json(status, value) {
	return { status, ctype: "application/json; charset=utf-8", body: `${JSON.stringify(value, null, 2)}\n` };
}

/** 设置页（**只对本机开放**；含 token，绝不能让局域网随便看）。 */
function setupPage(state) {
	const snap = stateSnapshot(state);
	return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Photo2DSH 设置</title>
<style>
 body{font:15px/1.7 -apple-system,system-ui,sans-serif;margin:0;padding:18px;background:#f5f5f7;color:#1d1d1f}
 h1{font-size:19px} h2{font-size:16px;margin:22px 0 8px}
 .card{background:#fff;border-radius:12px;padding:16px;margin:12px 0;box-shadow:0 1px 3px #0002}
 code,.url{font-family:ui-monospace,Menlo,monospace;font-size:14px;background:#f0f0f2;padding:10px;border-radius:8px;word-break:break-all;display:block;user-select:all}
 table{border-collapse:collapse;width:100%} td{padding:4px 8px;border-bottom:1px solid #eee;vertical-align:top}
 td:first-child{color:#6e6e73;width:9em}
 .ok{color:#34c759;font-weight:600} .bad{color:#ff3b30;font-weight:600}
 ol{padding-left:20px} li{margin:5px 0}
</style></head><body>
<h1>📷 Photo2DSH（局域网照片收件箱）</h1>
<div class="card">
 <h2>手机端要填的地址</h2>
 <span class="url">${snap.uploadUrl}</span>
 <div style="color:#6e6e73;font-size:13px;margin-top:8px">
   把这个地址填进 iPad/iPhone 快捷指令的「获取 URL 内容」；<b>微信/浏览器打开本页看不到它</b> —— 本页只对本机开放，正是为了不让 token 满局域网乱飞。
 </div>
</div>
<div class="card">
 <h2>当前状态</h2>
 <table>
  <tr><td>监听</td><td>${snap.listening ? `<span class="ok">正常</span> · ${snap.host}:${snap.boundPort ?? snap.port}` : `<span class="bad">未监听</span>${snap.listenError ? ` · ${snap.listenError}` : ""}`}</td></tr>
  <tr><td>落地目录</td><td><code>${snap.dir}</code></td></tr>
  <tr><td>已收照片</td><td>${snap.received} 张${snap.lastUpload ? ` · 最近：${snap.lastUpload.file}（${humanSize(snap.lastUpload.bytes)}）` : ""}</td></tr>
  <tr><td>体积上限</td><td>${humanSize(snap.maxBytes)}</td></tr>
  <tr><td>配置文档</td><td><code>${snap.configPath}</code></td></tr>
  <tr><td>日志</td><td><code>${snap.logPath}</code></td></tr>
 </table>
 ${snap.problems.length ? `<div style="color:#ff9500;margin-top:10px">⚠️ ${snap.problems.join("；")}</div>` : ""}
</div>
<div class="card">
 <h2>怎么改设置</h2>
 在 DSH 侧栏 <b>插件（Plugins）</b> → 本包页面里改，改完点保存即可。本页只读。
</div>
</body></html>`;
}

/**
 * 处理一条已解析好的请求。
 * **绝不抛**：任何异常都转成 500 中文短句，并把栈写进日志。
 */
async function handleRequest(state, request, log) {
	const { method, target, remote, body, ctype, ua, origin, framing } = request;
	const path = String(target ?? "").split("?")[0];

	/**
	 * ⭐ 防"网页跳板"：浏览器发起的**跨源**请求一定带 `Origin`，而 iOS 快捷指令这类
	 * 原生客户端**根本不带**。所以带 `Origin` 且不是回环的一律拒收。
	 *
	 * 这道检查**与 token 无关、永远生效**：它是"关掉 token 也还安全"的前提条件——
	 * 没有它，关掉 token 就等于让互联网上的网页也能往这台机器灌文件。
	 */
	if (typeof origin === "string" && origin !== "" && !isLoopbackOrigin(origin)) {
		log(`403 拒收跨源请求：origin=${JSON.stringify(origin)} remote=${remote} target=${JSON.stringify(target)}`);
		return text(403, "❌ 拒绝来自网页的跨源请求（只接受原生客户端或本机设置页）\n");
	}

	/**
	 * 第二道：**只收局域网来源**（用户明确要求"不用 token，靠锁局域网地址"）。
	 * 只对上传生效——`/ping` 与 `/health` 仍可从局域网访问，方便排查连通性。
	 *
	 * ⚠️ 注意它**不能替代**上面的 Origin 检查：网页跳板走的是本机浏览器，
	 * `remote` 会是 `127.0.0.1`，在"私网"定义里是合法的。
	 */
	if (method === "POST" && state.doc.lanOnly !== false && !isPrivate(remote)) {
		log(`403 拒收非局域网来源：remote=${remote} target=${JSON.stringify(target)}`);
		return text(403, "❌ 只接受来自局域网的请求\n");
	}

	if (method === "GET" || method === "HEAD") {
		if (path === "/ping") {
			return text(200, `pong from PC ${new Date().toISOString()}\n你的设备地址: ${remote}\n`);
		}
		if (path === "/health") {
			// ⚠️ 必须连 `uploadUrl` 一起去掉：它**本身含 token**，只剥 token 字段等于没剥
			const { token, uploadUrl, ...safe } = stateSnapshot(state);
			void token;
			void uploadUrl;
			return json(200, safe);
		}
		if (path === "/" || path === "/index.html") {
			// ⚠️ 设置页含 token ⇒ **只对本机回环**开放。
			// 注意不能用 isPrivate：那会把 192.168.x/10.x 全放进来，等于把 token 发给整个局域网。
			if (!isLoopback(remote)) return text(403, "本页只对本机开放。请在 PC 上打开。\n");
			return html(200, setupPage(state));
		}
		return text(404, "not found\n");
	}

	if (method !== "POST") return text(405, "method not allowed\n");

	// ── token ────────────────────────────────────────────────────
	const hasToken = state.doc.token !== "" && String(target).includes(state.doc.token);
	if (!hasToken) {
		if (state.doc.requireToken !== false) {
			log(`401 拒绝：target=${JSON.stringify(target)} remote=${remote}`);
			// ⚠️ 绝不回显正确 token：那等于把它送给任何打错地址的人
			return text(401, [
				"❌ 上传失败：地址里缺少正确的 token",
				"",
				"URL 需要形如：",
				`http://<这台PC的IP>:${state.doc.port}/u/<token>`,
				"",
				"（token 请在 PC 的「插件」面板 → 本包页面里复制）",
				"",
			].join("\n"));
		}
		log(`放行：未带 token（requireToken=false）remote=${remote}`);
	}

	if (!body || body.length === 0) {
		log(`400 没能从请求里取到体 remote=${remote}`);
		return text(400, "❌ 没能从请求里取到照片数据\n");
	}

	// ── multipart 兜底 ───────────────────────────────────────────
	let payload = body;
	let fileName = nameOfTarget(target);
	let mode = "raw";
	const boundary = boundaryOf(ctype);
	if (/multipart\/form-data/i.test(ctype) && boundary) {
		const part = pickFilePart(parseMultipart(body, boundary));
		if (!part || part.body.length === 0) {
			log("400 multipart 里没有文件字段");
			return text(400, "❌ 表单里没有找到照片字段\n");
		}
		payload = part.body;
		fileName = nameOfPart(part);
		mode = "multipart";
	}

	// ── 只认魔术字节（实测 Content-Type 会撒谎） ─────────────────
	const kind = sniff(payload);
	if (!isPhotoKind(kind)) {
		log(`415 拒收：kind=${kind} bytes=${payload.length} remote=${remote} ctype=${JSON.stringify(ctype)}`);
		return text(415, `❌ 这不是一张能识别的图片（判定：${formatLabel(kind)}）\n`);
	}

	// ── 落盘 ─────────────────────────────────────────────────────
	const landed = await landPhoto({
		rootDir: state.doc.dir,
		payload,
		name: fileName,
		kind,
		meta: { remote, ua, declaredContentType: ctype, framing: mode === "multipart" ? `${framing}+multipart` : framing, note: noteOfTarget(target) },
	});

	state.received += 1;
	state.lastUpload = {
		file: landed.sidecar.file,
		bytes: landed.bytes,
		kind,
		at: landed.sidecar.receivedAt,
		atLocal: landed.sidecar.receivedAtLocal,
		remote,
	};
	log(`200 落盘 ${landed.full} bytes=${landed.bytes} kind=${kind} mode=${mode} framing=${framing} sha256=${landed.sha256.slice(0, 16)}`);

	// ── 通知（失败不影响落盘） ────────────────────────────────────
	if (state.doc.notify !== false && state.notifier) {
		const now = Date.now();
		state.notifyTimes = (state.notifyTimes ?? []).filter((t) => now - t < 60000);
		if (state.notifyTimes.length < NOTIFY_MAX_PER_MINUTE) {
			state.notifyTimes.push(now);
			void state.notifier.show(
				"照片已收到",
				`${formatLabel(kind)} · ${humanSize(landed.bytes)} · ${landed.sidecar.file}`,
			);
		} else {
			log("通知被限流（一分钟内已弹 10 条）");
		}
	}

	if (wantsJson(target)) {
		return json(200, {
			ok: true, kind, bytes: landed.bytes, file: landed.sidecar.file,
			mode, framing, sha256: landed.sha256,
		});
	}
	return text(200, uploadedText({
		kind, bytes: landed.bytes, file: landed.sidecar.file, when: landed.sidecar.receivedAtLocal,
	}));
}

//#endregion

//#region 配置路由（面板卡片的数据通道）

/**
 * 注册配置读写路由。
 *
 * ⚠️ **必须用嵌套注入等 connection 服务，不能一次性 `ctx.get('connection')`**：
 * 本项目实测过同类事故（页面报 404，而插件显示"运行中"）——本行的硬门禁里没有
 * `connection` 时，`apply` 可能在它被提供**之前**就跑完，拿到 `undefined` ⇒ 路由永不注册。
 * 离线假 ctx 永远"服务就绪"，一条断言都抓不到，所以必须按官方形状写。
 */
function registerConfigRoute(ctx, state, log, restart) {
	try {
		ctx.inject(["connection"], (scoped) => {
			try {
				const connection = Reflect.get(scoped, "connection") ?? scoped.get?.("connection");
				if (connection === undefined) throw new Error("connection 服务不可用");
				scoped.effect(
					() => connection.fetch.register({
						path: CONFIG_PATH,
						methods: ["GET", "POST"],
						requestBody: "buffered",
						fetch: async (request) => {
							try {
								if (request.method === "GET") return Response.json(stateSnapshot(state));
								let incoming;
								try {
									incoming = await request.json();
								} catch {
									return Response.json({ ok: false, message: "请求体不是合法 JSON" }, { status: 400 });
								}
								const { doc, problems } = normalizeDocument(incoming, state.doc);
								if (problems.length) {
									return Response.json({ ok: false, message: problems.join("；") }, { status: 400 });
								}
								await writeDocument(configPath(), doc);
								const portChanged = doc.port !== state.doc.port || doc.host !== state.doc.host;
								state.doc = doc;
								state.problems = [];
								log(`配置已保存：dir=${doc.dir} port=${doc.port} notify=${doc.notify} requireToken=${doc.requireToken}`);
								if (portChanged) await restart();
								return Response.json(stateSnapshot(state));
							} catch (error) {
								log(`配置路由失败：${error?.stack ?? error}`);
								return Response.json({ ok: false, message: String(error?.message ?? error) }, { status: 500 });
							}
						},
					}),
					"photo2dsh-by-lan: config route",
				);
				log(`配置路由已注册：${CONFIG_PATH}`);
			} catch (error) {
				log(`配置路由注册失败（仅少一个面板页面，不影响收照片）：${error?.message ?? error}`);
			}
		});
	} catch (error) {
		log(`等待 connection 服务失败（不影响收照片）：${error?.message ?? error}`);
	}
}

//#endregion

/**
 * 挂载本插件。**本函数绝不外抛。**
 */
export function apply(ctx, rowConfig) {
	const log = makeLogger(ctx);
	const state = {
		doc: defaultDocument(join(dshHome(), "photo-inbox")),
		problems: [],
		bound: null,
		listenError: null,
		received: 0,
		lastUpload: null,
		startedAt: new Date().toISOString(),
		notifier: null,
		receiver: null,
		notifyTimes: [],
	};

	const boot = async () => {
		try {
			const { doc, problems } = await resolveConfig(rowConfig);
			state.doc = doc;
			state.problems = problems;
			for (const p of problems) log(`⚠️ ${p}`);
		} catch (error) {
			state.problems.push(`配置解析失败（${error?.message ?? error}），已按内置默认值工作`);
			log(`配置解析失败：${error?.stack ?? error}`);
		}

		try {
			state.notifier = createNotifier({
				scriptPath: join(import.meta.dirname, "scripts", "toast.ps1"),
				tempDir: join(dshHome(), "photo2dsh-by-lan-tmp"),
				log,
			});
		} catch (error) {
			log(`通知器创建失败（仍可收照片）：${error?.message ?? error}`);
		}

		const start = async () => {
			try {
				await state.receiver?.stop();
			} catch { /* 停不掉就换新的 */ }
			const receiver = createReceiver({
				host: state.doc.host,
				port: state.doc.port,
				maxBytes: state.doc.maxBytes,
				log,
				handle: (request) => handleRequest(state, request, log),
			});
			const result = await receiver.start();
			state.receiver = receiver;
			if (result.ok) {
				state.bound = result.address;
				state.listenError = null;
				log(`已监听 ${state.doc.host}:${result.address?.port ?? state.doc.port}，落地目录 ${state.doc.dir}`);
			} else {
				state.bound = null;
				state.listenError = `端口 ${state.doc.port} 启动失败：${result.error?.code ?? result.error?.message ?? result.error}`;
				log(`⚠️ ${state.listenError}（不影响 DSH 启动；请在插件面板改一个端口）`);
			}
		};

		await start();
		state.restart = start;
		registerConfigRoute(ctx, state, log, start);

		// 插件卸载/禁用时收掉端口，别留个孤儿监听
		try {
			ctx.effect(() => () => { void state.receiver?.stop(); }, "photo2dsh-by-lan: stop receiver");
		} catch (error) {
			log(`注册清理钩子失败（不影响功能）：${error?.message ?? error}`);
		}
	};

	// 顶层兜底：boot 里的任何异常都不许打穿到宿主
	boot().catch((error) => {
		log(`启动失败（插件保持静默，不影响 DSH）：${error?.stack ?? error}`);
	});
}

// 只读出口：测试台直接断言纯逻辑，不必穿过网络
export const __internals = { handleRequest, setupPage, uploadedText, stateSnapshot };
