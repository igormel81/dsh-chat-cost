window.__ModuleLoader__.load({
	id: "dsh-chat-cost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		/**
		 * dsh-chat-cost — Client half.
		 *
		 * The Host half owns the arithmetic: it walks the session tree (this chat
		 * plus every subagent session it spawned), prices each session from the
		 * bundled multi-provider catalog and appends the JSONL cost log. This half
		 * renders: it asks the Host for a summary of the current session tree and
		 * shows the readout next to the shipped token stats line.
		 *
		 * When the Host route is unavailable the widget degrades to this session's
		 * raw token buckets and says so, instead of inventing a price. One pricing
		 * implementation exists, and it lives on the Host.
		 *
		 * Language: plugin config, then the harness locale, then the browser
		 * language. The harness itself offers only en/zh, so the browser signal is
		 * what makes Russian reachable.
		 */
		const name = "dsh-chat-cost";
		const inject = ["connection"];
		const SUMMARY_PATH = "/api/plugins/dsh-chat-cost/summary";
		const REFRESH_MS = 30000;
		const LANGUAGES = ["en", "zh", "ru"];
		const FALLBACK_LANGUAGE = "en";

		/** UI strings, one entry per supported language. Keys must stay in sync. */
		const STRINGS = {
			en: {
				hostDown: "cost: \u2014",
				hostDownTip: "The Host half of dsh-chat-cost did not answer \u2014 showing this session's token buckets only.",
				title: "Estimated token cost (bundled provider catalog)",
				self: (usd) => "this chat: $" + usd,
				subagents: (usd, count) => "subagents (" + count + "): $" + usd,
				tree: (usd) => "session tree total: $" + usd,
				tokens: (t) => "tokens \u2014 input " + t.uncachedInput + " \u00b7 cache read " + t.cacheRead + " \u00b7 cache write " + t.cacheWrite + " \u00b7 output " + t.output,
				models: (list) => "models: " + list,
				unpriced: (count) => count + " session(s) have no catalog price and are excluded from the totals",
				log: (path) => "cost log: " + path,
				refresh: "Click to refresh"
			},
			zh: {
				hostDown: "\u8d39\u7528\uff1a\u2014",
				hostDownTip: "dsh-chat-cost \u7684\u5bbf\u4e3b\u7aef\u672a\u54cd\u5e94 \u2014\u2014 \u4ec5\u663e\u793a\u672c\u4f1a\u8bdd\u7684 token \u7edf\u8ba1\u3002",
				title: "token \u8d39\u7528\u4f30\u7b97\uff08\u5185\u7f6e\u4f9b\u5e94\u5546\u4ef7\u683c\u76ee\u5f55\uff09",
				self: (usd) => "\u672c\u5bf9\u8bdd\uff1a$" + usd,
				subagents: (usd, count) => "\u5b50\u4ee3\u7406\uff08" + count + "\uff09\uff1a$" + usd,
				tree: (usd) => "\u4f1a\u8bdd\u6811\u5408\u8ba1\uff1a$" + usd,
				tokens: (t) => "token \u2014\u2014 \u8f93\u5165 " + t.uncachedInput + " \u00b7 \u7f13\u5b58\u8bfb\u53d6 " + t.cacheRead + " \u00b7 \u7f13\u5b58\u5199\u5165 " + t.cacheWrite + " \u00b7 \u8f93\u51fa " + t.output,
				models: (list) => "\u6a21\u578b\uff1a" + list,
				unpriced: (count) => "\u6709 " + count + " \u4e2a\u4f1a\u8bdd\u5728\u76ee\u5f55\u4e2d\u6ca1\u6709\u4ef7\u683c\uff0c\u672a\u8ba1\u5165\u5408\u8ba1",
				log: (path) => "\u8d39\u7528\u65e5\u5fd7\uff1a" + path,
				refresh: "\u70b9\u51fb\u5237\u65b0"
			},
			ru: {
				hostDown: "\u0441\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c: \u2014",
				hostDownTip: "\u0425\u043e\u0441\u0442-\u0447\u0430\u0441\u0442\u044c dsh-chat-cost \u043d\u0435 \u043e\u0442\u0432\u0435\u0442\u0438\u043b\u0430 \u2014 \u043f\u043e\u043a\u0430\u0437\u044b\u0432\u0430\u044e \u0442\u043e\u043b\u044c\u043a\u043e \u0442\u043e\u043a\u0435\u043d\u044b \u044d\u0442\u043e\u0439 \u0441\u0435\u0441\u0441\u0438\u0438.",
				title: "\u0421\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c \u0442\u043e\u043a\u0435\u043d\u043e\u0432 \u2014 \u043e\u0446\u0435\u043d\u043a\u0430 \u043f\u043e \u043a\u0430\u0442\u0430\u043b\u043e\u0433\u0443 \u043f\u0440\u043e\u0432\u0430\u0439\u0434\u0435\u0440\u043e\u0432",
				self: (usd) => "\u044d\u0442\u043e\u0442 \u0447\u0430\u0442: $" + usd,
				subagents: (usd, count) => "\u0441\u0443\u0431\u0430\u0433\u0435\u043d\u0442\u044b (" + count + "): $" + usd,
				tree: (usd) => "\u0432\u0441\u0435\u0433\u043e \u043f\u043e \u0434\u0435\u0440\u0435\u0432\u0443 \u0441\u0435\u0441\u0441\u0438\u0439: $" + usd,
				tokens: (t) => "\u0442\u043e\u043a\u0435\u043d\u044b \u2014 \u0432\u0445\u043e\u0434 " + t.uncachedInput + " \u00b7 \u0447\u0442\u0435\u043d\u0438\u0435 \u043a\u044d\u0448\u0430 " + t.cacheRead + " \u00b7 \u0437\u0430\u043f\u0438\u0441\u044c \u043a\u044d\u0448\u0430 " + t.cacheWrite + " \u00b7 \u0432\u044b\u0432\u043e\u0434 " + t.output,
				models: (list) => "\u043c\u043e\u0434\u0435\u043b\u0438: " + list,
				unpriced: (count) => count + " \u0441\u0435\u0441\u0441\u0438\u0439 \u0431\u0435\u0437 \u0446\u0435\u043d\u044b \u0432 \u043a\u0430\u0442\u0430\u043b\u043e\u0433\u0435 \u2014 \u0432 \u0438\u0442\u043e\u0433\u0438 \u043d\u0435 \u0432\u043e\u0448\u043b\u0438",
				log: (path) => "\u043b\u043e\u0433 \u0440\u0430\u0441\u0445\u043e\u0434\u0430: " + path,
				refresh: "\u041a\u043b\u0438\u043a \u2014 \u043e\u0431\u043d\u043e\u0432\u0438\u0442\u044c"
			}
		};

		/**
		 * Pick a supported language from the signals the harness and the browser
		 * give us: an explicit plugin choice wins, then the harness locale (only
		 * en/zh exist there), then the browser language (which is what makes ru
		 * reachable), then English.
		 */
		function resolveLanguage(preferred, harnessLocale, browserLanguage) {
			const candidates = [preferred, harnessLocale, browserLanguage];
			for (const candidate of candidates) {
				if (typeof candidate !== "string" || candidate === "") continue;
				const tag = candidate.trim().toLowerCase().split(/[-_]/)[0];
				if (LANGUAGES.indexOf(tag) !== -1) return tag;
			}
			return FALLBACK_LANGUAGE;
		}

		function formatUsd(cost) {
			if (typeof cost !== "number" || !Number.isFinite(cost)) return null;
			if (cost >= 100) return cost.toFixed(2);
			if (cost >= 1) return cost.toFixed(3);
			if (cost >= 0.01) return cost.toFixed(4);
			return cost.toFixed(5);
		}

		function compact(count) {
			if (typeof count !== "number" || !Number.isFinite(count)) return "0";
			if (count >= 1000000) return (count / 1000000).toFixed(1) + "M";
			if (count >= 1000) return (count / 1000).toFixed(1) + "K";
			return String(Math.round(count));
		}

		/** Provider buckets from the session projection, compacted for display. */
		function projectionBuckets(usage) {
			return {
				uncachedInput: compact(usage && usage.uncachedInputTokens),
				cacheRead: compact(usage && usage.cacheReadTokens),
				cacheWrite: compact(usage && usage.cacheWriteTokens),
				output: compact(usage && usage.outputTokens)
			};
		}

		const apply = (ctx) => {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			const localeSvc = ctx.get("locale");
			const configured = typeof ctx.config?.language === "string" ? ctx.config.language : null;

			const browserLanguage = () => {
				try {
					return typeof window !== "undefined" && window.navigator !== undefined ? window.navigator.language : null;
				} catch {
					return null;
				}
			};

			/** Plugin config wins; the Host forwards its own `language` setting. */
			const currentLanguage = (fromHost) => resolveLanguage(
				configured !== null ? configured : (fromHost ?? null),
				localeSvc === undefined ? null : localeSvc.getLocale().active,
				browserLanguage()
			);

			const style = document.createElement("style");
			style.dataset.plugin = "dsh-chat-cost";
			style.textContent =
				".dsh-chat-cost { display: inline-flex; align-items: baseline; gap: 4px; font-size: 11px; line-height: 1; color: var(--dsw-alias-label-secondary); white-space: nowrap; user-select: none; cursor: pointer; }" +
				".dsh-chat-cost:hover { color: var(--dsw-alias-label-primary); }" +
				".dsh-chat-cost--muted { opacity: 0.6; cursor: default; }";
			document.head.appendChild(style);
			ctx.effect(() => () => style.remove());

			function ChatCost(props) {
				const usage = typeof props.useProjection === "function" ? props.useProjection("tokenUsage") : undefined;
				const [summary, setSummary] = react.useState(null);
				const [failed, setFailed] = react.useState(false);
				const [nonce, setNonce] = react.useState(0);
				// Re-render when the harness locale changes; the language itself is
				// derived below so a Host-reported choice takes effect with the summary.
				const [, setLocaleTick] = react.useState(0);

				react.useEffect(() => {
					if (localeSvc === undefined) return undefined;
					return localeSvc.subscribe(() => setLocaleTick((value) => value + 1));
				}, []);

				// Refetch when the session changes and whenever the token fold moves;
				// a slow interval covers spend that lands without touching this session.
				const usageSignature = [
					usage && usage.uncachedInputTokens, usage && usage.cacheReadTokens,
					usage && usage.cacheWriteTokens, usage && usage.outputTokens
				].join(":");

				react.useEffect(() => {
					const sessionId = props.sessionId;
					if (typeof sessionId !== "string") return undefined;
					let alive = true;
					const load = () => {
						window.fetch(SUMMARY_PATH + "?sessionId=" + encodeURIComponent(sessionId), { headers: { accept: "application/json" } })
							.then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
							.then((body) => { if (alive) { setSummary(body); setFailed(false); } })
							.catch(() => { if (alive) { setSummary(null); setFailed(true); } });
					};
					load();
					const timer = window.setInterval(load, REFRESH_MS);
					return () => { alive = false; window.clearInterval(timer); };
				}, [props.sessionId, usageSignature, nonce]);

				const lang = currentLanguage(summary !== null && typeof summary.language === "string" ? summary.language : null);
				const text = STRINGS[lang] || STRINGS[FALLBACK_LANGUAGE];
				const buckets = projectionBuckets(usage);

				if (summary !== null && summary.ok === true) {
					const totals = summary.totals || {};
					const shown = formatUsd(totals.usd);
					if (shown === null) {
						return react.createElement("span", {
							className: "dsh-chat-cost dsh-chat-cost--muted",
							title: text.title + "\n" + text.tokens(buckets) + "\n" + text.unpriced((totals.unpricedSessions || []).length)
						}, text.hostDown);
					}
					const models = (summary.sessions || [])
						.filter((entry) => entry.model)
						.map((entry) => (entry.model || "?") + (entry.usd === null ? " (no price)" : ""));
					const lines = [text.title];
					const selfShown = formatUsd(totals.chatUsd);
					if (selfShown !== null) lines.push(text.self(selfShown));
					if ((totals.subagentCount || 0) > 0) lines.push(text.subagents(formatUsd(totals.subagentUsd) || "0.00000", totals.subagentCount));
					lines.push(text.tree(shown));
					lines.push(text.tokens(buckets));
					if (models.length > 0) lines.push(text.models(models.join(" \u00b7 ")));
					if ((totals.unpricedSessions || []).length > 0) lines.push(text.unpriced(totals.unpricedSessions.length));
					if (summary.logPath) lines.push(text.log(summary.logPath));
					lines.push(text.refresh);
					return react.createElement("span", {
						className: "dsh-chat-cost",
						title: lines.join("\n"),
						onClick: () => setNonce((value) => value + 1)
					}, "\u2248 $" + shown);
				}

				if (failed) {
					return react.createElement("span", {
						className: "dsh-chat-cost dsh-chat-cost--muted",
						title: text.hostDownTip + "\n" + text.tokens(buckets)
					}, text.hostDown);
				}

				return null;
			}

			slots.inject("conversation.composer.dock", () => slots.register(
				{ name: "conversation.composer.dock", id: "dsh-chat-cost", order: 100, label: "Chat cost" },
				(props) => react.createElement(ChatCost, props)
			));
		};

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		// Test hooks: the shipped bundle is loaded by test/client.test.mjs so the
		// strings and the language resolution are covered without a browser.
		exports.__strings = STRINGS;
		exports.__resolveLanguage = resolveLanguage;
		exports.__formatUsd = formatUsd;
		exports.__languages = LANGUAGES;
		return module.exports;
	}
});
