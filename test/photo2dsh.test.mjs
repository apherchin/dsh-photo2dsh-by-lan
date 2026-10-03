/**
 * Photo2DSH 离线验证台。
 *
 * 设计原则（本项目反复吃过亏）：
 *   - **测试必须覆盖"故障复现用例"**，不能只测 happy path。下面标 ★ 的用例逐条对应真机踩过的坑；
 *   - **先快照基线、只统计新增**，否则计数虚高、测试变成空转；
 *   - 有 `100-continue` 时状态行要取**最后一条**；
 *   - 客户端半边在 Node 里跑不了（它依赖 `window.__ModuleLoader__`），
 *     所以用一层 shim 把 factory 取出来，只断言**纯逻辑**，不穿过 React。
 *
 * 跑法：`node test/photo2dsh.test.mjs`（任意 cwd 都行）
 */
import { connect } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = "") {
	if (ok) {
		pass += 1;
		console.log(`✅ ${name}${detail ? `  ${detail}` : ""}`);
	} else {
		fail += 1;
		failures.push(name);
		console.log(`❌ ${name}${detail ? `  ${detail}` : ""}`);
	}
}
function section(title) {
	console.log(`\n──────── ${title} ────────`);
}
const sha = (b) => createHash("sha256").update(b).digest("hex");

/** 递归列出**文件**（不含目录）。`readdirSync(recursive)` 会把目录也列出来，直接 read 会 EISDIR。 */
function listFiles(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		out.push(join(entry.parentPath ?? entry.path ?? dir, entry.name));
	}
	return out;
}

// 所有临时产物都放在 test/.tmp（跟着本包走，不碰用户真实目录）
const TMP_ROOT = join(import.meta.dirname, ".tmp");
rmSync(TMP_ROOT, { recursive: true, force: true });
const mkTmp = (label) => mkdtempSync(join(process.env.PHOTO2DSH_TMP ?? tmpdir(), `photo2dsh-${label}-`));

//#region core.mjs
section("core.mjs —— 纯逻辑");
const core = await import("../core.mjs");

check("safeName 剥掉目录成分并白名单化",
	core.safeName("../../etc/passwd") === "passwd" && core.safeName("a b/c?.jpg") === "c_.jpg",
	`${core.safeName("../../etc/passwd")} / ${core.safeName("a b/c?.jpg")}`);
check("safeName 对前导点做兜底", core.safeName(".hidden") === "x.hidden");

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7), Buffer.from([0xff, 0xd9])]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 3)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(64, 1)]);

check("sniff 认得 JPEG / PNG", core.sniff(JPEG) === "jpeg" && core.sniff(PNG) === "png");
check("sniff 认得 HEIC（真机实测快捷指令会原样透传）", core.sniff(HEIC).startsWith("heif"), core.sniff(HEIC));
check("sniff 对非图片返回 unknown", core.sniff(Buffer.from("hello world!!")) === "unknown");

check("★ 扩展名跟随魔术字节，而不是客户端给的名字/头", (() => {
	// 真机实测：快捷指令头写 image/jpeg，字节却是 PNG
	const name = core.targetName("photo.jpg", "a".repeat(64), core.sniff(PNG));
	return name.endsWith(".png");
})(), core.targetName("photo.jpg", "a".repeat(64), "png"));

check("targetName 含哈希前缀且清洗原名", (() => {
	const n = core.targetName("IMG 1234.HEIC", "0123456789abcdef", "heif(heic)", "20261003230000");
	return n === "20261003230000-01234567-IMG_1234.bin";
})(), core.targetName("IMG 1234.HEIC", "0123456789abcdef", "heif(heic)", "20261003230000"));

check("★ 时间用本地时区（不是 UTC）", (() => {
	const d = new Date(2026, 9, 4, 0, 16, 27); // 本地 2026-10-04 00:16:27
	// 构造一个"UTC 日期与本地日期不同"的时刻：本地 00:16 在东八区 ⇒ UTC 还是前一天 16:16
	const stamp = core.localStamp(d);
	const utc = d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
	return stamp === "20261004001627" && core.localReadable(d) === "2026-10-04 00:16:27" && core.localDateDir(d) === "2026-10-04" && stamp !== utc;
})());

check("humanSize 分档正确",
	core.humanSize(512) === "512 B" && core.humanSize(2048) === "2.0 KB" && core.humanSize(12 * 1024 * 1024) === "12.00 MB");

check("isPhotoKind 收 jpeg/png/heif，拒 unknown", core.isPhotoKind("jpeg") && core.isPhotoKind("png")
	&& core.isPhotoKind("heif(heic)") && !core.isPhotoKind("unknown") && !core.isPhotoKind("MULTIPART-ENVELOPE(未解析)"));

check("★ joinWithin 拒绝路径穿越", core.joinWithin("C:\\inbox", "..\\evil.jpg") === undefined
	&& core.joinWithin("C:\\inbox", "a/b.jpg") === undefined
	&& core.joinWithin("C:\\inbox", ".hidden") === undefined
	&& core.joinWithin("C:\\inbox", "ok.jpg") === "C:\\inbox\\ok.jpg");

check("normalizeDocument 保留 requireToken 并拒绝非法端口", (() => {
	const base = core.defaultDocument("C:\\d");
	const r1 = core.normalizeDocument({ requireToken: false }, base);
	const r2 = core.normalizeDocument({ port: 99999 }, base);
	return r1.doc.requireToken === false && r1.problems.length === 0 && r2.doc.port === 8787 && r2.problems.length === 1;
})());

check("parseDocumentText 对坏 JSON 退默认值且带原因", (() => {
	const base = core.defaultDocument("C:\\d");
	const r = core.parseDocumentText("{not json", base);
	return r.doc.dir === "C:\\d" && r.problems.length === 1;
})());

/** ★ 真机复现用的网卡清单：本机实测有三个私网 IPv4，其中两个是 Hyper-V 虚拟网卡。 */
const REAL_ADAPTERS = {
	"Hyper-V Virtual Ethernet Adapter": [{ family: "IPv4", internal: false, address: "172.28.80.1" }],
	"Hyper-V Virtual Ethernet Adapter #3": [{ family: "IPv4", internal: false, address: "192.168.200.1" }],
	"Realtek Gaming 2.5GbE Family Controller": [{ family: "IPv4", internal: false, address: "192.168.5.22" }],
	"Loopback": [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
	"公网对照组": [{ family: "IPv4", internal: false, address: "8.8.8.8" }],
};

check("★ 真机场景：三个私网地址里必须挑中真网卡，而不是 192.168.200.1（Hyper-V vSwitch）",
	core.pickLanAddress(REAL_ADAPTERS) === "192.168.5.22", String(core.pickLanAddress(REAL_ADAPTERS)));

check("listLanAddresses 给出适配器名并把虚拟网卡排在后面", (() => {
	const list = core.listLanAddresses(REAL_ADAPTERS);
	return list.length === 3
		&& list[0].address === "192.168.5.22" && list[0].virtual === false
		&& list.slice(1).every((c) => c.virtual === true)
		&& typeof list[0].adapter === "string" && list[0].adapter.length > 0;
})());

check("★ 同一优先级内按**数值**排序（字典序会把 192.168.200.1 排到 192.168.5.22 前面）", (() => {
	const list = core.listLanAddresses({
		"a": [{ family: "IPv4", internal: false, address: "192.168.200.1" }],
		"b": [{ family: "IPv4", internal: false, address: "192.168.5.22" }],
	});
	return list[0].address === "192.168.5.22";
})());

check("无可用网卡时返回 undefined（不编造地址）", core.pickLanAddress({}) === undefined);

check("★ isLoopbackOrigin：外域拒、回环放", (() => {
	return core.isLoopbackOrigin("https://evil.example") === false
		&& core.isLoopbackOrigin("http://127.0.0.1:8787") === true
		&& core.isLoopbackOrigin("http://localhost:8787") === true
		&& core.isLoopbackOrigin("https://192.168.5.15") === false
		&& core.isLoopbackOrigin("") === false
		&& core.isLoopbackOrigin("not a url") === false;
})());

check("isPrivate 覆盖 IPv6 回环/链路本地/唯一本地与 v4-mapped", (() => {
	return core.isPrivate("::1") && core.isPrivate("fe80::1") && core.isPrivate("fd00::1")
		&& core.isPrivate("::ffff:192.168.5.15") && !core.isPrivate("203.0.113.9");
})());

check("nameOfTarget / noteOfTarget / wantsJson",
	core.nameOfTarget("/u/tok?name=IMG_0001.HEIC") === "IMG_0001.HEIC"
	&& core.noteOfTarget("/u/tok?note=%E5%8D%96%E5%9C%BA") === "卖场"
	&& core.wantsJson("/u/tok?as=json") === true
	&& core.wantsJson("/u/tok") === false);

check("boundaryOf / parseMultipart / pickFilePart / nameOfPart", (() => {
	const boundary = "----b123";
	const body = Buffer.concat([
		Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n`, "latin1"),
		Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`, "latin1"),
		JPEG,
		Buffer.from(`\r\n--${boundary}--\r\n`, "latin1"),
	]);
	const parts = core.parseMultipart(body, boundary);
	const picked = core.pickFilePart(parts);
	return core.boundaryOf("multipart/form-data; boundary=----b123") === "----b123"
		&& parts.length === 2 && sha(picked.body) === sha(JPEG) && core.nameOfPart(picked) === "a.jpg";
})());
//#endregion

//#region receiver.mjs（真 socket 集成）
section("receiver.mjs —— 真 socket 集成");
const { createReceiver } = await import("../receiver.mjs");
const { landPhoto } = await import("../store.mjs");

const inbox = mkTmp("inbox");
const seen = [];
const receiver = createReceiver({
	host: "127.0.0.1",
	port: 0,
	maxBytes: 64 * 1024 * 1024,
	log: (line) => seen.push(line),
	handle: async (request) => {
		if (request.method === "GET") return { status: 200, ctype: "text/plain; charset=utf-8", body: "pong\n" };
		if (request.body && request.body.length > 0) {
			const kind = core.sniff(request.body);
			await landPhoto({ rootDir: inbox, payload: request.body, name: core.nameOfTarget(request.target), kind });
			return { status: 200, ctype: "text/plain; charset=utf-8", body: "✅ 已收到\n" };
		}
		return { status: 400, ctype: "text/plain; charset=utf-8", body: "empty\n" };
	},
});
const started = await receiver.start();
check("receiver 能在临时端口上启动", started.ok === true, started.ok ? `port=${started.address?.port}` : String(started.error));
const PORT = started.address?.port ?? 0;

/** 发一段原始字节并取回响应。状态行取**最后一条**（100-continue 时前面还有一条）。 */
function raw(payload, { expectContinue = false } = {}) {
	return new Promise((resolve) => {
		const t0 = Date.now();
		const sock = connect(PORT, "127.0.0.1", () => {
			// ⚠️ 非 100-continue 的用例必须**把体一起写出去**；只写头会让服务端一直等体。
			if (expectContinue) sock.write(payload.headers);
			else sock.write(Buffer.concat([payload.headers, payload.body ?? Buffer.alloc(0)]));
		});
		let reply = "";
		let done = false;
		let sentBody = false;
		const finish = () => {
			if (done) return;
			done = true;
			sock.destroy();
			const last = (reply.split(/\r\n/).filter((l) => l.startsWith("HTTP/1.1 ")).pop() ?? "(无响应)").trim();
			resolve({ status: last, body: reply, ms: Date.now() - t0 });
		};
		sock.on("data", (c) => {
			reply += c.toString("utf8");
			if (expectContinue && !sentBody && reply.includes("100 Continue")) {
				sentBody = true;
				sock.write(payload.body);
				return;
			}
			if (reply.includes("\r\n\r\n")) setTimeout(finish, 60);
		});
		sock.on("close", finish);
		sock.on("error", finish);
		setTimeout(finish, 8000);
	});
}

const baseline = new Set(listFiles(inbox));

const rPing = await raw({ headers: Buffer.from("GET /ping HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", "latin1") });
check("GET /ping 正常且响应行带原因短语", rPing.status === "HTTP/1.1 200 OK", rPing.status);

/** ★ 真机故障复现①：请求行里混入换行（URL 被断成两行） */
const malformed = {
	headers: Buffer.from(`POST http://192.168.5.22:8787/u/tok\r\nHTTP/1.1\r\nHost: 192.168.5.22:8787\r\nContent-Type: image/png\r\nContent-Length: ${PNG.length}\r\nConnection: close\r\n\r\n`, "latin1"),
	body: PNG,
};
const rBad = await raw(malformed);
check("★ 畸形请求行 + 真实图片 → 仍被取回", rBad.status === "HTTP/1.1 200 OK", `${rBad.status} ${rBad.ms}ms`);

/** ★ 真机故障复现②：头里含无冒号的垃圾行 */
const garbage = {
	headers: Buffer.from(`POST /u/tok\r\nGARBAGE LINE WITHOUT COLON\r\nHTTP/1.1\r\nHost: x\r\nContent-Type: image/png\r\nContent-Length: ${PNG.length}\r\nConnection: close\r\n\r\n`, "latin1"),
	body: PNG,
};
check("★ 头里含无冒号垃圾行 → 仍被取回", (await raw(garbage)).status === "HTTP/1.1 200 OK");

/** ★ 真机故障复现③：客户端等 100-continue 才发体 */
const expectReq = {
	headers: Buffer.from(`POST /u/tok HTTP/1.1\r\nHost: x\r\nContent-Type: image/jpeg\r\nContent-Length: ${JPEG.length}\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n`, "latin1"),
	body: JPEG,
};
check("★ 客户端等 100-continue 也能走通", (await raw(expectReq, { expectContinue: true })).status === "HTTP/1.1 200 OK");

/** ★ 真机故障复现④：chunked 传输编码 */
const chunkedBody = Buffer.concat([
	Buffer.from(JPEG.length.toString(16) + "\r\n", "latin1"), JPEG, Buffer.from("\r\n0\r\n\r\n", "latin1"),
]);
const chunked = {
	headers: Buffer.from("POST /u/tok HTTP/1.1\r\nHost: x\r\nContent-Type: image/jpeg\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n", "latin1"),
	body: chunkedBody,
};
check("★ chunked 传输编码也能取回", (await raw(chunked)).status === "HTTP/1.1 200 OK");

/** 大文件多包拼接（走真 socket，必然分多个 TCP 段） */
const BIG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3 * 1024 * 1024, 0x5a), Buffer.from([0xff, 0xd9])]);
const bigReq = {
	headers: Buffer.from(`POST /u/tok?name=big.img HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: ${BIG.length}\r\nConnection: close\r\n\r\n`, "latin1"),
	body: BIG,
};
const rBig = await raw(bigReq);
check("3MB 大图多包拼接 → 200 且耗时合理", rBig.status === "HTTP/1.1 200 OK" && rBig.ms < 1500, `${rBig.ms}ms`);

await new Promise((r) => setTimeout(r, 300));
const freshFull = listFiles(inbox).filter((f) => !baseline.has(f) && !f.endsWith(".json"));
const hashes = freshFull.map((f) => sha(readFileSync(f)));
check("★ 所有形态取回的字节都与原图一致（含畸形与 chunked 路径）",
	hashes.filter((h) => h === sha(PNG)).length === 2 && hashes.filter((h) => h === sha(JPEG)).length === 2,
	`PNG×${hashes.filter((h) => h === sha(PNG)).length} JPEG×${hashes.filter((h) => h === sha(JPEG)).length}`);
check("3MB 大图哈希一致", hashes.filter((h) => h === sha(BIG)).length === 1);

/** ★ 真机故障复现⑤：同一秒内同名多次上传不得互相覆盖 */
const before = listFiles(inbox).filter((f) => !f.endsWith(".json")).length;
const dupReq = () => ({
	headers: Buffer.from(`POST /u/tok?name=dup.img HTTP/1.1\r\nHost: x\r\nContent-Type: image/png\r\nContent-Length: ${PNG.length}\r\nConnection: close\r\n\r\n`, "latin1"),
	body: PNG,
});
await raw(dupReq());
await raw(dupReq());
const after = listFiles(inbox).filter((f) => !f.endsWith(".json")).length;
check("★ 同一秒同名两次上传各自成文件（防静默覆盖）", after - before === 2, `新增 ${after - before} 个`);

check("每个照片都有 sidecar（且 format 是嗅探所得）", (() => {
	const json = listFiles(inbox).filter((f) => f.endsWith(".json"));
	if (json.length === 0) return false;
	const doc = JSON.parse(readFileSync(json[0], "utf8"));
	return ["jpeg", "png"].includes(doc.format) && typeof doc.sha256 === "string" && doc.sha256.length === 64;
})());

check("★ 响应及时（无 2.5 秒空闲白等）", [rPing, rBad, rBig].every((r) => r.ms < 1200));

await receiver.stop();
//#endregion

//#region index.mjs —— 路由逻辑（不启真端口）
section("index.mjs —— 请求处理与配置");
process.env.DSH_HOME = mkTmp("home");
const host = await import("../index.mjs");

const uploadDir = mkTmp("upload");
function makeState(overrides = {}) {
	return {
		doc: { ...core.defaultDocument(uploadDir), token: "t".repeat(32), port: 8787, host: "0.0.0.0" },
		problems: [], bound: null, listenError: null, received: 0, lastUpload: null,
		startedAt: new Date().toISOString(), notifier: null, receiver: null, notifyTimes: [],
		...overrides,
	};
}
const noop = () => {};
const req = (over = {}) => ({ method: "POST", target: `/u/${"t".repeat(32)}`, remote: "192.168.5.15", body: PNG, ctype: "image/png", ua: "test", framing: "content-length", ...over });

check("★ 缺 token → 401，且响应**不含** token 明文", await (async () => {
	const r = await host.__internals.handleRequest(makeState(), req({ target: "/u/nope" }), noop);
	return r.status === 401 && !r.body.includes("t".repeat(32)) && r.body.includes("形如");
})());

check("★ 路径里写了 /u/ 但 token 错 → 401（抓得住手滑）", (await host.__internals.handleRequest(makeState(), req({ target: "/u/wrong" }), noop)).status === 401);

check("正确 token + PNG → 200 且落盘", await (async () => {
	const state = makeState();
	const r = await host.__internals.handleRequest(state, req(), noop);
	const files = listFiles(uploadDir);
	return r.status === 200 && r.body.includes("照片已收到") && state.received === 1 && files.some((f) => f.endsWith(".png"));
})());

check("人话响应里写明格式与体积", await (async () => {
	const r = await host.__internals.handleRequest(makeState(), req(), noop);
	return /格式：PNG（[\d.]+ (B|KB|MB)）/.test(r.body);
})());

check("?as=json → 机器可读 JSON", await (async () => {
	const r = await host.__internals.handleRequest(makeState(), req({ target: `/u/${"t".repeat(32)}?as=json` }), noop);
	return r.ctype.startsWith("application/json") && JSON.parse(r.body).kind === "png";
})());

check("★ 非图片 → 415 且不落盘", await (async () => {
	const dir = mkTmp("reject");
	const state = makeState({ doc: { ...core.defaultDocument(dir), token: "t".repeat(32) } });
	const r = await host.__internals.handleRequest(state, req({ body: Buffer.from("definitely not an image") }), noop);
	return r.status === 415 && readdirSync(dir).length === 0;
})());

check("multipart 上传 → 200", await (async () => {
	const boundary = "----zzz";
	const body = Buffer.concat([
		Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="m.png"\r\nContent-Type: image/png\r\n\r\n`, "latin1"),
		PNG,
		Buffer.from(`\r\n--${boundary}--\r\n`, "latin1"),
	]);
	const r = await host.__internals.handleRequest(makeState(), req({ body, ctype: `multipart/form-data; boundary=${boundary}` }), noop);
	return r.status === 200;
})());

check("GET /health → 200 JSON 且**不含 token**", await (async () => {
	const r = await host.__internals.handleRequest(makeState(), { method: "GET", target: "/health", remote: "192.168.5.15" }, noop);
	return r.status === 200 && !r.body.includes("t".repeat(32));
})());

check("★ 设置页只对本机回环开放；局域网 IP 被拒（含 token）", await (async () => {
	const state = makeState();
	const lan = await host.__internals.handleRequest(state, { method: "GET", target: "/", remote: "192.168.5.15" }, noop);
	const local = await host.__internals.handleRequest(state, { method: "GET", target: "/", remote: "127.0.0.1" }, noop);
	return lan.status === 403 && local.status === 200 && local.body.includes("t".repeat(32));
})());

check("requireToken=false 时放行无 token 请求（调试开关）", (await host.__internals.handleRequest(
	makeState({ doc: { ...core.defaultDocument(mkTmp("open")), token: "t".repeat(32), requireToken: false } }),
	req({ target: "/" }), noop,
)).status === 200);

// ── ★ 用户明确要求的两道闸门（"不用 token，靠锁局域网地址"） ──────
check("★ 闸门①：公网来源的上传 → 403（lanOnly）", await (async () => {
	const r = await host.__internals.handleRequest(makeState(), req({ remote: "203.0.113.9" }), noop);
	return r.status === 403;
})());

check("★ 闸门②：跨源 Origin → 403，**即使 token 正确、来源是私网**", await (async () => {
	const r = await host.__internals.handleRequest(makeState(), req({ origin: "https://evil.example" }), noop);
	return r.status === 403 && r.body.includes("跨源");
})());

check("回环 Origin（PC 设置页的上传表单）→ 放行", await (async () => {
	return (await host.__internals.handleRequest(makeState(), req({ origin: "http://127.0.0.1:8787" }), noop)).status === 200;
})());

check("★ 用户目标形态：**不用 token + 锁局域网 + 无 Origin** → 200", await (async () => {
	const state = makeState({ doc: { ...core.defaultDocument(mkTmp("notoken")), token: "t".repeat(32), requireToken: false, lanOnly: true } });
	const r = await host.__internals.handleRequest(state, req({ target: "/" }), noop);
	return r.status === 200 && state.received === 1;
})());

check("★★ 关键：不用 token 时，跨源请求**仍必须**被拒（第二道防线独立生效）", await (async () => {
	const state = makeState({ doc: { ...core.defaultDocument(mkTmp("notoken2")), token: "t".repeat(32), requireToken: false, lanOnly: true } });
	const r = await host.__internals.handleRequest(state, req({ target: "/", origin: "https://evil.example" }), noop);
	return r.status === 403;
})());

check("stateSnapshot 暴露 lanOnly 与 sidecar 供面板显示", (() => {
	const s = host.__internals.stateSnapshot(makeState());
	return s.lanOnly === true && s.sidecar === true;
})());

// ── ★ 元数据卡（sidecar）可开关 ────────────────────────────────
check("★ sidecar 开：每张照片旁有元数据卡", await (async () => {
	const dir = mkTmp("sc-on");
	const state = makeState({ doc: { ...core.defaultDocument(dir), token: "t".repeat(32), sidecar: true } });
	await host.__internals.handleRequest(state, req(), noop);
	return listFiles(dir).some((f) => f.endsWith(".json"));
})());

check("★ sidecar 关：目录里只剩照片、且照片本身照常落盘", await (async () => {
	const dir = mkTmp("sc-off");
	const state = makeState({ doc: { ...core.defaultDocument(dir), token: "t".repeat(32), sidecar: false } });
	const r = await host.__internals.handleRequest(state, req(), noop);
	const files = listFiles(dir);
	return r.status === 200 && files.some((f) => f.endsWith(".png")) && !files.some((f) => f.endsWith(".json"));
})());

check("配置文档：写入后能读回，且 token 自动生成（16 字节 → 32 个十六进制字符 = 128 bit）", await (async () => {
	const home = mkTmp("home2");
	process.env.DSH_HOME = home;
	const first = await host.resolveConfig({});
	const again = await host.resolveConfig({});
	return first.doc.token.length === 32 && again.doc.token === first.doc.token
		&& readFileSync(host.configPath(home), "utf8").includes(first.doc.token);
})());

check("配置文档：坏 JSON 退默认值且带原因", await (async () => {
	const home = mkTmp("home3");
	process.env.DSH_HOME = home;
	await import("node:fs/promises").then((fs) => fs.writeFile(host.configPath(home), "{broken", "utf8"));
	const r = await host.resolveConfig({});
	return r.problems.length >= 1 && r.doc.port === 8787;
})());

check("stateSnapshot 带出监听状态、上传地址、网卡候选与手动指定", (() => {
	const auto = host.__internals.stateSnapshot(makeState());
	const manual = host.__internals.stateSnapshot(makeState({
		doc: { ...core.defaultDocument(mkTmp("ip")), token: "t".repeat(32), lanIp: "10.0.0.9" },
	}));
	return auto.ok === true
		&& typeof auto.uploadUrl === "string" && auto.uploadUrl.includes("/u/")
		&& Array.isArray(auto.lanCandidates)
		&& manual.uploadUrl.includes("10.0.0.9")
		&& manual.lan === "10.0.0.9";
})());
//#endregion

//#region client.js —— 纯逻辑（用 shim 取出 factory）
section("client.js —— 面板卡片纯逻辑");
let clientExports = null;
try {
	let def = null;
	globalThis.window = { __ModuleLoader__: { load: (d) => { def = d; } } };
	await import("../client.js");
	const fakeReact = {
		useState: (v) => [typeof v === "function" ? v() : v, () => {}],
		useEffect: () => {},
		useRef: (v) => ({ current: v }),
		Fragment: Symbol("Fragment"),
	};
	clientExports = def.factory((spec) => {
		if (spec === "react") return fakeReact;
		if (spec === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null, Fragment: fakeReact.Fragment };
		throw new Error(`unexpected require: ${spec}`);
	});
} catch (error) {
	check("client.js 可在 shim 下加载", false, String(error));
}

if (clientExports !== null) {
	const ci = clientExports.__internals;
	check("client 声明无硬门禁 inject（防启动门禁）", Array.isArray(clientExports.inject) && clientExports.inject.length === 0);
	check("★ 卡片注册进官方槽位 plugins.bundle.config，key 等于包名", (() => {
		const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
		return ci.SLOT === "plugins.bundle.config" && ci.ENTRY_KEY === pkg.name;
	})(), `${ci.SLOT} / ${ci.ENTRY_KEY}`);
	check("client.js 顶部 id 等于包名（否则浏览器半边挂不上）", (() => {
		const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
		const text = readFileSync(join(import.meta.dirname, "..", "client.js"), "utf8");
		return text.includes(`id: "${pkg.name}"`);
	})());

	check("draftFromState：上限按 MB 展示，带 lanIp / lanOnly / sidecar", (() => {
		const d = ci.draftFromState({ dir: "C:\\x", port: 8787, lanIp: "192.168.5.22", maxBytes: 64 * 1024 * 1024, notify: true, requireToken: true, lanOnly: true, sidecar: false });
		return d.maxMB === "64" && d.port === "8787" && d.notify === true && d.lanIp === "192.168.5.22"
			&& d.lanOnly === true && d.sidecar === false;
	})());

	check("toRequest：MB → 字节，并带上 lanIp（空串=自动）/ lanOnly / sidecar", (() => {
		const r = ci.toRequest({ dir: " C:\\x ", port: "8787", lanIp: "", maxMB: "8", notify: false, requireToken: false, lanOnly: true, sidecar: false });
		return r.dir === "C:\\x" && r.port === 8787 && r.lanIp === "" && r.maxBytes === 8 * 1024 * 1024
			&& r.notify === false && r.requireToken === false && r.lanOnly === true && r.sidecar === false;
	})());

	check("卡片里确实有 sidecar 开关", (() => {
		return readFileSync(join(import.meta.dirname, "..", "client.js"), "utf8").includes("每张照片写一张元数据卡");
	})());

	check("卡片里确实有「只接受局域网来源」开关", (() => {
		return readFileSync(join(import.meta.dirname, "..", "client.js"), "utf8").includes("只接受局域网来源");
	})());

	check("firstProblem 拦住空目录/坏端口/坏上限", (() => {
		return ci.firstProblem({ dir: "", port: "8787", maxMB: "64" }) !== null
			&& ci.firstProblem({ dir: "C:\\x", port: "99999", maxMB: "64" }) !== null
			&& ci.firstProblem({ dir: "C:\\x", port: "8787", maxMB: "0" }) !== null
			&& ci.firstProblem({ dir: "C:\\x", port: "8787", maxMB: "64" }) === null;
	})());

	check("applyEdit 改草稿且清掉旧提示", (() => {
		const store = ci.createStore({ ...ci.emptyShell(), draft: ci.draftFromState({ dir: "a", port: 1, maxBytes: 1024, notify: true, requireToken: true }), notice: { tone: "ok", text: "旧" } });
		ci.applyEdit(store, { field: "dir", value: "b" });
		const s = store.getSnapshot();
		return s.draft.dir === "b" && s.notice === null;
	})());

	check("summaryText 一行说清状态", (() => {
		const text = ci.summaryText({ state: { listening: true, port: 8787, received: 3, dir: "C:\\inbox" } });
		return text.includes("监听中") && text.includes("已收 3 张") && text.includes("C:\\inbox");
	})());

	check("store 订阅在 set/update 时都会通知", (() => {
		const store = ci.createStore({ n: 0 });
		let hits = 0;
		const off = store.subscribe(() => { hits += 1; });
		store.set({ n: 1 });
		store.update((s) => ({ n: s.n + 1 }));
		off();
		store.set({ n: 9 });
		return hits === 2 && store.getSnapshot().n === 9;
	})());
}
//#endregion

section("结果");
console.log(`共 ${pass + fail} 条：✅ ${pass}  ❌ ${fail}`);
if (fail > 0) {
	console.log("失败项：");
	for (const f of failures) console.log(`   ❌ ${f}`);
	process.exitCode = 1;
}
rmSync(TMP_ROOT, { recursive: true, force: true });
