window.__ModuleLoader__.load({
	id: "dsh-photo2dsh-by-lan",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// ⛔ 刻意不 require 任何 Harness Client 包（官方 practices 明文禁止：它们会无预告
		// 变更，而抛错的组件会让整块 slot entry 空白）。只 require 基座里的 react。
		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");

		const jsx = jsxRuntime.jsx;
		const jsxs = jsxRuntime.jsxs;

		// ⚠️ 槽位名与 key 是官方契约（dsh-client-ui-plugin-manager README）：
		//    `plugins.bundle.config` 以**组合包的包名**为键，显示在组合包页面的描述与行之间。
		//    key 必须逐字等于 package.json 的 name，否则卡片不出现。
		const SLOT = "plugins.bundle.config";
		const ENTRY_KEY = "dsh-photo2dsh-by-lan";
		const CONFIG_PATH = "/api/photo2dsh-by-lan.config";

		const MB = 1024 * 1024;

		/** 本插件样式：一次性注入 head，类名统一 `dsp-` 前缀。 */
		const STYLE_TEXT = `
.dsp-root { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 8px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); }
.dsp-row { display: flex; flex-direction: column; gap: 6px; }
.dsp-label { font-weight: 600; }
.dsp-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.dsp-input { box-sizing: border-box; width: 100%; height: 34px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 13px; }
.dsp-input:focus { outline: none; border-color: var(--dsw-alias-border-l4); }
.dsp-mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
.dsp-readout { display: flex; align-items: center; gap: 8px; }
.dsp-readout > .dsp-mono { flex: 1; min-width: 0; padding: 7px 9px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); user-select: all; }
.dsp-check { display: flex; align-items: flex-start; gap: 8px; }
.dsp-check input { margin-top: 3px; }
.dsp-actions { display: flex; gap: 8px; }
.dsp-btn { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; height: 32px; padding: 0 14px; border: none; border-radius: var(--dsw-radius-md); cursor: pointer; font-size: 13px; color: var(--dsw-alias-label-primary); background: transparent; }
.dsp-btn:disabled { cursor: not-allowed; opacity: 0.4; }
.dsp-btn-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dsp-btn-ghost { border: 0.5px solid var(--dsw-alias-border-l3); }
.dsp-btn-sm { height: 26px; padding: 0 10px; font-size: 12px; border-radius: var(--dsw-radius-sm); border: 0.5px solid var(--dsw-alias-border-l3); }
.dsp-status { display: flex; align-items: center; gap: 6px; }
.dsp-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dsp-dot-ok { background: var(--dsw-alias-state-success-primary, #34c759); }
.dsp-dot-bad { background: var(--dsw-alias-state-error-primary, #ff3b30); }
.dsp-notice { padding: 7px 10px; border-radius: var(--dsw-radius-sm); font-size: 12px; }
.dsp-notice-ok { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-state-success-primary, #34c759); }
.dsp-notice-error { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-state-error-primary, #ff3b30); }
.dsp-warn { color: var(--dsw-alias-state-warning-primary, #ff9500); }
`;

		let stylesInjected = false;
		/** 注入样式。**绝不抛**：拿不到 document 就静默降级（就地无样式渲染）。 */
		function ensureStyles() {
			if (stylesInjected) return;
			try {
				if (typeof document === "undefined" || document === null) return;
				if (document.getElementById("dsp-photo2dsh-style") !== null) {
					stylesInjected = true;
					return;
				}
				const el = document.createElement("style");
				el.id = "dsp-photo2dsh-style";
				el.textContent = STYLE_TEXT;
				document.head.appendChild(el);
				stylesInjected = true;
			} catch {
				// 静默降级：没有样式也要能改设置
			}
		}

		//#region 快照 store（自包含，不依赖平台 hooks）
		function createStore(initial) {
			let value = initial;
			const listeners = new Set();
			const notify = () => {
				for (const l of [...listeners]) {
					try {
						l();
					} catch {
						// 单个订阅者出错不影响别人
					}
				}
			};
			return {
				getSnapshot: () => value,
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				set(next) {
					value = next;
					notify();
				},
				update(fn) {
					value = fn(value);
					notify();
				},
			};
		}

		const useSyncExternalStore = react.useSyncExternalStore;

		/** 订阅快照。React 18 用原生 useSyncExternalStore，老版本退回 useState。 */
		function useSnapshot(store) {
			if (typeof useSyncExternalStore === "function") {
				return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
			}
			const [value, setValue] = react.useState(store.getSnapshot);
			react.useEffect(() => store.subscribe(() => setValue(store.getSnapshot())), []);
			return value;
		}
		//#endregion

		//#region 状态与草稿
		function emptyShell() {
			return { status: "idle", error: null, state: null, draft: null, saving: false, notice: null };
		}

		/** 由服务端状态生成草稿。上限在界面上按 MB 编辑，避免用户数零。 */
		function draftFromState(state) {
			if (state === null || typeof state !== "object") return null;
			return {
				dir: String(state.dir ?? ""),
				port: String(state.port ?? ""),
				lanIp: String(state.lanIp ?? ""),
				maxMB: String(Math.round((Number(state.maxBytes) || 0) / MB)),
				notify: state.notify !== false,
				requireToken: state.requireToken !== false,
				lanOnly: state.lanOnly !== false,
			};
		}

		/** 草稿 → 请求体。空/非法在这里就拦住，别等服务端报错。 */
		function toRequest(draft) {
			const maxMB = Number(draft.maxMB);
			return {
				dir: draft.dir.trim(),
				port: Number(draft.port),
				lanIp: String(draft.lanIp ?? ""),
				maxBytes: Number.isFinite(maxMB) ? Math.round(maxMB * MB) : undefined,
				notify: draft.notify === true,
				requireToken: draft.requireToken === true,
				lanOnly: draft.lanOnly === true,
			};
		}

		/** 草稿的第一个问题；没有问题返回 null。 */
		function firstProblem(draft) {
			if (draft === null) return "尚未加载配置";
			if (draft.dir.trim() === "") return "落地目录不能为空";
			const port = Number(draft.port);
			if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return "端口必须是 1–65535 的整数";
			const maxMB = Number(draft.maxMB);
			if (!Number.isFinite(maxMB) || maxMB < 0.001 || maxMB > 2048) return "单文件上限应在 0.001–2048 MB 之间";
			return null;
		}

		function applyEdit(store, action) {
			store.update((shell) => {
				if (shell.draft === null) return shell;
				return { ...shell, notice: null, draft: { ...shell.draft, [action.field]: action.value } };
			});
		}
		//#endregion

		//#region 与服务端通信（同源）
		async function loadState(store) {
			try {
				const response = await fetch(CONFIG_PATH, { method: "GET" });
				const payload = await response.json().catch(() => undefined);
				if (payload === null || typeof payload !== "object" || payload.ok !== true) {
					store.update((shell) => ({ ...shell, status: "failed", error: `HTTP ${response.status}` }));
					return;
				}
				store.update((shell) => ({
					...shell,
					status: "ready",
					error: null,
					state: payload,
					draft: draftFromState(payload),
					notice: null,
				}));
			} catch (error) {
				store.update((shell) => ({ ...shell, status: "failed", error: String(error) }));
			}
		}

		async function saveDraft(store) {
			const snapshot = store.getSnapshot();
			if (snapshot.draft === null || snapshot.saving === true) return;
			const problem = firstProblem(snapshot.draft);
			if (problem !== null) {
				store.update((shell) => ({ ...shell, notice: { tone: "error", text: problem } }));
				return;
			}
			store.update((shell) => ({ ...shell, saving: true, notice: null }));
			let response;
			let payload;
			try {
				response = await fetch(CONFIG_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(toRequest(snapshot.draft)),
				});
				payload = await response.json().catch(() => undefined);
			} catch (error) {
				store.update((shell) => ({ ...shell, saving: false, notice: { tone: "error", text: `保存失败：${String(error)}` } }));
				return;
			}
			if (payload === null || typeof payload !== "object" || payload.ok !== true) {
				const text = payload !== null && typeof payload === "object" && typeof payload.message === "string"
					? payload.message
					: `HTTP ${response.status}`;
				store.update((shell) => ({ ...shell, saving: false, notice: { tone: "error", text } }));
				return;
			}
			store.update((shell) => ({
				...shell,
				saving: false,
				status: "ready",
				error: null,
				state: payload,
				draft: draftFromState(payload),
				notice: { tone: "ok", text: "已保存" },
			}));
		}

		function copyText(text) {
			try {
				if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
					return navigator.clipboard.writeText(text).then(() => true, () => false);
				}
			} catch {
				// 落到下面的 false
			}
			return Promise.resolve(false);
		}
		//#endregion

		//#region 界面
		function summaryText(snapshot) {
			const state = snapshot?.state;
			if (state === null || state === undefined) return "未加载";
			const received = Number(state.received) || 0;
			const listening = state.listening === true ? "监听中" : "未监听";
			return `${listening} · ${state.port} · 已收 ${received} 张 · ${state.dir}`;
		}

		function Readout(props) {
			const [copied, setCopied] = react.useState(false);
			return jsxs("div", {
				className: "dsp-row",
				children: [
					jsx("div", { className: "dsp-label", children: props.label }),
					jsxs("div", {
						className: "dsp-readout",
						children: [
							jsx("span", { className: "dsp-mono", children: props.value }),
							jsx("button", {
								type: "button",
								className: "dsp-btn dsp-btn-sm",
								onClick: () => {
									Promise.resolve(copyText(String(props.value))).then(
										(ok) => setCopied(ok === true),
										() => setCopied(false),
									).catch(() => {});
								},
								children: copied ? "已复制" : "复制",
							}),
						],
					}),
					props.hint ? jsx("div", { className: "dsp-hint", children: props.hint }) : null,
				],
			});
		}

		function PhotoInboxCard(props) {
			ensureStyles();
			const store = props.store;
			const snapshot = useSnapshot(store);
			const loadedRef = react.useRef(false);
			react.useEffect(() => {
				if (loadedRef.current) return;
				loadedRef.current = true;
				try {
					props.load();
				} catch (error) {
					console.error("[photo2dsh] 首次加载抛出（已忽略）：", error);
				}
			}, []);

			if (props.view === "summary") return summaryText(snapshot);

			const draft = snapshot?.draft ?? null;
			const state = snapshot?.state ?? null;
			const problem = firstProblem(draft);
			const busy = snapshot?.saving === true;
			const set = (field) => (event) => {
				const value = field === "notify" || field === "requireToken" ? event.target.checked : event.target.value;
				props.edit({ field, value });
			};

			return jsxs("div", {
				className: "dsp-root",
				children: [
					state === null
						? jsx("div", { className: "dsp-hint", children: snapshot?.status === "failed" ? `读取配置失败：${snapshot?.error ?? ""}` : "正在读取配置…" })
						: jsxs("div", {
							className: "dsp-status",
							children: [
								jsx("span", { className: `dsp-dot ${state.listening === true ? "dsp-dot-ok" : "dsp-dot-bad"}` }),
								jsx("span", {
									children: state.listening === true
										? `监听中 ${state.host}:${state.boundPort ?? state.port}`
										: `未监听（${state.listenError ?? "原因未知"}）`,
								}),
								jsx("span", { className: "dsp-hint", children: `· 已收 ${state.received} 张` }),
							],
						}),

					state?.lastUpload
						? jsx("div", {
							className: "dsp-hint",
							children: `最近一张：${state.lastUpload.file}（${Math.round((state.lastUpload.bytes ?? 0) / 1024)} KB · ${state.lastUpload.atLocal ?? ""} · 来自 ${state.lastUpload.remote ?? "?"}）`,
						})
						: null,

					draft === null
						? null
						: jsxs(react.Fragment, {
							children: [
								jsxs("div", {
									className: "dsp-row",
									children: [
										jsx("div", { className: "dsp-label", children: "落地目录" }),
										jsx("input", {
											className: "dsp-input dsp-mono",
											type: "text",
											value: draft.dir,
											placeholder: "例如 D:\\DSH\\Day1\\inbox",
											onChange: set("dir"),
										}),
										jsx("div", {
											className: "dsp-hint",
											children: "照片会落到该目录下的 <日期>\\ 子目录。想让 Agent 直接读到，建议填当前会话工作区内的目录。",
										}),
									],
								}),

								jsxs("div", {
									className: "dsp-row",
									children: [
										jsx("div", { className: "dsp-label", children: "端口" }),
										jsx("input", {
											className: "dsp-input",
											type: "number",
											min: 1,
											max: 65535,
											value: draft.port,
											onChange: set("port"),
										}),
										jsx("div", {
											className: "dsp-hint dsp-warn",
											children: "改端口后需要给新端口放行防火墙（netsh advfirewall firewall add rule name=\"Photo2DSH\" dir=in action=allow protocol=TCP localport=<新端口> profile=any）",
										}),
									],
								}),

								jsxs("div", {
									className: "dsp-row",
									children: [
										jsx("div", { className: "dsp-label", children: "单文件上限（MB）" }),
										jsx("input", {
											className: "dsp-input",
											type: "number",
											min: 1,
											max: 2048,
											value: draft.maxMB,
											onChange: set("maxMB"),
										}),
									],
								}),

								jsx("label", {
									className: "dsp-check",
									children: [
										jsx("input", { type: "checkbox", checked: draft.notify === true, onChange: set("notify") }),
										jsx("span", { children: "收到照片后弹 Windows 通知" }),
									],
								}),

								jsx("label", {
									className: "dsp-check",
									children: [
										jsx("input", { type: "checkbox", checked: draft.lanOnly === true, onChange: set("lanOnly") }),
										jsxs("span", {
											children: [
												"只接受局域网来源（建议保持开启）",
												jsx("div", {
													className: "dsp-hint",
													children: "关掉 token 时，这是唯一的来源闸门：非私网地址（10./192.168./172.16-31.）的上传一律拒收。/ping 与 /health 不受影响，仍可用于排查连通性。",
												}),
											],
										}),
									],
								}),

								jsx("label", {
									className: "dsp-check",
									children: [
										jsx("input", { type: "checkbox", checked: draft.requireToken === true, onChange: set("requireToken") }),
										jsxs("span", {
											children: [
												"要求 token",
												jsx("div", {
													className: "dsp-hint dsp-warn",
													children: "关掉后，同一局域网内的任何设备都能往这台机器写文件。"
														+ "互联网上的网页打不进来（跨源请求会被 Origin 检查拒掉，那是独立的第二道防线），"
														+ "但仍建议只在自有可信网络里关闭。",
												}),
											],
										}),
									],
								}),
							],
						}),

					state === null
						? null
						: jsxs("div", {
							className: "dsp-row",
							children: [
								jsx("div", { className: "dsp-label", children: "手机要连的 IP" }),
								jsxs("select", {
									className: "dsp-input",
									value: draft === null ? "" : draft.lanIp,
									onChange: set("lanIp"),
									children: [
										jsx("option", {
											value: "",
											children: `自动（当前：${state.lanAuto ?? "未检测到可用网卡"}）`,
										}),
										...(state.lanCandidates ?? []).map((c) => jsx("option", {
											value: c.address,
											children: `${c.address}　${c.adapter}${c.virtual === true ? "（虚拟网卡）" : ""}`,
										}, c.address)),
										// 保存过的地址若当前没检测到（拔网线/换网卡），也列出来，避免被静默改掉
										draft !== null && draft.lanIp !== "" && !(state.lanCandidates ?? []).some((c) => c.address === draft.lanIp)
											? jsx("option", { value: draft.lanIp, children: `${draft.lanIp}（已保存，当前未检测到）` })
											: null,
									],
								}),
								jsx("div", {
									className: "dsp-hint",
									children: "自动枚举会跳过 Hyper-V / VMware / WSL 等虚拟网卡，并优先 192.168 网段。若手机连不上，多半是选错了网卡 —— 在这里手动指定即可。",
								}),
							],
						}),

					state === null
						? null
						: jsx(Readout, {
							label: "手机端要填的地址",
							value: state.uploadUrl,
							hint: "填进快捷指令的「获取 URL 内容」。注意地址里必须带 /u/<token> 这一段。",
						}),

					state === null
						? null
						: jsx(Readout, { label: "token", value: state.token }),

					state?.problems?.length
						? jsx("div", { className: "dsp-notice dsp-notice-error", children: state.problems.join("；") })
						: null,

					snapshot?.notice
						? jsx("div", {
							className: `dsp-notice ${snapshot.notice.tone === "ok" ? "dsp-notice-ok" : "dsp-notice-error"}`,
							children: snapshot.notice.text,
						})
						: null,

					jsxs("div", {
						className: "dsp-actions",
						children: [
							jsx("button", {
								type: "button",
								className: "dsp-btn dsp-btn-ghost",
								disabled: busy,
								onClick: () => {
									try {
										props.discard();
									} catch (error) {
										console.error("[photo2dsh] 放弃修改抛出（已忽略）：", error);
									}
								},
								children: "放弃修改",
							}),
							jsx("button", {
								type: "button",
								className: "dsp-btn dsp-btn-primary",
								disabled: busy || problem !== null,
								onClick: () => {
									try {
										props.save();
									} catch (error) {
										console.error("[photo2dsh] 保存抛出（已忽略）：", error);
									}
								},
								children: busy ? "保存中…" : "保存",
							}),
						],
					}),

					state === null
						? null
						: jsx("div", {
							className: "dsp-hint",
							children: `配置文件：${state.configPath}　日志：${state.logPath}`,
						}),
				],
			});
		}
		//#endregion

		//#region 接线
		/**
		 * 挂载配置卡片。
		 *
		 * ⚠️ 两处都必须 try/catch，且**只用嵌套注入**：
		 * 裸的 `ctx.slots` 在服务没就绪时是 undefined，`.inject` 会 TypeError 打穿 apply
		 * ⇒ client entry 变 failed ⇒ 撞上"每条 client entry 都必须 active"的全有全无
		 * 启动门禁 ⇒ **整个 DSH 起不来**（本项目 dsh-attention 真实事故）。
		 */
		function apply(ctx) {
			const store = createStore(emptyShell());
			const api = {
				store,
				load: () => {
					loadState(store).catch((error) => console.error("[photo2dsh] 加载失败（已忽略）：", error));
				},
				save: () => {
					saveDraft(store).catch((error) => console.error("[photo2dsh] 保存失败（已忽略）：", error));
				},
				discard: () => {
					store.update((shell) => ({ ...shell, draft: draftFromState(shell.state), notice: null }));
				},
				edit: (action) => applyEdit(store, action),
			};

			try {
				ctx.inject(["slots"], (scope) => {
					try {
						scope.slots.inject(SLOT, () =>
							scope.slots.register(
								{
									name: SLOT,
									key: ENTRY_KEY,
									inject: () => api,
								},
								PhotoInboxCard,
							),
						);
					} catch (error) {
						console.error("[photo2dsh] 配置卡片注册失败（仅少一张卡片，不影响启动）：", error);
					}
				});
			} catch (error) {
				console.error("[photo2dsh] 嵌套注入 slots 服务失败（不注册卡片，不影响启动）：", error);
			}
		}
		//#endregion

		exports.name = "photo2dsh-by-lan-client";
		exports.inject = [];
		exports.apply = apply;
		// 只读出口：离线验证台直接断言纯逻辑，不必穿过 React
		exports.__internals = {
			createStore,
			emptyShell,
			draftFromState,
			toRequest,
			firstProblem,
			applyEdit,
			loadState,
			saveDraft,
			summaryText,
			SLOT,
			ENTRY_KEY,
			CONFIG_PATH,
		};

		return module.exports;
	},
});
