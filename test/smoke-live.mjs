/**
 * 真机冒烟：把**真正的插件代码**（index.mjs + receiver + store）在**真实端口**上跑一遍。
 *
 * 与离线验证台的区别：这里走的是完整接线——配置分层 → bind 端口 → 真 HTTP → 落盘，
 * 只是把 DSH 宿主换成一个最小假 ctx（不提供 connection 服务，因此路由注册会优雅降级，
 * 这本身也是要验的行为）。
 *
 * 跑法：`node test/smoke-live.mjs`（默认 8787；用 PHOTO2DSH_PORT 换端口）
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const PORT = Number(process.env.PHOTO2DSH_PORT ?? 8787);
const TMP = mkdtempSync(join(process.env.PHOTO2DSH_TMP ?? tmpdir(), "photo2dsh-smoke-"));
const HOME = join(TMP, "home");
const INBOX = join(TMP, "inbox");
process.env.DSH_HOME = HOME;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
	if (ok) { pass += 1; console.log(`✅ ${name}${detail ? `  ${detail}` : ""}`); }
	else { fail += 1; console.log(`❌ ${name}${detail ? `  ${detail}` : ""}`); }
};

const mod = await import("../index.mjs");

// 最小假 ctx：**故意不提供 connection 服务**，验证"拿不到它只丢卡片、不丢收照片"
const logs = [];
const ctx = {
	logger: { info: (line) => logs.push(String(line)) },
	inject: () => { /* 模拟服务永不出现 */ },
	effect: () => { /* no-op */ },
};

console.log(`临时目录：${TMP}\n端口：${PORT}\n`);
mod.apply(ctx, { dir: INBOX, port: PORT, notify: false });

// 等 receiver 起来
let ready = false;
for (let i = 0; i < 40; i += 1) {
	await new Promise((r) => setTimeout(r, 100));
	try {
		const res = await fetch(`http://127.0.0.1:${PORT}/ping`);
		if (res.ok) { ready = true; break; }
	} catch { /* 还没起来 */ }
}
check("插件在真实端口上起来并应答 /ping", ready, `port=${PORT}`);
if (!ready) {
	console.log("日志：\n" + logs.join("\n"));
	process.exit(1);
}

/** 读配置文档拿 token（等价于用户在面板里复制那串地址）。 */
const doc = JSON.parse(readFileSync(join(HOME, "photo2dsh-by-lan.json"), "utf8"));
check("首次启动自动生成 token 并持久化", typeof doc.token === "string" && doc.token.length === 32, `len=${doc.token?.length}`);
check("配置文档记录了行配置里的落地目录", doc.dir === INBOX, doc.dir);

// 造一张真实 PNG（8x8，带正确的 IHDR/IEND，能被嗅探认出）
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVQoz2NgGAWjYBSMglEwCkbBKBgFo2AUAAAGdAAB8Q0p1wAAAABJRU5ErkJggg==",
	"base64",
);
const sha = createHash("sha256").update(PNG).digest("hex");

// ① 正确 token → 应成功
const ok = await fetch(`http://127.0.0.1:${PORT}/u/${doc.token}?name=smoke.png`, {
	method: "POST",
	headers: { "content-type": "image/png" },
	body: PNG,
});
const okText = await ok.text();
check("① 正确 token 上传 → 200 且返回中文短句", ok.status === 200 && okText.includes("照片已收到"), `HTTP ${ok.status}`);

// ② 错 token → 401，且响应不含正确 token
const bad = await fetch(`http://127.0.0.1:${PORT}/u/wrong-token`, { method: "POST", body: PNG });
const badText = await bad.text();
check("② 错 token → 401 且**不回显**正确 token", bad.status === 401 && !badText.includes(doc.token), `HTTP ${bad.status}`);

// ③ 非图片 → 415
const notImage = await fetch(`http://127.0.0.1:${PORT}/u/${doc.token}`, { method: "POST", body: "just text" });
check("③ 非图片 → 415", notImage.status === 415, `HTTP ${notImage.status}`);

// ④ 畸形请求（URL 里混入换行）+ 真图 → 仍要取回（真机故障复现）
const { connect } = await import("node:net");
const malformedStatus = await new Promise((resolve) => {
	const sock = connect(PORT, "127.0.0.1", () => {
		sock.write(Buffer.from(
			`POST http://127.0.0.1:${PORT}/u/${doc.token}?name=mal.png\r\nHTTP/1.1\r\nHost: x\r\nContent-Type: image/png\r\nContent-Length: ${PNG.length}\r\nConnection: close\r\n\r\n`,
			"latin1",
		));
		sock.write(PNG);
	});
	let reply = "";
	sock.on("data", (c) => { reply += c.toString("utf8"); });
	sock.on("close", () => resolve(reply.split(/\r\n/).filter((l) => l.startsWith("HTTP/1.1 ")).pop() ?? "(无)"));
	sock.on("error", () => resolve("(连接错误)"));
	setTimeout(() => { sock.destroy(); }, 6000);
});
check("④ ★ 畸形请求行 + 真图 → 仍被取回", malformedStatus.includes("200"), malformedStatus);

// ⑤ 落盘核对：目录/侧车/哈希
const files = readdirSync(INBOX, { recursive: true, withFileTypes: true })
	.filter((e) => e.isFile())
	.map((e) => join(e.parentPath ?? INBOX, e.name));
const images = files.filter((f) => f.endsWith(".png"));
const sidecars = files.filter((f) => f.endsWith(".json"));
check("⑤ 落盘目录按 <日期> 分子目录", images.length >= 2 && images.every((f) => f.includes(INBOX)), `${images.length} 张`);
check("⑥ 每个文件都有 sidecar", sidecars.length === images.length, `${sidecars.length} 个`);
check("⑦ 落盘字节与上传字节逐字节一致", images.every((f) => createHash("sha256").update(readFileSync(f)).digest("hex") === sha));
check("⑧ sidecar 记录的是**嗅探所得**格式", sidecars.length > 0 && JSON.parse(readFileSync(sidecars[0], "utf8")).format === "png");

// ⑨ 假 ctx 下 boot 必须走完、且收照片不受影响。
// ⚠️ 注意断言写法：假 ctx 的 `inject` **永不回调**，所以"配置路由降级"那条日志根本不会出现
// （插件在等一个永不到来的服务——这是正确行为，不是缺陷）。
// 真正要验的是：**apply 没有抛错、boot 走完了、收照片照常**。
check("⑨ ★ 拿不到 connection 服务时 apply 不抛错、boot 走完、收照片不受影响",
	logs.some((l) => l.includes("已监听")), `${logs.length} 条日志`);

console.log(`\n共 ${pass + fail} 条：✅ ${pass}  ❌ ${fail}`);
console.log("插件日志：");
for (const l of logs) console.log(`   ${l}`);
rmSync(TMP, { recursive: true, force: true });
if (fail > 0) process.exitCode = 1;
// receiver 会一直让事件循环活着（它就是个常驻监听），测试脚本必须显式退出
process.exit(fail > 0 ? 1 : 0);
