/**
 * Windows Toast 通知。
 *
 * ⚠️ 三条铁律（本项目 dsh-attention 实测得来，违反任一条都会静默失败）：
 *   1. 必须用 **Windows PowerShell 5.1** 执行（pwsh 7 没有 WinRT 类型投影）
 *   2. 中文 `.ps1` 必须带 UTF-8 BOM —— 本插件绕开这条：脚本是**纯 ASCII**，
 *      中文只走 UTF-8 的 JSON 文件
 *   3. spawn 必须**交互式上下文**且**不 detached / 不 unref**，否则 `0x80073D54`
 *
 * 并且：**通知失败绝不能影响照片落盘**，所以这里所有路径都不抛，只写日志。
 */
import { spawn } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PS51 = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

export function createNotifier({ scriptPath, tempDir, log = () => {} }) {
	let seq = 0;

	return {
		/**
		 * 弹一条通知。**永不抛**：失败只记日志。
		 * @returns Promise<boolean> 是否成功
		 */
		async show(title, message) {
			const payloadPath = join(tempDir, `toast-${process.pid}-${Date.now()}-${seq++}.json`);
			try {
				await mkdir(tempDir, { recursive: true });
				await writeFile(payloadPath, `${JSON.stringify({ title, message })}\n`, "utf8");

				const ok = await new Promise((resolve) => {
					let child;
					try {
						child = spawn(PS51, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, payloadPath], {
							windowsHide: true,
							// 交互式上下文、不 detached、不 unref —— 见文件头第 3 条
							stdio: ["ignore", "pipe", "pipe"],
						});
					} catch (error) {
						log(`[notify] spawn 失败：${error?.message ?? error}`);
						return resolve(false);
					}
					let out = "";
					child.stdout?.on("data", (c) => { out += c.toString(); });
					child.stderr?.on("data", (c) => { out += c.toString(); });
					child.on("error", (error) => {
						log(`[notify] 子进程错误：${error?.message ?? error}`);
						resolve(false);
					});
					child.on("close", (code) => {
						if (code === 0 && out.includes("shown")) return resolve(true);
						log(`[notify] 退出码 ${code}：${out.trim().slice(0, 300)}`);
						resolve(false);
					});
					// 别让一个卡住的 powershell 一直挂着
					setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, 15000).unref?.();
				});
				return ok;
			} catch (error) {
				log(`[notify] 失败：${error?.message ?? error}`);
				return false;
			} finally {
				await unlink(payloadPath).catch(() => {});
			}
		},
	};
}
