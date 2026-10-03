/**
 * 打包预检：按**安装器/加载器的视角**检查这个包，而不是"我自己觉得没问题"。
 *
 * 这里每一条都对应一个会让安装或加载静默失败的真实契约，尤其是：
 *   - 补丁行 `name` 必须**逐字等于包名**（否则客户端半边挂不上、卡片不出现）
 *   - `client.js` 顶部 `id` 也必须等于包名
 *   - `files` 白名单漏 `scripts/*.ps1` ⇒ 装完等于半个插件（通知永远不弹）
 *   - 有 `dsh.bundle.patch` 声明，否则 plugin manager 会**回滚整次安装**
 *
 * 跑法：`node test/preflight.mjs`
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const exists = (p) => existsSync(join(ROOT, p));

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

console.log(`预检根目录：${ROOT}\n`);

// ── 1. package.json 必备字段 ─────────────────────────────────
const pkg = JSON.parse(read("package.json"));
check("package.json 可解析且有 name/main", typeof pkg.name === "string" && pkg.name !== "" && typeof pkg.main === "string", pkg.name);
check("声明了 dsh.bundle.patch（缺它安装会被整次回滚）", typeof pkg.dsh?.bundle?.patch === "string", pkg.dsh?.bundle?.patch);
check("声明了 dsh.client（缺它面板卡片不会出现）", typeof pkg.dsh?.client === "object");
check("dsh.client.inject 为空数组（不挂硬门禁，防启动门禁）", Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length === 0);
check("exports 暴露 ./client（客户端半边入口）", typeof pkg.exports?.["./client"] === "string", pkg.exports?.["./client"]);
check("unscoped 包不需要 publishConfig.access", pkg.name.startsWith("@") ? pkg.publishConfig?.access === "public" : true);
check("声明 os=win32（通知依赖 Windows PowerShell）", Array.isArray(pkg.os) && pkg.os.includes("win32"));

// ── 2. 声明的文件都真的存在 ───────────────────────────────────
for (const [key, rel] of Object.entries(pkg.exports ?? {})) {
	if (typeof rel !== "string" || key.includes("*")) continue;
	check(`exports["${key}"] 指向的文件存在`, exists(rel), rel);
}
check("main 指向的文件存在", exists(pkg.main), pkg.main);
check("icon 指向的文件存在", typeof pkg.icon !== "string" || exists(pkg.icon), pkg.icon);

// ── 3. 补丁 YAML：真解析 + name 必须等于包名 ───────────────────
const patchText = read(pkg.dsh.bundle.patch);
let patch = null;
let parsedByYaml = false;
// 优先做**真解析**。从插件目录 `import("js-yaml")` 通常解析不到（它在 DSH profile 里），
// 所以额外试两个已知位置；都不行才退化成结构检查。
const yamlCandidates = [
	"js-yaml",
	join(process.env.USERPROFILE ?? "", ".dsh", "profiles", "node_modules", "js-yaml", "index.js"),
	join(process.env.USERPROFILE ?? "", ".dsh", "profiles", "desktop", "node_modules", "js-yaml", "index.js"),
];
for (const candidate of yamlCandidates) {
	try {
		const spec = candidate === "js-yaml" ? candidate : pathToFileURL(candidate).href;
		const mod = await import(spec);
		const yaml = mod.default ?? mod;
		patch = yaml.load(patchText);
		parsedByYaml = true;
		break;
	} catch {
		// 试下一个候选
	}
}
if (!parsedByYaml) {
	// 结构检查：够用，因为我们只关心 insert 行的 id/name。
	// ⚠️ 必须**同时**抓 id 与 name —— 只抓 name 会让"补丁行有 id"那条断言假红。
	const rowsFound = [...patchText.matchAll(/-[ \t]*id:[ \t]*([^\s#]+)[\s\S]*?name:[ \t]*"([^"]+)"/g)]
		.map((m) => ({ id: m[1], name: m[2] }));
	patch = [{ insert: rowsFound }];
}
check(
	parsedByYaml
		? "cordis.patch.yml 用 js-yaml 真解析通过"
		: "cordis.patch.yml 结构可识别（未找到 js-yaml，退化为结构检查；id/name 仍校验）",
	patch !== null && typeof patch === "object",
);

const rows = patch?.[0]?.insert ?? [];
check("补丁恰有一行 insert", rows.length === 1, `实得 ${rows.length}`);
check("★ 补丁行的 name **逐字等于包名**（否则客户端半边挂不上）", rows[0]?.name === pkg.name, `${rows[0]?.name} vs ${pkg.name}`);
check("补丁行有 id", typeof rows[0]?.id === "string" && rows[0].id !== "", rows[0]?.id);

// ── 4. 源码内的相对 import 都能解析 ───────────────────────────
for (const file of ["index.mjs", "core.mjs", "receiver.mjs", "store.mjs", "notify.mjs"]) {
	const text = read(file);
	const specs = [...text.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1]);
	const missing = specs.filter((s) => !exists(join(dirname(file), s)));
	check(`${file} 的相对 import 全部存在`, missing.length === 0, missing.join(", "));
}

// ── 5. client.js 的硬契约 ─────────────────────────────────────
const client = read("client.js");
check("★ client.js 顶部 id 等于包名", client.includes(`id: "${pkg.name}"`), pkg.name);
check("client.js 注册进官方槽位 plugins.bundle.config", client.includes('"plugins.bundle.config"'));
check("client.js 的 key 等于包名", new RegExp(`ENTRY_KEY\\s*=\\s*"${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(client));
check("client.js 不含任何 Harness Client 包的 require（官方 practices 禁止）",
	!/require\(\s*["']@deepseek-ai\//.test(client));
check("client.js 无 BOM（有 BOM 会让模块表解析异常）",
	readFileSync(join(ROOT, "client.js"))[0] !== 0xef);

// ── 6. PowerShell 脚本：存在、纯 ASCII、无 BOM ────────────────
const ps1 = "scripts/toast.ps1";
check("toast.ps1 存在", exists(ps1));
if (exists(ps1)) {
	const bytes = readFileSync(join(ROOT, ps1));
	const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
	const nonAscii = [...bytes].filter((b) => b > 0x7f).length;
	// 中文 .ps1 必须带 BOM；本脚本刻意纯 ASCII，所以**既不该有 BOM、也不该有非 ASCII**
	check("★ toast.ps1 纯 ASCII（因此不需要 BOM，绕开 5.1 的编码坑）", nonAscii === 0, `非 ASCII 字节 ${nonAscii}`);
	check("toast.ps1 无 BOM（纯 ASCII 时 BOM 反而多余）", !hasBom);
}

// ── 7. files 白名单是否覆盖运行期真正需要的文件 ────────────────
const patterns = pkg.files ?? [];
const covered = (rel) => patterns.some((p) => {
	if (p === rel) return true;
	if (p.endsWith("/*")) return rel.startsWith(p.slice(0, -1));
	if (p.includes("*")) {
		const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
		return re.test(rel);
	}
	return false;
});
const runtimeFiles = ["index.mjs", "core.mjs", "receiver.mjs", "store.mjs", "notify.mjs", "client.js", "cordis.patch.yml", "scripts/toast.ps1", "icon.svg", "locale/zh.json"];
for (const rel of runtimeFiles) {
	check(`files 白名单覆盖运行期文件 ${rel}`, covered(rel));
}

// ── 8. 摘要 ──────────────────────────────────────────────────
console.log(`\n共 ${pass + fail} 条：✅ ${pass}  ❌ ${fail}`);
if (fail > 0) {
	console.log("失败项：");
	for (const f of failures) console.log(`   ❌ ${f}`);
	process.exitCode = 1;
}
