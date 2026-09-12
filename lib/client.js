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
				refresh: "Click to refresh",
				budget: (spent, limit) => "budget: $" + spent + " of $" + limit,
				budgetOver: (over) => "over budget by $" + over,
				planHeader: (count) => "plan: " + count + " unit(s)",
				planUnit: (title, model, planned, actual) => "\u00b7 " + title + " (" + model + "): $" + planned + " planned" + (actual === null ? "" : ", $" + actual + " actual"),
				planDeferred: (count) => count + " unit(s) did not fit the budget",
				scenarios: (list) => "scenarios: " + list,
				savings: (usd) => "cheapest adequate routing saves $" + usd,
				unlabeled: (usd) => "$" + usd + " is not attributed to any plan unit — call cost_mark when a unit starts",
				recordedTip: "this chat is not open, so the numbers are what the cost log recorded — not what a live session would report",
				unknownTip: "the Host holds neither a live session nor a log record for this chat"
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
				refresh: "\u70b9\u51fb\u5237\u65b0",
				budget: (spent, limit) => "\u9884\u7b97\uff1a$" + spent + " / $" + limit,
				budgetOver: (over) => "\u8d85\u51fa\u9884\u7b97 $" + over,
				planHeader: (count) => "\u8ba1\u5212\uff1a" + count + " \u4e2a\u5355\u5143",
				planUnit: (title, model, planned, actual) => "\u00b7 " + title + "\uff08" + model + "\uff09\uff1a\u9884\u4f30 $" + planned + (actual === null ? "" : "\uff0c\u5b9e\u9645 $" + actual),
				planDeferred: (count) => count + " \u4e2a\u5355\u5143\u672a\u80fd\u7eb3\u5165\u9884\u7b97",
				scenarios: (list) => "\u65b9\u6848\uff1a" + list,
				savings: (usd) => "\u6539\u7528\u8db3\u591f\u4fbf\u5b9c\u7684\u6a21\u578b\u53ef\u7701 $" + usd,
				unlabeled: (usd) => "$" + usd + " \u672a\u5f52\u5165\u4efb\u4f55\u8ba1\u5212\u5355\u5143 \u2014\u2014 \u5f00\u59cb\u4e00\u4e2a\u5355\u5143\u65f6\u8bf7\u8c03\u7528 cost_mark",
				recordedTip: "\u8be5\u5bf9\u8bdd\u672a\u6253\u5f00\uff0c\u56e0\u6b64\u6570\u5b57\u6765\u81ea\u8d39\u7528\u65e5\u5fd7\u7684\u8bb0\u5f55\uff0c\u800c\u975e\u6d3b\u52a8\u4f1a\u8bdd\u4f1a\u62a5\u544a\u7684\u6570\u5b57",
				unknownTip: "\u5bbf\u4e3b\u65e2\u6ca1\u6709\u8be5\u5bf9\u8bdd\u7684\u6d3b\u52a8\u4f1a\u8bdd\uff0c\u4e5f\u6ca1\u6709\u5bf9\u5e94\u7684\u65e5\u5fd7\u8bb0\u5f55"
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
				refresh: "\u041a\u043b\u0438\u043a \u2014 \u043e\u0431\u043d\u043e\u0432\u0438\u0442\u044c",
				budget: (spent, limit) => "\u0431\u044e\u0434\u0436\u0435\u0442: $" + spent + " \u0438\u0437 $" + limit,
				budgetOver: (over) => "\u043f\u0435\u0440\u0435\u0440\u0430\u0441\u0445\u043e\u0434 \u043d\u0430 $" + over,
				planHeader: (count) => "\u043f\u043b\u0430\u043d: " + count + " \u043f\u0443\u043d\u043a\u0442(\u043e\u0432)",
				planUnit: (title, model, planned, actual) => "\u00b7 " + title + " (" + model + "): \u043f\u043b\u0430\u043d $" + planned + (actual === null ? "" : ", \u0444\u0430\u043a\u0442 $" + actual),
				planDeferred: (count) => count + " \u043f\u0443\u043d\u043a\u0442(\u043e\u0432) \u043d\u0435 \u0432\u043b\u0435\u0437\u043b\u0438 \u0432 \u0431\u044e\u0434\u0436\u0435\u0442",
				scenarios: (list) => "\u0441\u0446\u0435\u043d\u0430\u0440\u0438\u0438: " + list,
				savings: (usd) => "\u043f\u0435\u0440\u0435\u0445\u043e\u0434 \u043d\u0430 \u0434\u043e\u0441\u0442\u0430\u0442\u043e\u0447\u043d\u043e \u0434\u0435\u0448\u0451\u0432\u044b\u0435 \u043c\u043e\u0434\u0435\u043b\u0438 \u044d\u043a\u043e\u043d\u043e\u043c\u0438\u0442 $" + usd,
				unlabeled: (usd) => "$" + usd + " \u043d\u0435 \u043e\u0442\u043d\u0435\u0441\u0435\u043d\u043e \u043d\u0438 \u043a \u043e\u0434\u043d\u043e\u043c\u0443 \u043f\u0443\u043d\u043a\u0442\u0443 \u043f\u043b\u0430\u043d\u0430 \u2014 \u0432\u044b\u0437\u044b\u0432\u0430\u0439 cost_mark \u043d\u0430 \u0441\u0442\u0430\u0440\u0442\u0435 \u043f\u0443\u043d\u043a\u0442\u0430",
				recordedTip: "\u0447\u0430\u0442 \u043d\u0435 \u043e\u0442\u043a\u0440\u044b\u0442, \u043f\u043e\u044d\u0442\u043e\u043c\u0443 \u0446\u0438\u0444\u0440\u044b \u2014 \u0442\u043e, \u0447\u0442\u043e \u0437\u0430\u043f\u0438\u0441\u0430\u043b cost-\u043b\u043e\u0433, \u0430 \u043d\u0435 \u0442\u043e, \u0447\u0442\u043e \u0441\u043e\u043e\u0431\u0449\u0438\u043b\u0430 \u0431\u044b \u0436\u0438\u0432\u0430\u044f \u0441\u0435\u0441\u0441\u0438\u044f",
				unknownTip: "\u0443 \u0425\u043e\u0441\u0442\u0430 \u043d\u0435\u0442 \u043d\u0438 \u0436\u0438\u0432\u043e\u0439 \u0441\u0435\u0441\u0441\u0438\u0438, \u043d\u0438 \u0437\u0430\u043f\u0438\u0441\u0438 \u0432 \u043b\u043e\u0433\u0435 \u0434\u043b\u044f \u044d\u0442\u043e\u0433\u043e \u0447\u0430\u0442\u0430"
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

		/** A route may arrive as a name or as { provider, model }. */
		function routeName(route) {
			if (route === null || route === undefined) return "?";
			if (typeof route === "string") return route;
			return route.model || route.provider || "?";
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

		/**
		 * Boot the client half.
		 *
		 * Config arrives as the second argument, as it does on the Host half. It
		 * must not be read from `ctx`: the client runs the same Cordis, where a
		 * property the plugin did not inject throws — 0.5.1 loaded on the Host and
		 * still failed here, and the web shell reported the plugin as broken.
		 */
		const apply = (ctx, config) => {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			const localeSvc = ctx.get("locale");
			const configured = typeof config?.language === "string" ? config.language : null;

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
				const langRef = react.useRef ? react.useRef(currentLanguage(null)) : { current: currentLanguage(null) };
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
				if (langRef.current !== undefined) langRef.current = currentLanguage(summary !== null && typeof summary.language === "string" ? summary.language : null);

				const usageSignature = [
					usage && usage.uncachedInputTokens, usage && usage.cacheReadTokens,
					usage && usage.cacheWriteTokens, usage && usage.outputTokens
				].join(":");

				react.useEffect(() => {
					const sessionId = props.sessionId;
					if (typeof sessionId !== "string") return undefined;
					let alive = true;
					const load = () => {
						window.fetch(SUMMARY_PATH + "?sessionId=" + encodeURIComponent(sessionId) + "&language=" + langRef.current, { headers: { accept: "application/json" } })
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
					const budget = summary.budget;
					const plan = summary.plan;
					if (budget !== null && budget !== undefined) {
						const spentShown = formatUsd(budget.spentUsd) || "0";
						const limitShown = formatUsd(budget.usd) || "0";
						lines.push(text.budget(spentShown, limitShown));
						if (budget.projection === "over") lines.push(text.budgetOver(formatUsd(-(budget.remainingUsd || 0)) || "0"));
					}
					if (plan !== null && plan !== undefined && Array.isArray(plan.units) && plan.units.length > 0) {
						lines.push(text.planHeader(plan.units.length));
						for (const unit of plan.units.slice(0, 8)) {
							lines.push(text.planUnit(
								unit.title || unit.label || "?",
								unit.route ? unit.route.model : "\u2014",
								formatUsd(unit.p50Usd) || "\u2014",
								unit.actualUsd === null || unit.actualUsd === undefined ? null : (formatUsd(unit.actualUsd) || "\u2014")
							));
						}
						if (plan.deferredCount > 0) lines.push(text.planDeferred(plan.deferredCount));
						if (typeof summary.unlabeledUsd === "number" && summary.unlabeledUsd > 0) lines.push(text.unlabeled(formatUsd(summary.unlabeledUsd) || "0"));
						if (Array.isArray(plan.scenarios) && plan.scenarios.length > 0) {
							const summary = plan.scenarios
								.map((scenario) => scenario.name + " " + ("$" + (formatUsd(scenario.p50Usd) || "—")))
								.join(" \u00b7 ");
							lines.push(text.scenarios(summary));
							if (typeof plan.savingsUsd === "number" && plan.savingsUsd > 0) lines.push(text.savings(formatUsd(plan.savingsUsd) || "0"));
							for (const opportunity of (plan.opportunities || []).slice(0, 3)) {
								lines.push(text.planUnit(opportunity.label || "?", routeName(opportunity.from) + " \u2192 " + routeName(opportunity.to), formatUsd(opportunity.usd) || "0", null));
							}
						}
					}
					if (summary.recorded === true) lines.push(text.recordedTip);
					if (summary.logPath) lines.push(text.log(summary.logPath));
					lines.push(text.refresh);
					const suffix = budget !== null && budget !== undefined && typeof budget.usd === "number"
						? " / $" + (formatUsd(budget.usd) || "0")
						: "";
					return react.createElement("span", {
						className: "dsh-chat-cost",
						title: lines.join("\n"),
						onClick: () => setNonce((value) => value + 1)
					}, "\u2248 $" + shown + suffix);
				}

				if (failed) {
					return react.createElement("span", {
						className: "dsh-chat-cost dsh-chat-cost--muted",
						title: text.hostDownTip + "\n" + text.tokens(buckets)
					}, text.hostDown);
				}

				// The Host answered, but holds neither a live session nor a log
				// record for this chat. Saying so beats rendering nothing: the
				// readout used to disappear in exactly this case.
				if (summary !== null && summary.ok !== true) {
					return react.createElement("span", {
						className: "dsh-chat-cost dsh-chat-cost--muted",
						title: text.unknownTip + "\n" + text.tokens(buckets)
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
