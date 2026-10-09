window.__ModuleLoader__.load({
	id: "dsh-plugin-zt-remote",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let jsx_runtime = require("react/jsx-runtime");
		const jsx = jsx_runtime.jsx;
		const jsxs = jsx_runtime.jsxs;

		/*#region panel identity*/
		/** Sidebar entry id; `slots.register({ name: "main" })` repeats it as its key. */
		const PANEL_ID = "zt-remote";

		/**
		 * Operator-key request header, read by the plugin's `admitOperator`.
		 *
		 * The standalone page and the operator routes use the same name, so the panel
		 * and `assets/manage.html` drive one server contract.
		 */
		const OPERATOR_KEY_HEADER = "x-zt-operator-key";

		/**
		 * API prefix the panel calls.
		 *
		 * An empty string means "the document origin", which is the surface the page
		 * was served from and covers both deployments:
		 *
		 * - `GET /workspaces`, `POST /workspaces` — plugin `server.js`, workspace roster
		 *   and `{ path }` creation, mounted at the origin root for both the ZeroTier
		 *   listener and the Host bridge.
		 * - `GET /operator/devices`, `POST /operator/revoke` — plugin `server.js`,
		 *   operator-key device roster and revocation (`{ deviceId }`, or no body for
		 *   every device).
		 *
		 * A phone loads this panel from the plugin's own listener, so those are literal
		 * same-origin routes and the device cookie rides along. A desktop page loads it
		 * from the Host origin, where `lib/web-bridge.js` answers the same four routes
		 * through `ctx.webServer` and applies the operator credential in-process.
		 */
		const API_ROOT = "";
		/*#endregion*/

		/*#region formatting helpers*/
		/**
		 * Render one unknown failure as text.
		 * @param {unknown} error - thrown value.
		 * @returns a message that is never the string "undefined".
		 */
		function failureText(error) {
			if (error === null || error === undefined) return "未知错误";
			if (typeof error === "string") return error;
			if (typeof error === "object" && typeof error.message === "string" && error.message !== "") return error.message;
			try {
				return JSON.stringify(error);
			} catch {
				return String(error);
			}
		}

		/**
		 * Read the message out of the plugin's `{ ok: false, error: { code, message } }` body.
		 * @param {{ error?: { code?: string, message?: string } } | null} payload - decoded body.
		 * @param {number} status - HTTP status, used when the body names nothing.
		 * @returns human-readable failure text.
		 */
		function apiFailure(payload, status) {
			const error = payload === null || typeof payload !== "object" ? undefined : payload.error;
			const parts = [];
			if (error !== undefined && typeof error.code === "string" && error.code !== "") parts.push(error.code);
			if (error !== undefined && typeof error.message === "string" && error.message !== "") parts.push(error.message);
			if (parts.length > 0) return parts.join(" ");
			return `HTTP ${status}`;
		}

		/**
		 * Issue one request against the plugin surface and decode its JSON envelope.
		 *
		 * The panel never inspects cookies: a phone carries the plugin's device cookie
		 * implicitly, and the desktop bridge authenticates in the Host process.
		 *
		 * @param {string} path - route below {@link API_ROOT}.
		 * @param {{ method?: string, body?: unknown, operatorKey?: string }} [options] - request detail.
		 * @returns a settled result; transport and decode failures are values, not throws.
		 */
		async function callApi(path, options) {
			const init = { method: options?.method ?? "GET", headers: {} };
			const operatorKey = options?.operatorKey;
			if (typeof operatorKey === "string" && operatorKey !== "") init.headers[OPERATOR_KEY_HEADER] = operatorKey;
			if (options?.body !== undefined) {
				init.headers["content-type"] = "application/json";
				init.body = JSON.stringify(options.body);
			}
			let response;
			try {
				response = await fetch(`${API_ROOT}${path}`, init);
			} catch (error) {
				return { ok: false, status: 0, error: `无法连接远程服务：${failureText(error)}` };
			}
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			if (response.status === 401 || response.status === 403) {
				return { ok: false, status: response.status, authRequired: true, error: apiFailure(payload, response.status) };
			}
			if (!response.ok) return { ok: false, status: response.status, error: apiFailure(payload, response.status) };
			if (payload === null || payload.ok !== true) return { ok: false, status: response.status, error: apiFailure(payload, response.status) };
			return { ok: true, status: response.status, value: payload.value };
		}
		/*#endregion*/

		/*#region styles*/
		/** Panel palette and spacing, all from the host theme. */
		const THEME = {
			panel: {
				boxSizing: "border-box",
				height: "100%",
				overflowY: "auto",
				padding: "24px 28px 40px",
				background: "var(--dsw-alias-bg-base)",
				color: "var(--dsw-alias-label-primary)",
				font: "13px/1.6 inherit",
			},
			inner: { maxWidth: "860px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "16px" },
			heading: { margin: "0 0 4px", fontSize: "18px", fontWeight: 600 },
			lede: { margin: 0, color: "var(--dsw-alias-label-secondary)" },
			card: {
				border: "1px solid var(--dsw-alias-border-l3)",
				borderRadius: "var(--dsw-radius-sm, 8px)",
				padding: "14px 16px",
				display: "flex",
				flexDirection: "column",
				gap: "10px",
			},
			cardTitle: { margin: 0, fontSize: "14px", fontWeight: 600 },
			note: { margin: 0, color: "var(--dsw-alias-label-secondary)" },
			row: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
			input: {
				flex: "1 1 260px",
				minWidth: "180px",
				boxSizing: "border-box",
				padding: "7px 10px",
				font: "inherit",
				color: "var(--dsw-alias-label-primary)",
				background: "var(--dsw-alias-bg-base)",
				border: "1px solid var(--dsw-alias-border-l3)",
				borderRadius: "var(--dsw-radius-sm, 8px)",
			},
			button: {
				font: "inherit",
				padding: "7px 14px",
				cursor: "pointer",
				color: "var(--dsw-alias-label-primary)",
				background: "transparent",
				border: "1px solid var(--dsw-alias-border-l3)",
				borderRadius: "var(--dsw-radius-sm, 8px)",
			},
			primaryButton: {
				font: "inherit",
				padding: "7px 14px",
				cursor: "pointer",
				color: "var(--dsw-alias-bg-base)",
				background: "var(--dsw-alias-brand-primary)",
				border: "1px solid var(--dsw-alias-brand-primary)",
				borderRadius: "var(--dsw-radius-sm, 8px)",
			},
			linkButton: {
				font: "inherit",
				padding: "2px 8px",
				cursor: "pointer",
				color: "var(--dsw-alias-brand-primary)",
				background: "transparent",
				border: "1px solid var(--dsw-alias-border-l3)",
				borderRadius: "var(--dsw-radius-sm, 8px)",
			},
			list: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "6px" },
			item: {
				display: "flex",
				gap: "10px",
				alignItems: "baseline",
				justifyContent: "space-between",
				borderBottom: "1px solid var(--dsw-alias-border-l3)",
				paddingBottom: "6px",
			},
			itemMain: { minWidth: 0, overflowWrap: "anywhere" },
			itemTitle: { fontWeight: 600 },
			itemMeta: { color: "var(--dsw-alias-label-secondary)", overflowWrap: "anywhere" },
		}

		/** Tone of one inline status line. */
		const STATUS_TONE = {
			ok: { color: "var(--dsw-alias-brand-primary)" },
			bad: { color: "var(--dsw-alias-label-primary)" },
			plain: { color: "var(--dsw-alias-label-secondary)" },
		}
		/*#endregion*/

		/*#region host components*/
		/** Decorative panel glyph, drawn inline so the bundle requires no icon package. */
		function ZtRemoteIcon(props) {
			const size = typeof props.size === "number" ? props.size : 16;
			return jsx("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				focusable: "false",
				children: jsxs("g", {
					children: [
						jsx("circle", { cx: 8, cy: 8, r: 5.4 }),
						jsx("ellipse", { cx: 8, cy: 8, rx: 2.4, ry: 5.4 }),
						jsx("path", { d: "M2.8 6.1h10.4" }),
						jsx("path", { d: "M2.8 9.9h10.4" }),
					],
				}),
			});
		}

		/** One titled card. */
		function Section(props) {
			return jsxs("section", {
				style: THEME.card,
				children: [
					jsx("h2", { style: THEME.cardTitle, children: props.title }),
					props.note === undefined ? null : jsx("p", { style: THEME.note, children: props.note }),
					props.children,
				],
			});
		}

		/** One inline status line; renders nothing when there is no text. */
		function Status(props) {
			if (typeof props.text !== "string" || props.text === "") return null;
			return jsx("p", { role: "status", style: { ...THEME.note, ...(STATUS_TONE[props.tone] ?? STATUS_TONE.plain) }, children: props.text });
		}

		/** One list row: text on the left, an optional action on the right. */
		function Row(props) {
			return jsxs("li", {
				style: THEME.item,
				children: [
					jsxs("span", {
						style: THEME.itemMain,
						children: [
							jsx("span", { style: THEME.itemTitle, children: props.title }),
							props.meta === undefined || props.meta === "" ? null : jsx("span", { style: THEME.itemMeta, children: ` — ${props.meta}` }),
						],
					}),
					props.action === undefined ? null : props.action,
				],
			});
		}
		/*#endregion*/

		/*#region phone typography*/
		/** Id on the stylesheet link this plugin owns, so remounts do not duplicate it. */
		const PHONE_STYLE_ID = "dsh-zt-remote-phone-css";

		/** Document head, or undefined outside a document (the test harness). */
		function documentHead() {
			const view = typeof globalThis === "undefined" ? void 0 : globalThis.document;
			return view === void 0 ? void 0 : view.head;
		}

		/**
		 * Link the phone typography sheet into the page once.
		 *
		 * The sheet only tightens session-row type below 768px, so it cannot disturb a
		 * full-width desktop window. This owns exactly one element and removes only that
		 * element on unmount; it touches no other part of the document.
		 *
		 * @returns a disposer for the element this call added, or undefined when absent.
		 */
		function mountPhoneTypography() {
			const head = documentHead();
			if (head === void 0 || head.querySelector(`#${PHONE_STYLE_ID}`) !== null) return void 0;
			const link = globalThis.document.createElement("link");
			link.id = PHONE_STYLE_ID;
			link.rel = "stylesheet";
			link.href = "/ui/phone.css";
			head.appendChild(link);
			return () => {
				link.remove();
			};
		}
		/*#endregion*/

		/*#region main panel*/
		/**
		 * Remote-surface panel: the workspace roster, typed-path workspace creation, and
		 * the device roster with revocation.
		 *
		 * Every network result is component state, so a failed call renders an inline
		 * message; the component itself never throws.
		 *
		 * @param {{ usePanelInfo?: unknown }} props - host slot props; only theme-bound markup is used.
		 * @returns the panel tree.
		 */
		function ZtRemotePanel(props) {
			const [workspaces, setWorkspaces] = react.useState([]);
			const [workspacesNote, setWorkspacesNote] = react.useState("正在读取工作区…");
			const [workspacesTone, setWorkspacesTone] = react.useState("plain");
			const [path, setPath] = react.useState("");
			const [addNote, setAddNote] = react.useState("");
			const [addTone, setAddTone] = react.useState("plain");
			const [adding, setAdding] = react.useState(false);
			const [operatorKey, setOperatorKey] = react.useState("");
			const [devices, setDevices] = react.useState([]);
			const [devicesNote, setDevicesNote] = react.useState("填写操作者密钥后读取接入设备。");
			const [devicesTone, setDevicesTone] = react.useState("plain");
			const [revoking, setRevoking] = react.useState("");
			const alive = react.useRef(true);

			react.useEffect(() => {
				const removePhoneTypography = mountPhoneTypography();
				return () => {
					removePhoneTypography?.();
				};
			}, []);

			react.useEffect(() => () => {
				alive.current = false;
			}, []);

			/** Publish state only while this component is still mounted. */
			const settle = (action) => {
				if (alive.current) action();
			};

			/** Read the workspace roster. */
			const loadWorkspaces = react.useCallback(async () => {
				const result = await callApi("/workspaces");
				settle(() => {
					if (result.ok) {
						const list = Array.isArray(result.value?.workspaces) ? result.value.workspaces : [];
						setWorkspaces(list);
						setWorkspacesTone("plain");
						setWorkspacesNote(list.length === 0 ? "尚未登记任何工作区。" : `共 ${list.length} 个工作区。`);
						return;
					}
					setWorkspaces([]);
					setWorkspacesTone("bad");
					setWorkspacesNote(result.authRequired === true ? "读取工作区需要先通过远程面板打开本页（设备凭据）。" : `读取工作区失败：${result.error}`);
				});
			}, []);

			react.useEffect(() => {
				void loadWorkspaces();
			}, [loadWorkspaces]);

			/** Create one workspace from the typed host path. */
			const addWorkspace = react.useCallback(async () => {
				const trimmed = path.trim();
				if (trimmed === "") {
					setAddTone("bad");
					setAddNote("请先填写运行 dsh 的电脑上的绝对路径。");
					return;
				}
				setAdding(true);
				setAddTone("plain");
				setAddNote("正在添加…");
				const result = await callApi("/workspaces", { method: "POST", body: { path: trimmed } });
				settle(() => setAdding(false));
				if (!result.ok) {
					settle(() => {
						setAddTone("bad");
						setAddNote(result.authRequired === true ? "添加工作区需要先通过远程面板打开本页（设备凭据）。" : `添加失败：${result.error}`);
					});
					return;
				}
				const created = result.value?.workspace;
				const shown = typeof created?.path === "string" && created.path !== "" ? created.path : trimmed;
				settle(() => {
					setPath("");
					setAddTone("ok");
					setAddNote(result.value?.created === true ? `已添加：${shown}` : `该路径已登记：${shown}`);
				});
				await loadWorkspaces();
			}, [path, loadWorkspaces]);

			/** Read the device roster with the operator key. */
			const loadDevices = react.useCallback(async () => {
				const key = operatorKey.trim();
				if (key === "") {
					setDevicesTone("bad");
					setDevicesNote("请先填写操作者密钥（运行 dsh 的电脑上的 pairing.txt 第二行）。");
					return;
				}
				setDevicesTone("plain");
				setDevicesNote("正在读取接入设备…");
				const result = await callApi("/operator/devices", { operatorKey: key });
				settle(() => {
					if (!result.ok) {
						setDevices([]);
						setDevicesTone("bad");
						setDevicesNote(result.authRequired === true ? "操作者密钥不正确。" : `读取设备失败：${result.error}`);
						return;
					}
					const list = Array.isArray(result.value?.devices) ? result.value.devices : [];
					setDevices(list);
					setDevicesTone("plain");
					setDevicesNote(list.length === 0 ? "当前没有接入设备。" : `共 ${list.length} 台接入设备。`);
				});
			}, [operatorKey]);

			/** Revoke one device, or every device when `deviceId` is absent. */
			const revoke = react.useCallback(
				async (deviceId) => {
					const key = operatorKey.trim();
					if (key === "") {
						setDevicesTone("bad");
						setDevicesNote("请先填写操作者密钥。");
						return;
					}
					setRevoking(deviceId ?? "all");
					setDevicesTone("plain");
					setDevicesNote(deviceId === undefined ? "正在撤销全部设备…" : "正在撤销该设备…");
					const result = await callApi("/operator/revoke", {
						method: "POST",
						operatorKey: key,
						body: deviceId === undefined ? {} : { deviceId },
					});
					const removed = result.ok ? result.value?.removed : undefined;
					const removedName = typeof removed?.name === "string" ? removed.name : undefined;
					settle(() => {
						setRevoking("");
						setDevicesTone(result.ok ? "ok" : "bad");
						if (!result.ok) {
							setDevicesNote(result.authRequired === true ? "操作者密钥不正确。" : `撤销失败：${result.error}`);
							return;
						}
						/* The outcome stays on screen: the row leaves the list locally, so a
						   second read cannot overwrite the confirmation. */
						setDevices((current) => (deviceId === undefined ? [] : current.filter((device) => device?.id !== deviceId)));
						if (deviceId === undefined) setDevicesNote("已撤销全部接入设备。");
						else setDevicesNote(removedName === undefined ? "已撤销该设备。" : `已撤销设备：${removedName}`);
					});
				},
				[operatorKey],
			);

			const busy = revoking !== "";

			return jsxs("div", {
				style: THEME.panel,
				"data-zt-remote-panel": "",
				children: jsxs("div", {
					style: THEME.inner,
					children: [
						jsxs("header", {
							children: [
								jsx("h1", { style: THEME.heading, children: "远程管理" }),
								jsx("p", {
									style: THEME.lede,
									children:
										"ZeroTier 远程接入面：登记工作区、按路径添加工作区、查看并撤销接入设备。配置面不在此暴露，操作者密钥仅用于设备名册。",
								}),
							],
						}),
						jsxs(Section, {
							title: "已登记工作区",
							note: "与远程页面 /ui/manage 读取同一份工作区名册。",
							children: [
								workspaces.length === 0
									? null
									: jsx("ul", {
											style: THEME.list,
											children: workspaces.map((workspace, index) =>
												jsx(
													Row,
													{
														title: workspace?.title ?? workspace?.path ?? workspace?.workspaceId ?? `工作区 ${index + 1}`,
														meta: [
															typeof workspace?.path === "string" ? workspace.path : "",
															typeof workspace?.sessionCount === "number" ? `${workspace.sessionCount} 个会话` : "",
														]
															.filter((part) => part !== "")
															.join(" · "),
													},
													typeof workspace?.workspaceId === "string" ? workspace.workspaceId : `workspace-${index}`,
												),
											),
										}),
								jsx(Status, { text: workspacesNote, tone: workspacesTone }),
								jsx("div", {
									style: THEME.row,
									children: jsx("button", {
										type: "button",
										style: THEME.button,
										onClick: () => {
											void loadWorkspaces();
										},
										children: "重新读取",
									}),
								}),
							],
						}),
						jsxs(Section, {
							title: "按路径添加工作区",
							note: "远程无法使用系统目录选择器（它会在运行 dsh 的电脑上弹窗），请直接输入或粘贴该电脑上的绝对路径。",
							children: [
								jsxs("div", {
									style: THEME.row,
									children: [
										jsx("input", {
											style: THEME.input,
											type: "text",
											value: path,
											placeholder: "D:\projects 或 C:\\Users\\me\\work",
											"aria-label": "工作区绝对路径",
											onChange: (event) => {
												setPath(event.target.value);
											},
											onKeyDown: (event) => {
												if (event.key !== "Enter" || adding) return;
												event.preventDefault();
												void addWorkspace();
											},
										}),
										jsx("button", {
											type: "button",
											style: THEME.primaryButton,
											disabled: adding,
											onClick: () => {
												void addWorkspace();
											},
											children: adding ? "添加中…" : "添加",
										}),
									],
								}),
								jsx(Status, { text: addNote, tone: addTone }),
							],
						}),
						jsxs(Section, {
							title: "接入设备",
							note: `需要操作者密钥：在运行 dsh 的电脑上查看 ~/.dsh/plugin-data/dsh-plugin-zt-remote/pairing.txt 第二行。请求以 ${OPERATOR_KEY_HEADER} 头发送。`,
							children: [
								jsxs("div", {
									style: THEME.row,
									children: [
										jsx("input", {
											style: THEME.input,
											type: "password",
											value: operatorKey,
											placeholder: "operator key",
											"aria-label": "操作者密钥",
											autoComplete: "off",
											onChange: (event) => {
												setOperatorKey(event.target.value);
											},
											onKeyDown: (event) => {
												if (event.key !== "Enter") return;
												event.preventDefault();
												void loadDevices();
											},
										}),
										jsx("button", {
											type: "button",
											style: THEME.button,
											onClick: () => {
												void loadDevices();
											},
											children: "查看设备",
										}),
										jsx("button", {
											type: "button",
											style: THEME.button,
											disabled: busy,
											onClick: () => {
												void revoke(undefined);
											},
											children: revoking === "all" ? "撤销中…" : "全部撤销",
										}),
									],
								}),
								devices.length === 0
									? null
									: jsx("ul", {
											style: THEME.list,
											children: devices.map((device, index) =>
												jsx(
													Row,
													{
														title: device?.name ?? `设备 ${index + 1}`,
														meta: typeof device?.lastSeenAt === "string" && device.lastSeenAt !== "" ? `最近使用 ${device.lastSeenAt}` : "尚未使用",
														action: jsx("button", {
															type: "button",
															style: THEME.linkButton,
															disabled: busy,
															onClick: () => {
																void revoke(typeof device?.id === "string" ? device.id : undefined);
															},
															children: revoking === device?.id ? "撤销中…" : "撤销",
														}),
													},
													typeof device?.id === "string" ? device.id : `device-${index}`,
												),
											),
										}),
								jsx(Status, { text: devicesNote, tone: devicesTone }),
							],
						}),
					],
				}),
			});
		}
		/*#endregion*/

		/*#region registration*/
		/**
		 * Register the sidebar entry and the main-area panel.
		 *
		 * The whole body is guarded: a plugin whose activation throws takes the Web boot
		 * down with it, and a missing icon is a far better outcome than a page that does
		 * not start. The failure is reported to the console for diagnosis.
		 *
		 * @param {object} ctx - browser plugin context; `ctx.slots` is the only service read.
		 */
		function apply(ctx) {
			try {
				if (ctx === void 0 || ctx.slots === void 0) {
					console.error("[dsh-plugin-zt-remote] the slots service is unavailable; the sidebar entry is skipped");
					return;
				}
				ctx.slots.inject("sidebar.panellist", () =>
					ctx.slots.register(
						{
							name: "sidebar.panellist",
							id: PANEL_ID,
							order: 10,
							label: "远程管理",
						},
						ZtRemoteIcon,
					),
				);
				ctx.slots.inject("main", () =>
					ctx.slots.register(
						{
							name: "main",
							key: PANEL_ID,
						},
						ZtRemotePanel,
					),
				);
			} catch (error) {
				console.error("[dsh-plugin-zt-remote] registration failed", error);
			}
		}
		/*#endregion*/

		exports.apply = apply;
		exports.inject = ["slots"];
		exports.PANEL_ID = PANEL_ID;
		return module.exports;
	},
});
