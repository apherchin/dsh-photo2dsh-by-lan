/**
 * 落盘层：原子、防覆盖、并写 sidecar。
 *
 * 目录布局：`<配置的落地目录>\<YYYY-MM-DD>\<本地时间戳>-<sha8>-<原名>.<ext>`
 * 日期子目录让一个用久了的收件箱不会变成几万文件的巨型平铺目录。
 */
import { createHash } from "node:crypto";
import { link, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localDateDir, localReadable, safeName, targetName } from "./core.mjs";

/** 计算 sha256（十六进制）。 */
export function digestOf(buf) {
	return createHash("sha256").update(buf).digest("hex");
}

/**
 * 原子落盘，**绝不覆盖**已有文件。
 *
 * ⚠️ 为什么不用 `rename`：rename 遇到同名目标会**静默覆盖**。真机实测同一秒内多次上传
 * 同名文件（快捷指令一次发多张 `image.jpg` 就会这样）会互相吞掉，用户只见到一张且毫无提示。
 * `link()` 在目标已存在时报 `EEXIST`，于是可以逐个试序号——既不覆盖也不丢失。
 *
 * @returns 最终文件的绝对路径。
 */
export async function placeFile(partPath, dir, baseName) {
	const dot = baseName.lastIndexOf(".");
	const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
	const ext = dot > 0 ? baseName.slice(dot) : "";
	for (let n = 0; n < 500; n++) {
		const candidate = join(dir, n === 0 ? baseName : `${stem}-${n}${ext}`);
		try {
			await link(partPath, candidate);
			await unlink(partPath).catch(() => {});
			return candidate;
		} catch (error) {
			if (error?.code === "EEXIST") continue;
			throw error;
		}
	}
	throw new Error("无法分配不重名的文件名（同名文件超过 500 个）");
}

/**
 * 落一张照片：建目录 → 写 .part → `link()` 定名 → 写 sidecar。
 *
 * **sidecar 写失败不影响照片落盘成功**——照片才是主角。
 *
 * @param options.rootDir - 用户配置的落地目录（根）。
 * @param options.payload - 照片字节。
 * @param options.name - 客户端给的原名（不可信，会被清洗）。
 * @param options.kind - 嗅探所得格式。
 * @param options.meta - `{ remote, ua, declaredContentType, framing, note }`。
 */
export async function landPhoto({ rootDir, payload, name, kind, meta = {} }) {
	const dayDir = join(rootDir, localDateDir());
	await mkdir(dayDir, { recursive: true });

	const digest = digestOf(payload);
	const base = targetName(name, digest, kind);
	const partPath = join(dayDir, `.part-${digest.slice(0, 12)}-${process.pid}`);

	await writeFile(partPath, payload);
	let full;
	try {
		full = await placeFile(partPath, dayDir, base);
	} catch (error) {
		await unlink(partPath).catch(() => {});
		throw error;
	}
	const info = await stat(full);

	const sidecar = {
		schema: 1,
		file: full.slice(dayDir.length + 1),
		originalName: safeName(name),
		note: typeof meta.note === "string" ? meta.note.slice(0, 500) : "",
		receivedAt: new Date().toISOString(),
		receivedAtLocal: localReadable(),
		bytes: info.size,
		sha256: digest,
		format: kind,
		declaredContentType: meta.declaredContentType ?? "",
		framing: meta.framing ?? "",
		remote: meta.remote ?? "",
		ua: meta.ua ?? "",
	};
	const sidecarPath = `${full.replace(/\.[^.]*$/, "")}.json`;
	try {
		await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
	} catch {
		// 有意忽略：索引写不进去不能连累照片
	}

	return { full, sidecarPath, bytes: info.size, sha256: digest, sidecar };
}
