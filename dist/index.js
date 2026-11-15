import crypto from "crypto";
import dotenv from "dotenv";
import { Left, Option, Right, Try } from "functype";
import { createServer, getRequestHeader } from "somamcp/node";
import { z } from "zod";
import { XMLParser } from "fast-xml-parser";
// src/client/errors.ts
/**
* Typed error channel for the Reddit client.
*
* The client's methods are the imperative-to-functional boundary: each captures throws
* (network, HTTP, JSON parsing, validation, deliberate domain errors) inside a `Try` and
* converts to a typed `Either<RedditError, T>`. Modelling the error as a discriminated ADT
* — rather than a bare `Error` — makes the failure contract explicit at the type level, so
* callers can reason about (and branch on) what actually went wrong without string-matching.
*
* `classifyRedditError` is TOTAL and never re-throws — every captured `Error` maps to a
* variant — which is what makes the migration behavior-preserving: an error that was a
* graceful `Left` before is still a graceful `Left` after, just with a richer type.
*
* Two-tier behavior, to preserve the exact messages of the original try/catch code:
*  - A *deliberate* typed throw (HttpError, NotFoundError, …) already carries its final
*    message, so it passes through unchanged.
*  - An *unexpected* generic error (fetch/JSON/orThrow) is wrapped as UnknownError, with the
*    optional `context` prefix — present for read methods (which prefixed in their catch),
*    absent for write methods (which returned the raw message).
*/
var RedditErrorBase = class extends Error {};
/** A non-ok HTTP response from the Reddit API. Carries the status for caller branching. */
var HttpError = class extends RedditErrorBase {
	status;
	_tag = "HttpError";
	constructor(status, message) {
		super(message);
		this.status = status;
		this.name = "HttpError";
	}
};
/** A write operation was attempted without the required user credentials / in a wrong mode. */
var NotAuthenticatedError = class extends RedditErrorBase {
	_tag = "NotAuthenticatedError";
	constructor(message) {
		super(message);
		this.name = "NotAuthenticatedError";
	}
};
/** Reddit accepted the request but returned errors in its JSON envelope (or an unusable body). */
var ApiError = class extends RedditErrorBase {
	_tag = "ApiError";
	constructor(message) {
		super(message);
		this.name = "ApiError";
	}
};
/** The requested post/entity does not exist or is not accessible. */
var NotFoundError = class extends RedditErrorBase {
	_tag = "NotFoundError";
	constructor(message) {
		super(message);
		this.name = "NotFoundError";
	}
};
/** Client-side input or safety-policy rejection (invalid sort, duplicate-content guard). */
var ValidationError = class extends RedditErrorBase {
	_tag = "ValidationError";
	constructor(message) {
		super(message);
		this.name = "ValidationError";
	}
};
/** Any failure that is not a recognized category: network, JSON parsing, unexpected throws. */
var UnknownError = class extends RedditErrorBase {
	cause;
	_tag = "UnknownError";
	constructor(message, cause) {
		super(message);
		this.cause = cause;
		this.name = "UnknownError";
	}
};
function isRedditError(error) {
	return error instanceof RedditErrorBase;
}
/**
* Total classifier from a captured `Error` to a `RedditError`. Deliberate typed throws pass
* through unchanged; everything else becomes an `UnknownError`, prefixed with `context` when
* provided so the observable message text matches the previous try/catch-based wrapping.
*/
function classifyRedditError(error, context) {
	if (isRedditError(error)) return error;
	return new UnknownError(Option(context).fold(() => error.message, (ctx) => `${ctx}: ${error.message}`), error);
}
// src/utils/reddit-identifiers.ts
/**
* Validation and normalization for Reddit identifiers that get interpolated into API paths.
*
* Every identifier reaching the client is model- or user-supplied. Interpolating one raw is a
* path-injection hole: URL parsing resolves dot segments, so a `subreddit` of `../../api/v1/me`
* escapes `/r/{sub}/about.json` and steers the OAuth bearer token to a different endpoint, and an
* embedded `?` or `&` injects query parameters into the request we build.
*
* So each identifier is normalized (stripping the `r/`, `/u/`, `t3_` prefixes people naturally
* type) and then checked against Reddit's own charset. Every value returned from this module
* matches `[A-Za-z0-9_+-]+`, which is already URL-path-safe — no percent-encoding is applied,
* because encoding the `+` in a multireddit (`r/science+space`) would break it.
*/
const SUBREDDIT_PATTERN = /^(u_)?[A-Za-z0-9][A-Za-z0-9_]{1,20}$/;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/;
const THING_ID_PATTERN = /^[a-z0-9]{1,13}$/;
const stripLeading = (value, prefixes) => {
	const lower = value.toLowerCase();
	const matched = prefixes.find((prefix) => lower.startsWith(prefix));
	return matched === void 0 ? value : value.slice(matched.length);
};
const bare = (value, prefixes) => stripLeading(stripLeading(value.trim(), ["/"]), prefixes).replace(/\/+$/, "");
/**
* Normalize a subreddit name for use in a path segment.
*
* Accepts `science`, `r/science`, `/r/science`, and `+`-joined multireddits (`science+space`).
* The empty string passes through unchanged — callers use it to mean "the home feed".
*/
function normalizeSubreddit(input) {
	const trimmed = input.trim();
	if (trimmed === "") return "";
	const segments = bare(trimmed, ["r/"]).split("+").map((segment) => segment.trim());
	if (segments.find((segment) => !SUBREDDIT_PATTERN.test(segment)) !== void 0) throw new ValidationError(`Invalid subreddit name "${input}". Expected 2-21 characters of letters, digits, or underscores (e.g. "science").`);
	return segments.join("+");
}
/** Normalize a username for use in a path segment. Accepts `spez`, `u/spez`, `/user/spez`. */
function normalizeUsername(input) {
	const name = bare(input, ["user/", "u/"]);
	if (!USERNAME_PATTERN.test(name)) throw new ValidationError(`Invalid Reddit username "${input}". Expected 2-20 characters of letters, digits, underscores, or hyphens (e.g. "spez").`);
	return name;
}
/**
* Normalize a post or comment ID to its bare base36 form, dropping any `t1_`/`t3_` fullname
* prefix. Use this wherever the ID lands in a path segment or query value.
*/
function normalizeThingId(input) {
	const id = bare(input, [
		"t1_",
		"t3_",
		"t4_",
		"t5_"
	]).toLowerCase();
	if (!THING_ID_PATTERN.test(id)) throw new ValidationError(`Invalid Reddit ID "${input}". Expected a base36 id such as "1abc2de", optionally prefixed with t1_ or t3_.`);
	return id;
}
/**
* Normalize an ID to a Reddit fullname (`t3_1abc2de`), preserving an explicit `t1_`/`t3_` prefix
* and falling back to `defaultKind` when the caller passed a bare ID.
*/
function normalizeFullname(input, defaultKind) {
	const trimmed = input.trim().toLowerCase();
	return `${trimmed.startsWith("t1_") ? "t1" : trimmed.startsWith("t3_") ? "t3" : defaultKind}_${normalizeThingId(input)}`;
}
// src/client/reddit-parsers.ts
function parsePostData(post) {
	return {
		id: post.id,
		title: post.title,
		author: post.author,
		subreddit: post.subreddit,
		selftext: post.selftext,
		url: post.url,
		score: post.score,
		upvoteRatio: post.upvote_ratio,
		numComments: post.num_comments,
		createdUtc: post.created_utc,
		over18: post.over_18,
		spoiler: post.spoiler,
		edited: Boolean(post.edited),
		isSelf: post.is_self,
		linkFlairText: post.link_flair_text ?? void 0,
		permalink: post.permalink
	};
}
function parseCommentData(comment, submissionTitle, depth) {
	return {
		id: comment.id,
		author: comment.author,
		body: comment.body ?? "",
		score: comment.score,
		controversiality: comment.controversiality,
		subreddit: comment.subreddit,
		submissionTitle: submissionTitle ?? comment.link_title ?? "",
		createdUtc: comment.created_utc,
		edited: Boolean(comment.edited),
		isSubmitter: comment.is_submitter,
		permalink: comment.permalink,
		...depth !== void 0 ? { depth } : {},
		parentId: comment.parent_id
	};
}
function parseCommentTree(children, submissionTitle, depth = 0) {
	return children.flatMap((item) => {
		if (item.kind !== "t1" || item.data.body === void 0) return [];
		const { replies } = item.data;
		const childComments = replies !== void 0 && typeof replies !== "string" ? parseCommentTree(replies.data.children, submissionTitle, depth + 1) : [];
		return [parseCommentData(item.data, submissionTitle, depth), ...childComments];
	});
}
function collectMoreIds(children) {
	return children.flatMap((item) => {
		if (item.kind === "more") {
			const ids = item.data.children;
			return Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id !== "_") : [];
		}
		const { replies } = item.data;
		return replies !== void 0 && typeof replies !== "string" ? collectMoreIds(replies.data.children) : [];
	});
}
function parseSubredditData(data) {
	return {
		displayName: data.display_name,
		title: data.title,
		description: data.description,
		publicDescription: data.public_description,
		subscribers: data.subscribers,
		activeUserCount: data.active_user_count ?? void 0,
		createdUtc: data.created_utc,
		over18: data.over18,
		subredditType: data.subreddit_type,
		url: data.url
	};
}
function parseRuleData(rule) {
	return {
		shortName: rule.short_name,
		description: rule.description,
		kind: rule.kind,
		violationReason: rule.violation_reason,
		priority: rule.priority,
		createdUtc: rule.created_utc
	};
}
function parseSubredditSearchData(sub) {
	return {
		id: String(sub.id ?? sub.display_name),
		title: `r/${sub.display_name} (${sub.subscribers.toLocaleString("en-US")} subscribers)${sub.title ? ` — ${sub.title}` : ""}`,
		author: "",
		subreddit: sub.display_name,
		selftext: sub.public_description,
		url: `https://reddit.com${sub.url}`,
		score: sub.subscribers,
		upvoteRatio: 1,
		numComments: 0,
		createdUtc: sub.created_utc,
		over18: sub.over18,
		edited: false,
		isSelf: false,
		permalink: sub.url
	};
}
function parseUserSearchData(user) {
	const karma = user.total_karma ?? user.link_karma + user.comment_karma;
	return {
		id: user.id,
		title: `u/${user.name} (${karma.toLocaleString("en-US")} karma)`,
		author: user.name,
		subreddit: "",
		url: `https://reddit.com/user/${user.name}`,
		score: karma,
		upvoteRatio: 1,
		numComments: 0,
		createdUtc: user.created_utc,
		over18: false,
		edited: false,
		isSelf: false,
		permalink: `/user/${user.name}`
	};
}
// src/client/arctic-shift-client.ts
/**
* Keyless read backend over the Arctic Shift archive (https://github.com/ArthurHeitmann/arctic_shift),
* a free third-party Reddit archive. It is not Reddit's API:
* - It sorts only by creation date, so there is no hot/top/rising ranking and no home feed.
* - Scores and comment counts are captured at ingest and lag (often 0 or 1 on recent posts).
* - Coverage can be incomplete, especially for comments on recent posts.
* - Keyword search needs a subreddit or author; multireddits (`a+b`) are not supported.
* Pagination walks backward in time: the `after` cursor is the created_utc of the last item.
*/
const BASE_URL = "https://arctic-shift.photon-reddit.com/api";
const MAX_LIMIT = 100;
const MAX_COMMENT_TREE_LIMIT = 500;
const ERROR_TEXT_MAX_LENGTH = 200;
const CURSOR_PATTERN = /^\d{9,10}$/;
const THROTTLE_DELAYS = {
	fallbackMs: 3e3,
	maxWaitMs: 1e4
};
function throttleWaitMs(resetSeconds, delays) {
	return resetSeconds.fold(() => delays.fallbackMs, (seconds) => Math.min(seconds * 1e3, delays.maxWaitMs));
}
function throttleMessage(status, resetSeconds) {
	if (status !== 429) return "Arctic Shift timed out on this query, which it does under load. Wait a few seconds and retry; keyword searches on large subreddits are slowest.";
	return resetSeconds.fold(() => "Arctic Shift's rate limit was reached. It is a free service; wait a minute and retry.", (seconds) => `Arctic Shift's rate limit was reached. It resets in ${seconds} seconds; retry after that.`);
}
function resetSecondsOf(headers) {
	return Option(headers.get("x-ratelimit-reset")).filter((raw) => raw.trim() !== "").map(Number).filter((value) => Number.isFinite(value) && value >= 0);
}
function clampLimit(limit, max = MAX_LIMIT) {
	return Math.min(Math.max(Math.trunc(limit), 1), max);
}
function singleSubreddit(subreddit) {
	const name = normalizeSubreddit(subreddit);
	if (name === "") throw new ValidationError("The Arctic Shift archive has no home feed. Name a subreddit, or set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.");
	if (name.includes("+")) throw new ValidationError(`The Arctic Shift archive does not support multireddits ("${name}"). Query one at a time.`);
	return name;
}
function isArchiveCursor(after) {
	return CURSOR_PATTERN.test(after);
}
const TIME_FILTER_OFFSETS = {
	hour: "1hour",
	day: "1d",
	week: "7d",
	month: "30d",
	year: "365d"
};
function cursorParam(after) {
	if (after === void 0) return {};
	if (!isArchiveCursor(after)) throw new ValidationError(`Invalid pagination cursor "${after}". In keyless mode, pass the \`after\` value from a previous keyless call.`);
	return { before: after };
}
function pageOf(items, limit) {
	const last = items.at(-1);
	return {
		items,
		source: "arctic",
		...items.length >= limit && last !== void 0 ? { after: String(last.createdUtc) } : {}
	};
}
var ArcticShiftClient = class {
	userAgent;
	cache;
	throttleDelays;
	constructor(userAgent, cache, throttleDelays = THROTTLE_DELAYS) {
		this.userAgent = userAgent;
		this.cache = cache;
		this.throttleDelays = throttleDelays;
	}
	async request(path, params, retried = false) {
		var _this$cache, _this$cache2;
		const url = `${BASE_URL}${path}?${new URLSearchParams(params)}`;
		const cached = (_this$cache = this.cache) === null || _this$cache === void 0 ? void 0 : _this$cache.get(url);
		const { status, body, resetSeconds } = cached !== void 0 ? {
			...cached,
			resetSeconds: Option.none()
		} : await this.fetchBody(url);
		const json = Try(() => JSON.parse(body)).orElse({
			data: null,
			error: `HTTP ${status}`
		});
		if (status < 200 || status >= 300 || json.error !== void 0 || json.data === null) {
			const detail = (json.error ?? `HTTP ${status}`).slice(0, ERROR_TEXT_MAX_LENGTH);
			if (status === 429 || /timeout|timed out/i.test(detail)) {
				if (!retried) {
					await new Promise((resolve) => setTimeout(resolve, throttleWaitMs(resetSeconds, this.throttleDelays)));
					return this.request(path, params, true);
				}
				throw new HttpError(status, throttleMessage(status, resetSeconds));
			}
			throw status >= 400 ? new HttpError(status, `Arctic Shift error: ${detail}`) : new ApiError(`Arctic Shift error: ${detail}`);
		}
		if (cached === void 0) (_this$cache2 = this.cache) === null || _this$cache2 === void 0 || _this$cache2.set(url, body, status);
		return json.data;
	}
	async fetchBody(url) {
		const response = await fetch(url, { headers: {
			"User-Agent": this.userAgent,
			Accept: "application/json"
		} });
		return {
			status: response.status,
			body: await response.text(),
			resetSeconds: resetSecondsOf(response.headers)
		};
	}
	async listSubredditPosts(subreddit, limit = 25, after) {
		const context = `Failed to list r/${subreddit} from the Arctic Shift archive`;
		return (await Try.async(async () => {
			const size = clampLimit(limit);
			return pageOf((await this.request("/posts/search", {
				subreddit: singleSubreddit(subreddit),
				sort: "desc",
				limit: String(size),
				...cursorParam(after)
			})).map(parsePostData), size);
		})).toEither((error) => classifyRedditError(error, context));
	}
	async searchPosts(query, options = {}) {
		const { subreddit, limit = 25, after, timeFilter } = options;
		const since = timeFilter !== void 0 ? TIME_FILTER_OFFSETS[timeFilter] : void 0;
		const context = `Failed to search the Arctic Shift archive for: ${query}`;
		return (await Try.async(async () => {
			if (subreddit === void 0) throw new ValidationError("Keyless search needs a subreddit: the Arctic Shift archive cannot search all of Reddit. Pass `subreddit`.");
			const size = clampLimit(limit);
			return pageOf((await this.request("/posts/search", {
				subreddit: singleSubreddit(subreddit),
				query,
				...since !== void 0 ? { after: since } : {},
				sort: "desc",
				limit: String(size),
				...cursorParam(after)
			})).map(parsePostData), size);
		})).toEither((error) => classifyRedditError(error, context));
	}
	async searchSubreddits(query, limit = 25) {
		const context = `Failed to search subreddits in the Arctic Shift archive for: ${query}`;
		return (await Try.async(async () => {
			const prefix = query.trim().replace(/^\/?r\//i, "");
			if (!/^[A-Za-z0-9_]+$/.test(prefix)) throw new ValidationError("Keyless subreddit search matches name prefixes only. Use one word of letters, digits, or underscores.");
			return {
				items: (await this.request("/subreddits/search", {
					subreddit_prefix: prefix,
					limit: String(clampLimit(limit))
				})).map(parseSubredditSearchData),
				source: "arctic"
			};
		})).toEither((error) => classifyRedditError(error, context));
	}
	async getPost(postId) {
		const context = `Failed to get post ${postId} from the Arctic Shift archive`;
		return (await Try.async(async () => this.fetchPost(postId))).toEither((error) => classifyRedditError(error, context));
	}
	async fetchPost(postId) {
		const post = (await this.request("/posts/ids", { ids: normalizeThingId(postId) })).at(0);
		if (post === void 0) throw new NotFoundError(`Post ${postId} is not in the Arctic Shift archive`);
		return parsePostData(post);
	}
	async getPostComments(postId, limit = 100) {
		const context = `Failed to get comments for post ${postId} from the Arctic Shift archive`;
		return (await Try.async(async () => {
			const post = await this.fetchPost(postId);
			const tree = await this.request("/comments/tree", {
				link_id: `t3_${post.id}`,
				limit: String(clampLimit(limit, MAX_COMMENT_TREE_LIMIT))
			});
			return {
				post,
				comments: parseCommentTree(tree, post.title),
				moreIds: collectMoreIds(tree)
			};
		})).toEither((error) => classifyRedditError(error, context));
	}
	async getComments(commentIds) {
		const context = "Failed to expand comments from the Arctic Shift archive";
		return (await Try.async(async () => {
			return (await this.request("/comments/ids", { ids: commentIds.map((id) => normalizeThingId(id)).join(",") })).map((comment) => parseCommentData(comment));
		})).toEither((error) => classifyRedditError(error, context));
	}
	async getUser(username) {
		const context = `Failed to get user ${username} from the Arctic Shift archive`;
		return (await Try.async(async () => {
			const user = (await this.request("/users/search", { author: normalizeUsername(username) })).at(0);
			if (user === void 0) throw new NotFoundError(`User ${username} is not in the Arctic Shift archive`);
			const meta = user._meta ?? {};
			const linkKarma = meta.post_karma ?? 0;
			const commentKarma = meta.comment_karma ?? 0;
			const firstSeen = [meta.earliest_post_at, meta.earliest_comment_at].filter((value) => typeof value === "number");
			return {
				name: user.author,
				id: user.id ?? "",
				commentKarma,
				linkKarma,
				totalKarma: meta.total_karma ?? linkKarma + commentKarma,
				isMod: false,
				isGold: false,
				isEmployee: false,
				createdUtc: firstSeen.length > 0 ? Math.min(...firstSeen) : 0,
				profileUrl: `https://reddit.com/user/${user.author}`
			};
		})).toEither((error) => classifyRedditError(error, context));
	}
	async getUserPosts(username, limit = 25, after) {
		const context = `Failed to get posts for user ${username} from the Arctic Shift archive`;
		return (await Try.async(async () => {
			const size = clampLimit(limit);
			return pageOf((await this.request("/posts/search", {
				author: normalizeUsername(username),
				sort: "desc",
				limit: String(size),
				...cursorParam(after)
			})).map(parsePostData), size);
		})).toEither((error) => classifyRedditError(error, context));
	}
	async getUserComments(username, limit = 25, after) {
		const context = `Failed to get comments for user ${username} from the Arctic Shift archive`;
		return (await Try.async(async () => {
			const size = clampLimit(limit);
			return pageOf((await this.request("/comments/search", {
				author: normalizeUsername(username),
				sort: "desc",
				limit: String(size),
				...cursorParam(after)
			})).map((comment) => parseCommentData(comment)), size);
		})).toEither((error) => classifyRedditError(error, context));
	}
	async getSubredditInfo(subreddit) {
		const context = `Failed to get r/${subreddit} from the Arctic Shift archive`;
		return (await Try.async(async () => {
			const sub = (await this.request("/subreddits/search", { subreddit: singleSubreddit(subreddit) })).at(0);
			if (sub === void 0) throw new NotFoundError(`r/${subreddit} is not in the Arctic Shift archive`);
			return parseSubredditData(sub);
		})).toEither((error) => classifyRedditError(error, context));
	}
	async getSubredditRules(subreddit) {
		const context = `Failed to get rules for r/${subreddit} from the Arctic Shift archive`;
		return (await Try.async(async () => {
			const entry = (await this.request("/subreddits/rules", { subreddits: singleSubreddit(subreddit) })).at(0);
			if (entry === void 0) throw new NotFoundError(`No rules for r/${subreddit} in the Arctic Shift archive`);
			return entry.rules.map(parseRuleData);
		})).toEither((error) => classifyRedditError(error, context));
	}
};
// src/client/response-cache.ts
const SECOND = 1e3;
var ResponseCache = class {
	maxBytes;
	now;
	entries = /* @__PURE__ */ new Map();
	currentBytes = 0;
	constructor(options) {
		this.maxBytes = options.maxBytes;
		this.now = options.now ?? Date.now;
	}
	/** Adaptive TTL (in milliseconds) for a given request URL. */
	ttlFor(url) {
		if (/\/(hot|new|rising)\.json/.test(url)) return 60 * SECOND;
		if (/\/(top|controversial)\.json/.test(url) || /\/search\.json/.test(url) || /\/about\.json/.test(url)) return 300 * SECOND;
		if (/\/comments\//.test(url)) return 60 * SECOND;
		return 120 * SECOND;
	}
	get(url) {
		const entry = this.entries.get(url);
		if (entry === void 0) return;
		if (this.now() >= entry.expiresAt) {
			this.entries.delete(url);
			this.currentBytes -= entry.bytes;
			return;
		}
		this.entries.delete(url);
		this.entries.set(url, entry);
		return {
			body: entry.body,
			status: entry.status
		};
	}
	set(url, body, status) {
		const bytes = Buffer.byteLength(body, "utf8");
		if (bytes > this.maxBytes) return;
		const existing = this.entries.get(url);
		if (existing !== void 0) {
			this.entries.delete(url);
			this.currentBytes -= existing.bytes;
		}
		this.entries.set(url, {
			body,
			status,
			expiresAt: this.now() + this.ttlFor(url),
			bytes
		});
		this.currentBytes += bytes;
		this.evictUntilWithinBudget();
	}
	evictUntilWithinBudget() {
		while (this.currentBytes > this.maxBytes) {
			const oldestKey = this.entries.keys().next().value;
			if (oldestKey === void 0) return;
			const oldest = this.entries.get(oldestKey);
			this.entries.delete(oldestKey);
			if (oldest !== void 0) this.currentBytes -= oldest.bytes;
		}
	}
};
// src/client/rss-client.ts
function contentText(content) {
	if (content === void 0) return "";
	if (typeof content === "string") return content;
	return content["#text"] ?? "";
}
const parser = new XMLParser({
	ignoreAttributes: false,
	removeNSPrefix: true,
	parseTagValue: false
});
function parseAtomFeed(xml) {
	var _result$feed;
	const entries = (_result$feed = parser.parse(xml).feed) === null || _result$feed === void 0 ? void 0 : _result$feed.entry;
	if (!entries) return [];
	return Array.isArray(entries) ? entries : [entries];
}
function decodeHtmlEntities(text) {
	return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&#32;/g, " ").replace(/&amp;/g, "&");
}
function extractLinkUrl(contentHtml) {
	const match = contentHtml.match(/href="([^"]+)">\[link\]/);
	return (match === null || match === void 0 ? void 0 : match[1]) ? decodeHtmlEntities(match[1]) : void 0;
}
function extractSelfText(contentHtml) {
	const match = contentHtml.match(/<!-- SC_OFF -->(.*?)<!-- SC_ON -->/s);
	if (!match) return "";
	return decodeHtmlEntities(match[1].replace(/<[^>]+>/g, "")).trim();
}
function atomEntryToRedditPost(entry) {
	var _entry$link, _entry$author, _entry$category;
	const permalink = ((_entry$link = entry.link) === null || _entry$link === void 0 ? void 0 : _entry$link["@_href"]) ?? "";
	const contentHtml = contentText(entry.content);
	const externalUrl = extractLinkUrl(contentHtml);
	const isSelf = !externalUrl || externalUrl.includes("/comments/");
	const author = (((_entry$author = entry.author) === null || _entry$author === void 0 ? void 0 : _entry$author.name) ?? "").replace(/^\/u\//, "");
	const subreddit = ((_entry$category = entry.category) === null || _entry$category === void 0 ? void 0 : _entry$category["@_term"]) ?? "";
	return {
		id: (entry.id ?? "").replace(/^t3_/, ""),
		title: entry.title ?? "",
		author,
		subreddit,
		selftext: extractSelfText(contentHtml),
		url: isSelf ? permalink : externalUrl ?? permalink,
		score: 0,
		upvoteRatio: 0,
		numComments: 0,
		createdUtc: Math.floor(new Date(entry.published ?? entry.updated ?? "").getTime() / 1e3),
		over18: false,
		edited: false,
		isSelf,
		permalink: permalink.replace("https://www.reddit.com", "")
	};
}
const RSS_CACHE_TTL_MS = 6e4;
var RssClient = class {
	userAgent;
	cache = /* @__PURE__ */ new Map();
	constructor(userAgent) {
		this.userAgent = userAgent;
	}
	async fetchSubredditPosts(subreddit, sort, timeFilter, limit, after) {
		return (await Try.async(async () => {
			const sub = normalizeSubreddit(subreddit);
			const basePath = sub === "" ? "" : `/r/${sub}`;
			const sortPath = sort === "hot" ? "" : `/${sort}`;
			const params = new URLSearchParams();
			if (timeFilter && (sort === "top" || sort === "controversial")) params.set("t", timeFilter);
			if (limit !== void 0) params.set("limit", String(limit));
			if (after !== void 0) params.set("after", after);
			const url = `https://www.reddit.com${basePath}${sortPath}/.rss${params.size > 0 ? `?${params}` : ""}`;
			const cached = this.cache.get(url);
			if (cached && Date.now() < cached.expiresAt) return cached.page;
			const response = await fetch(url, { headers: { "User-Agent": this.userAgent } });
			if (response.status === 429) throw new HttpError(429, "RSS rate limit exceeded (~1 req/min for unauthenticated feeds). Try again shortly.");
			if (!response.ok) throw new HttpError(response.status, `RSS feed request failed: ${response.status} ${response.statusText}`);
			const allItems = parseAtomFeed(await response.text()).map(atomEntryToRedditPost);
			const cap = limit ?? 25;
			const items = allItems.length > cap ? allItems.slice(0, cap) : allItems;
			const afterCursor = allItems.length > items.length ? `t3_${items[items.length - 1].id}` : void 0;
			const page = {
				items,
				source: "rss",
				...afterCursor ? { after: afterCursor } : {}
			};
			this.cache.set(url, {
				page,
				expiresAt: Date.now() + RSS_CACHE_TTL_MS
			});
			return page;
		})).toEither((error) => classifyRedditError(error, "RSS fetch"));
	}
};
// src/client/reddit-client.ts
function listingCursor(data) {
	const after = typeof data.after === "string" ? { after: data.after } : {};
	const before = typeof data.before === "string" ? { before: data.before } : {};
	return {
		...after,
		...before
	};
}
function withIgnoredSortNotice(page, sort) {
	if (sort === void 0 || sort === "new") return page;
	return {
		...page,
		notice: `Archive results are newest-first; sort="${sort}" was ignored.`
	};
}
var RedditClient = class {
	clientId;
	clientSecret;
	userAgent;
	username;
	password;
	baseUrl;
	authMode;
	hasCredentials;
	safeMode;
	botDisclosure;
	cache;
	retry;
	rssClient;
	arctic;
	keyless;
	accessToken;
	tokenExpiry = 0;
	authenticated = false;
	lastWriteTime = 0;
	recentContentRecords = [];
	constructor(config) {
		var _config$cache;
		this.clientId = config.clientId;
		this.clientSecret = config.clientSecret;
		this.userAgent = config.userAgent;
		this.username = config.username;
		this.password = config.password;
		this.authMode = config.authMode ?? "auto";
		this.hasCredentials = Boolean(this.clientId && this.clientSecret);
		this.baseUrl = this.determineBaseUrl();
		this.safeMode = config.safeMode ?? {
			enabled: false,
			mode: "off",
			writeDelayMs: 0,
			duplicateCheck: false,
			maxRecentHashes: 10
		};
		this.botDisclosure = config.botDisclosure ?? {
			enabled: false,
			footer: ""
		};
		this.cache = ((_config$cache = config.cache) === null || _config$cache === void 0 ? void 0 : _config$cache.enabled) === true ? new ResponseCache({ maxBytes: config.cache.maxBytes }) : void 0;
		this.retry = config.retry ?? {
			maxRetries: 3,
			baseDelayMs: 1e3,
			maxDelayMs: 6e4
		};
		this.keyless = this.authMode === "anonymous" || this.authMode === "auto" && !this.hasCredentials;
		this.rssClient = new RssClient(this.userAgent);
		this.arctic = new ArcticShiftClient(this.userAgent, this.cache);
	}
	determineBaseUrl() {
		switch (this.authMode) {
			case "authenticated": return "https://oauth.reddit.com";
			case "anonymous": return "https://www.reddit.com";
			case "auto": return this.hasCredentials ? "https://oauth.reddit.com" : "https://www.reddit.com";
		}
	}
	async makeRequest(path, options = {}) {
		return (await Try.async(async () => {
			const url = `${this.baseUrl}${path}`;
			const method = (options.method ?? "GET").toUpperCase();
			const cacheable = this.cache !== void 0 && method === "GET";
			if (cacheable) {
				const cached = this.cache.get(url);
				if (cached !== void 0) return new Response(cached.body, { status: cached.status });
			}
			const requiresAuth = this.authMode === "authenticated" || this.authMode === "auto" && this.hasCredentials;
			if (requiresAuth && (Date.now() >= this.tokenExpiry || !this.authenticated)) (await this.authenticate()).orThrow();
			const headers = {
				"User-Agent": this.userAgent,
				...options.headers
			};
			if (requiresAuth && this.accessToken !== void 0) headers["Authorization"] = `Bearer ${this.accessToken}`;
			const first = await this.fetchWithRetry(url, options, headers, path, 0);
			const response = first.status === 401 && this.authenticated ? await this.fetchWithRetry(url, options, {
				...headers,
				Authorization: await this.reauthorize()
			}, path, 0) : first;
			if (cacheable && response.ok) {
				const text = await response.text();
				this.cache.set(url, text, response.status);
				return new Response(text, { status: response.status });
			}
			return response;
		})).toEither((error) => error);
	}
	async authenticate() {
		if (this.authMode === "anonymous") {
			this.authenticated = false;
			return Right(void 0);
		}
		if (this.authMode === "authenticated" && !this.hasCredentials) return Left(/* @__PURE__ */ new Error("Authenticated mode requires REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET"));
		if (this.authMode === "auto" && !this.hasCredentials) {
			this.authenticated = false;
			return Right(void 0);
		}
		return (await Try.async(async () => {
			const now = Date.now();
			if (this.accessToken !== void 0 && now < this.tokenExpiry) return;
			const authUrl = "https://www.reddit.com/api/v1/access_token";
			const authData = new URLSearchParams();
			const { username } = this;
			const { password } = this;
			if (Boolean(username && password) && username !== void 0 && password !== void 0) {
				authData.append("grant_type", "password");
				authData.append("username", username);
				authData.append("password", password);
			} else authData.append("grant_type", "client_credentials");
			const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
			const response = await fetch(authUrl, {
				method: "POST",
				headers: {
					"User-Agent": this.userAgent,
					"Content-Type": "application/x-www-form-urlencoded",
					Authorization: `Basic ${credentials}`
				},
				body: authData.toString()
			});
			if (!response.ok) {
				const statusText = response.statusText !== "" ? response.statusText : "Unknown Error";
				throw new Error(`Authentication failed: ${response.status} ${statusText}`);
			}
			const data = await response.json();
			this.accessToken = data.access_token;
			this.tokenExpiry = now + data.expires_in * 1e3;
			this.authenticated = true;
		})).toEither((error) => error);
	}
	async checkAuthentication() {
		if (!this.authenticated) return (await this.authenticate()).isRight();
		return true;
	}
	validateWriteAccess() {
		if (this.keyless) throw new NotAuthenticatedError("Write operations require OAuth credentials (REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET) in addition to REDDIT_USERNAME and REDDIT_PASSWORD.");
		if (this.username === void 0 || this.password === void 0) throw new NotAuthenticatedError("Write operations require REDDIT_USERNAME and REDDIT_PASSWORD");
	}
	async enforceWriteRateLimit() {
		if (!this.safeMode.enabled || this.safeMode.writeDelayMs <= 0) return;
		const elapsed = Date.now() - this.lastWriteTime;
		if (elapsed < this.safeMode.writeDelayMs) {
			const waitTime = this.safeMode.writeDelayMs - elapsed;
			console.error(`[SafeMode] Rate limit: waiting ${waitTime}ms before write operation`);
			await new Promise((resolve) => setTimeout(resolve, waitTime));
		}
		this.lastWriteTime = Date.now();
	}
	hashContent(content) {
		return crypto.createHash("sha256").update(content.trim().toLowerCase()).digest("hex");
	}
	checkDuplicateContent(content, subreddit) {
		if (!this.safeMode.enabled || !this.safeMode.duplicateCheck) return;
		const hash = this.hashContent(content);
		const duplicate = this.recentContentRecords.find((record) => record.hash === hash);
		if (duplicate !== void 0) {
			if (subreddit !== void 0 && duplicate.subreddit !== "" && subreddit !== duplicate.subreddit) throw new ValidationError("Cross-subreddit duplicate detected. Reddit's Responsible Builder Policy prohibits posting identical or substantially similar content across multiple subreddits. Please create unique content for each subreddit.");
			throw new ValidationError("Duplicate content detected. Reddit's spam filter may ban your account for posting identical content. Please modify your content and try again.");
		}
		this.recentContentRecords.push({
			hash,
			subreddit: subreddit ?? "",
			timestamp: Date.now()
		});
		this.recentContentRecords = this.recentContentRecords.slice(-this.safeMode.maxRecentHashes);
	}
	async reauthorize() {
		(await this.authenticate()).orThrow();
		return `Bearer ${this.accessToken}`;
	}
	async fetchWithRetry(url, options, headers, path, attempt) {
		const response = await fetch(url, {
			...options,
			headers
		});
		if (response.status !== 429 || attempt >= this.retry.maxRetries) return response;
		const wait = this.retryAfterMs(response).fold(() => Math.min(this.retry.baseDelayMs * 2 ** attempt, this.retry.maxDelayMs), (ms) => ms);
		if (wait > this.retry.maxDelayMs) return response;
		console.error(`[RateLimit] 429 from ${path} — retry ${attempt + 1}/${this.retry.maxRetries} in ${wait}ms`);
		await new Promise((resolve) => setTimeout(resolve, wait));
		return this.fetchWithRetry(url, options, headers, path, attempt + 1);
	}
	retryAfterMs(response) {
		const { headers } = response;
		const retryAfter = headers.get("retry-after");
		if (retryAfter !== null && retryAfter !== "") {
			const seconds = Number(retryAfter);
			if (!Number.isNaN(seconds)) return Option(seconds * 1e3);
			const when = Date.parse(retryAfter);
			if (!Number.isNaN(when)) return Option(Math.max(0, when - Date.now()));
		}
		const reset = headers.get("x-ratelimit-reset");
		if (reset !== null && reset !== "") {
			const seconds = Number(reset);
			if (!Number.isNaN(seconds)) return Option(seconds * 1e3);
		}
		return Option.none();
	}
	appendBotDisclosure(content) {
		if (!this.botDisclosure.enabled || this.botDisclosure.footer === "") return content;
		return `${content}${this.botDisclosure.footer}`;
	}
	requiresOAuthError(tool) {
		return Left(new NotAuthenticatedError(`${tool} requires OAuth credentials (REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET). Keyless mode (RSS feeds and the Arctic Shift archive) cannot provide it.`));
	}
	async keylessListing(subreddit, sort, timeFilter, limit, after) {
		const archivable = subreddit.trim() !== "" && !subreddit.includes("+");
		if (sort === "new" && archivable) return this.arctic.listSubredditPosts(subreddit, limit, after);
		const rss = await this.rssClient.fetchSubredditPosts(subreddit, sort, timeFilter, limit, after);
		const rssProblem = rss.fold((error) => Option(`failed (${error.message})`), (page) => page.items.length === 0 ? Option("returned no posts") : Option.none());
		const cursorFitsArchive = after === void 0 || isArchiveCursor(after);
		if (rssProblem.isEmpty || !archivable || !cursorFitsArchive) return rss;
		return (await this.arctic.listSubredditPosts(subreddit, limit, after)).map((page) => ({
			...page,
			notice: `The RSS feed ${rssProblem.orElse("failed")}, so these are the newest posts from the Arctic Shift archive, not "${sort}" ranking.`
		}));
	}
	async keylessSearch(query, type, options) {
		if (type === "sr") return this.arctic.searchSubreddits(query, options.limit);
		if (type === "user") return Left(new NotAuthenticatedError("search_reddit type=user requires OAuth credentials. Use get_user_info with an exact username instead."));
		return this.arctic.searchPosts(query, options);
	}
	async getUser(username) {
		if (this.keyless) return this.arctic.getUser(username);
		const context = `Failed to get user info for ${username}`;
		return (await Try.async(async () => {
			const response = (await this.makeRequest(`/user/${normalizeUsername(username)}/about.json`)).orThrow();
			if (!response.ok) throw new HttpError(response.status, `${context}: HTTP ${response.status}`);
			const { data } = await response.json();
			return {
				name: data.name,
				id: data.id,
				commentKarma: data.comment_karma,
				linkKarma: data.link_karma,
				totalKarma: data.total_karma ?? data.comment_karma + data.link_karma,
				isMod: data.is_mod,
				isGold: data.is_gold,
				isEmployee: data.is_employee,
				createdUtc: data.created_utc,
				profileUrl: `https://reddit.com/user/${data.name}`
			};
		})).toEither((error) => classifyRedditError(error, context));
	}
	async getUserContent(path, context) {
		return (await Try.async(async () => {
			const response = (await this.makeRequest(path)).orThrow();
			if (!response.ok) throw new HttpError(response.status, `${context}: HTTP ${response.status}`);
			const json = await response.json();
			return {
				posts: json.data.children.filter((child) => child.kind === "t3").map((child) => parsePostData(child.data)),
				comments: json.data.children.filter((child) => child.kind === "t1").map((child) => parseCommentData(child.data)),
				...listingCursor(json.data)
			};
		})).toEither((error) => classifyRedditError(error, context));
	}
	async getMyOverview(options = {}) {
		if (this.keyless) return this.requiresOAuthError("get_my_overview");
		if (this.username === void 0) return Left(new NotAuthenticatedError("Fetching your overview requires REDDIT_USERNAME"));
		const { limit = 25, after } = options;
		const params = new URLSearchParams({ limit: limit.toString() });
		if (after !== void 0) params.set("after", after);
		return this.getUserContent(`/user/${encodeURIComponent(this.username)}/overview.json?${params}`, "Failed to get your overview");
	}
	async getMySaved(options = {}) {
		if (this.keyless) return this.requiresOAuthError("get_my_saved");
		if (this.username === void 0) return Left(new NotAuthenticatedError("Fetching saved content requires REDDIT_USERNAME"));
		const { limit = 25, after } = options;
		const params = new URLSearchParams({ limit: limit.toString() });
		if (after !== void 0) params.set("after", after);
		return this.getUserContent(`/user/${encodeURIComponent(this.username)}/saved.json?${params}`, "Failed to get saved content");
	}
	async getMe() {
		if (this.keyless) return this.requiresOAuthError("get_me");
		if (this.username === void 0) return Left(new NotAuthenticatedError("Fetching your account requires REDDIT_USERNAME"));
		const context = "Failed to get authenticated user info";
		return (await Try.async(async () => {
			const response = (await this.makeRequest("/api/v1/me")).orThrow();
			if (!response.ok) throw new HttpError(response.status, `${context}: HTTP ${response.status}`);
			const data = await response.json();
			return {
				name: data.name,
				id: data.id,
				commentKarma: data.comment_karma,
				linkKarma: data.link_karma,
				totalKarma: data.total_karma ?? data.comment_karma + data.link_karma,
				isMod: data.is_mod,
				isGold: data.is_gold,
				isEmployee: data.is_employee,
				createdUtc: data.created_utc,
				profileUrl: `https://reddit.com/user/${data.name}`
			};
		})).toEither((error) => classifyRedditError(error, context));
	}
	async getSubredditInfo(subredditName) {
		if (this.keyless) return this.arctic.getSubredditInfo(subredditName);
		const context = `Failed to get subreddit info for ${subredditName}`;
		return (await Try.async(async () => {
			const response = (await this.makeRequest(`/r/${normalizeSubreddit(subredditName)}/about.json`)).orThrow();
			if (!response.ok) throw new HttpError(response.status, `${context}: HTTP ${response.status}`);
			return parseSubredditData((await response.json()).data);
		})).toEither((error) => classifyRedditError(error, context));
	}
	async getSubredditRules(subreddit) {
		if (this.keyless) return this.arctic.getSubredditRules(subreddit);
		const context = `Failed to get rules for r/${subreddit}`;
		return (await Try.async(async () => {
			const response = (await this.makeRequest(`/r/${normalizeSubreddit(subreddit)}/about/rules.json`)).orThrow();
			if (!response.ok) throw new HttpError(response.status, `${context}: HTTP ${response.status}`);
			return (await response.json()).rules.map(parseRuleData);
		})).toEither((error) => classifyRedditError(error, context));
	}
	async getPostFlairs(subreddit) {
		if (this.keyless) return this.requiresOAuthError("get_post_flairs");
		const context = `Failed to get post flairs for r/${subreddit}`;
		return (await Try.async(async () => {
			const response = (await this.makeRequest(`/r/${normalizeSubreddit(subreddit)}/api/link_flair_v2.json`)).orThrow();
			if (!response.ok) throw new HttpError(response.status, `${context}: HTTP ${response.status}`);
			return (await response.json()).map((flair) => ({
				id: flair.id,
				text: flair.text,
				type: flair.type,
				textEditable: flair.text_editable
			}));
		})).toEither((error) => classifyRedditError(error, context));
	}
	async getTopPosts(subreddit, timeFilter = "week", limit = 10, after) {
		if (this.keyless) return this.keylessListing(subreddit, "top", timeFilter, limit, after);
		const params = new URLSearchParams({
			t: timeFilter,
			limit: limit.toString()
		});
		if (after !== void 0) params.set("after", after);
		const context = `Failed to get top posts for ${subreddit !== "" ? subreddit : "home"}`;
		return (await Try.async(async () => {
			const name = normalizeSubreddit(subreddit);
			const endpoint = name !== "" ? `/r/${name}/top.json` : "/top.json";
			const response = (await this.makeRequest(`${endpoint}?${params}`)).orThrow();
			if (!response.ok) throw new HttpError(response.status, `Failed to get top posts: HTTP ${response.status}`);
			const json = await response.json();
			return {
				items: json.data.children.map((child) => parsePostData(child.data)),
				...listingCursor(json.data)
			};
		})).toEither((error) => classifyRedditError(error, context));
	}
	async browseSubreddit(subreddit, sort = "hot", timeFilter = "week", limit = 10, after) {
		const validSorts = [
			"hot",
			"new",
			"top",
			"rising",
			"controversial"
		];
		if (!validSorts.includes(sort)) return Left(new ValidationError(`Invalid sort "${sort}". Valid options are: ${validSorts.join(", ")}`));
		if (this.keyless) return this.keylessListing(subreddit, sort, timeFilter, limit, after);
		const params = new URLSearchParams({ limit: limit.toString() });
		if (sort === "top" || sort === "controversial") params.set("t", timeFilter);
		if (after !== void 0) params.set("after", after);
		const home = subreddit !== "" ? subreddit : "home";
		const context = `Failed to browse r/${home} (${sort})`;
		return (await Try.async(async () => {
			const name = normalizeSubreddit(subreddit);
			const endpoint = name !== "" ? `/r/${name}/${sort}.json` : `/${sort}.json`;
			const response = (await this.makeRequest(`${endpoint}?${params}`)).orThrow();
			if (!response.ok) throw new HttpError(response.status, `Failed to browse r/${home}: HTTP ${response.status}`);
			const json = await response.json();
			return {
				items: json.data.children.map((child) => parsePostData(child.data)),
				...listingCursor(json.data)
			};
		})).toEither((error) => classifyRedditError(error, context));
	}
	async getPost(postId, subreddit) {
		if (this.keyless) return this.arctic.getPost(postId);
		const context = `Failed to get post with ID ${postId}`;
		return (await Try.async(async () => {
			const id = normalizeThingId(postId);
			const endpoint = Option(subreddit).fold(() => `/api/info.json?id=t3_${id}`, (sr) => `/r/${normalizeSubreddit(sr)}/comments/${id}.json`);
			const response = (await this.makeRequest(endpoint)).orThrow();
			if (!response.ok) throw new HttpError(response.status, `${context}: HTTP ${response.status}`);
			if (subreddit !== void 0) return parsePostData((await response.json())[0].data.children[0].data);
			const json = await response.json();
			if (json.data.children.length === 0) throw new NotFoundError(`Post with ID ${postId} not found`);
			return parsePostData(json.data.children[0].data);
		})).toEither((error) => classifyRedditError(error, context));
	}
	async getTrendingSubreddits(limit = 5) {
		if (this.keyless) return this.requiresOAuthError("get_trending_subreddits");
		const params = new URLSearchParams({ limit: limit.toString() });
		const context = `Failed to get trending subreddits`;
		return (await Try.async(async () => {
			const response = (await this.makeRequest(`/subreddits/popular.json?${params}`)).orThrow();
			if (!response.ok) throw new HttpError(response.status, `${context}: HTTP ${response.status}`);
			return (await response.json()).data.children.map((child) => child.data.display_name);
		})).toEither((error) => classifyRedditError(error, context));
	}
	async createPost(subreddit, title, content, isSelf = true, flairId, flairText) {
		return (await Try.async(async () => {
			var _json$json$data, _json$json$data2;
			this.validateWriteAccess();
			await this.enforceWriteRateLimit();
			this.checkDuplicateContent(title + content, subreddit);
			const targetSubreddit = normalizeSubreddit(subreddit);
			if (targetSubreddit === "") throw new ValidationError("A subreddit is required to create a post.");
			const finalContent = isSelf ? this.appendBotDisclosure(content) : content;
			const kind = isSelf ? "self" : "link";
			const params = new URLSearchParams();
			params.append("sr", targetSubreddit);
			params.append("kind", kind);
			params.append("title", title);
			params.append(isSelf ? "text" : "url", finalContent);
			params.append("api_type", "json");
			if (flairId !== void 0) params.append("flair_id", flairId);
			if (flairText !== void 0) params.append("flair_text", flairText);
			const response = (await this.makeRequest("/api/submit", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: params.toString()
			})).orThrow();
			if (!response.ok) throw new HttpError(response.status, `Failed to create post: HTTP ${response.status}`);
			const json = await response.json();
			if (json.json.errors !== void 0 && json.json.errors.length > 0) throw new ApiError(`Reddit API errors: ${json.json.errors.map((e) => e[1]).join(", ")}`);
			const postId = ((_json$json$data = json.json.data) === null || _json$json$data === void 0 ? void 0 : _json$json$data.id) ?? ((_json$json$data2 = json.json.data) === null || _json$json$data2 === void 0 || (_json$json$data2 = _json$json$data2.name) === null || _json$json$data2 === void 0 ? void 0 : _json$json$data2.replace("t3_", ""));
			if (postId === void 0) throw new ApiError("No post ID returned from Reddit");
			return (await this.getPost(postId, targetSubreddit)).orThrow();
		})).toEither((error) => classifyRedditError(error));
	}
	async checkPostExists(postId) {
		return (await Try.async(async () => {
			const response = (await this.makeRequest(`/api/info.json?id=t3_${normalizeThingId(postId)}`)).orThrow();
			if (!response.ok) return false;
			return (await response.json()).data.children.length > 0;
		})).orElse(false);
	}
	async replyToPost(postId, content) {
		return (await Try.async(async () => {
			var _json$json$data3;
			this.validateWriteAccess();
			await this.enforceWriteRateLimit();
			this.checkDuplicateContent(content);
			const finalContent = this.appendBotDisclosure(content);
			const fullThingId = normalizeFullname(postId, "t3");
			if (!fullThingId.startsWith("t1_")) {
				if (!await this.checkPostExists(normalizeThingId(postId))) throw new NotFoundError(`Post with ID ${postId} does not exist or is not accessible`);
			}
			const params = new URLSearchParams();
			params.append("thing_id", fullThingId);
			params.append("text", finalContent);
			params.append("api_type", "json");
			const response = (await this.makeRequest("/api/comment", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: params.toString()
			})).orThrow();
			if (!response.ok) throw new HttpError(response.status, `Failed to reply: HTTP ${response.status}`);
			const json = await response.json();
			if (((_json$json$data3 = json.json.data) === null || _json$json$data3 === void 0 ? void 0 : _json$json$data3.things) !== void 0 && json.json.data.things.length > 0) {
				const commentData = json.json.data.things[0].data;
				const author = this.username ?? "[unknown]";
				return {
					id: commentData.id,
					author,
					body: content,
					score: 1,
					controversiality: 0,
					subreddit: commentData.subreddit,
					submissionTitle: commentData.link_title ?? "",
					createdUtc: Date.now() / 1e3,
					edited: false,
					isSubmitter: false,
					permalink: commentData.permalink
				};
			} else if (json.json.errors !== void 0 && json.json.errors.length > 0) throw new ApiError(`Reddit API errors: ${json.json.errors.map((e) => e[1]).join(", ")}`);
			else throw new ApiError("Failed to parse reply response");
		})).toEither((error) => classifyRedditError(error));
	}
	async deleteThing(thingId, defaultKind) {
		return (await Try.async(async () => {
			this.validateWriteAccess();
			const fullThingId = normalizeFullname(thingId, defaultKind);
			const params = new URLSearchParams();
			params.append("id", fullThingId);
			const response = (await this.makeRequest("/api/del", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: params.toString()
			})).orThrow();
			if (!response.ok) {
				const errorText = await response.text();
				console.error(`[Reddit API] Delete failed: ${response.status} ${response.statusText}`);
				console.error(`[Reddit API] Error response: ${errorText}`);
				throw new HttpError(response.status, `HTTP ${response.status}: ${errorText}`);
			}
			console.error(`[Reddit API] Successfully deleted ${fullThingId}`);
			return true;
		})).toEither((error) => {
			if (!isRedditError(error)) console.error(`[Reddit API] Delete exception:`, error);
			return classifyRedditError(error);
		});
	}
	async deletePost(thingId) {
		return this.deleteThing(thingId, "t3");
	}
	async deleteComment(thingId) {
		return this.deleteThing(thingId, "t1");
	}
	async editThing(thingId, newText, defaultKind) {
		return (await Try.async(async () => {
			this.validateWriteAccess();
			await this.enforceWriteRateLimit();
			this.checkDuplicateContent(newText);
			const finalText = this.appendBotDisclosure(newText);
			const fullThingId = normalizeFullname(thingId, defaultKind);
			const params = new URLSearchParams();
			params.append("thing_id", fullThingId);
			params.append("text", finalText);
			params.append("api_type", "json");
			const response = (await this.makeRequest("/api/editusertext", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: params.toString()
			})).orThrow();
			if (!response.ok) throw new HttpError(response.status, `Failed to edit: HTTP ${response.status}`);
			const json = await response.json();
			if (json.json.errors !== void 0 && json.json.errors.length > 0) throw new ApiError(`Reddit API errors: ${json.json.errors.map((e) => e[1]).join(", ")}`);
			return true;
		})).toEither((error) => classifyRedditError(error));
	}
	async editPost(thingId, newText) {
		return this.editThing(thingId, newText, "t3");
	}
	async editComment(thingId, newText) {
		return this.editThing(thingId, newText, "t1");
	}
	async setSaved(thingId, saved, category) {
		return (await Try.async(async () => {
			this.validateWriteAccess();
			const fullThingId = normalizeFullname(thingId, "t3");
			const params = new URLSearchParams();
			params.append("id", fullThingId);
			if (saved && category !== void 0) params.append("category", category);
			const response = (await this.makeRequest(saved ? "/api/save" : "/api/unsave", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: params.toString()
			})).orThrow();
			if (!response.ok) throw new HttpError(response.status, `Failed to ${saved ? "save" : "unsave"}: HTTP ${response.status}`);
			return true;
		})).toEither((error) => classifyRedditError(error));
	}
	async saveContent(thingId, category) {
		return this.setSaved(thingId, true, category);
	}
	async unsaveContent(thingId) {
		return this.setSaved(thingId, false);
	}
	async searchReddit(query, options = {}) {
		const { subreddit, sort = "relevance", timeFilter = "all", limit = 25, type = "link", after, before } = options;
		if (this.keyless) {
			const page = await this.keylessSearch(query, type, {
				subreddit,
				limit,
				after,
				timeFilter
			});
			return type === "sr" || sort === "relevance" ? page : page.map((p) => withIgnoredSortNotice(p, sort));
		}
		const params = new URLSearchParams({
			q: query,
			sort,
			t: timeFilter,
			limit: limit.toString(),
			type,
			...subreddit !== void 0 ? { restrict_sr: "true" } : {},
			...after !== void 0 ? { after } : {},
			...before !== void 0 ? { before } : {}
		});
		const context = `Failed to search Reddit for: ${query}`;
		return (await Try.async(async () => {
			const endpoint = Option(subreddit).fold(() => "/search.json", (sr) => `/r/${normalizeSubreddit(sr)}/search.json`);
			const response = (await this.makeRequest(`${endpoint}?${params}`)).orThrow();
			if (!response.ok) throw new HttpError(response.status, `Failed to search Reddit: HTTP ${response.status}`);
			const json = await response.json();
			return {
				items: json.data.children.flatMap((child) => {
					if (child.kind === "t3") return [parsePostData(child.data)];
					if (child.kind === "t5") return [parseSubredditSearchData(child.data)];
					if (child.kind === "t2") return [parseUserSearchData(child.data)];
					return [];
				}),
				...listingCursor(json.data)
			};
		})).toEither((error) => classifyRedditError(error, context));
	}
	async getPostComments(postId, subreddit, options = {}) {
		if (this.keyless) return this.arctic.getPostComments(postId, options.limit);
		const { sort = "best", limit = 100 } = options;
		const params = new URLSearchParams({
			sort,
			limit: limit.toString()
		});
		const context = `Failed to get comments for post ${postId}`;
		return (await Try.async(async () => {
			const response = (await this.makeRequest(`/r/${normalizeSubreddit(subreddit)}/comments/${normalizeThingId(postId)}.json?${params}`)).orThrow();
			if (!response.ok) throw new HttpError(response.status, `Failed to get comments: HTTP ${response.status}`);
			const json = await response.json();
			const postData = json[0].data.children[0].data;
			const post = parsePostData(postData);
			return {
				post,
				comments: parseCommentTree(json[1].data.children, post.title),
				moreIds: collectMoreIds(json[1].data.children)
			};
		})).toEither((error) => classifyRedditError(error, context));
	}
	async getMoreComments(linkId, commentIds) {
		if (this.keyless) return this.arctic.getComments(commentIds);
		const context = `Failed to expand comments for ${linkId}`;
		return (await Try.async(async () => {
			var _json$json$data4;
			const params = new URLSearchParams({
				api_type: "json",
				link_id: normalizeFullname(linkId, "t3"),
				children: commentIds.map((id) => normalizeThingId(id)).join(",")
			});
			const response = (await this.makeRequest(`/api/morechildren?${params}`)).orThrow();
			if (!response.ok) throw new HttpError(response.status, `${context}: HTTP ${response.status}`);
			return (((_json$json$data4 = (await response.json()).json.data) === null || _json$json$data4 === void 0 ? void 0 : _json$json$data4.things) ?? []).filter((thing) => thing.kind === "t1" && thing.data.body !== void 0).map((thing) => parseCommentData(thing.data));
		})).toEither((error) => classifyRedditError(error, context));
	}
	async getUserPosts(username, options = {}) {
		if (this.keyless) return (await this.arctic.getUserPosts(username, options.limit, options.after)).map((p) => withIgnoredSortNotice(p, options.sort));
		const { sort = "new", timeFilter = "all", limit = 25, after } = options;
		const params = new URLSearchParams({
			sort,
			t: timeFilter,
			limit: limit.toString()
		});
		if (after !== void 0) params.set("after", after);
		const context = `Failed to get posts for user ${username}`;
		return (await Try.async(async () => {
			const response = (await this.makeRequest(`/user/${normalizeUsername(username)}/submitted.json?${params}`)).orThrow();
			if (!response.ok) throw new HttpError(response.status, `${context}: HTTP ${response.status}`);
			const json = await response.json();
			return {
				items: json.data.children.filter((child) => child.kind === "t3").map((child) => parsePostData(child.data)),
				...listingCursor(json.data)
			};
		})).toEither((error) => classifyRedditError(error, context));
	}
	async getUserComments(username, options = {}) {
		if (this.keyless) return (await this.arctic.getUserComments(username, options.limit, options.after)).map((p) => withIgnoredSortNotice(p, options.sort));
		const { sort = "new", timeFilter = "all", limit = 25, after } = options;
		const params = new URLSearchParams({
			sort,
			t: timeFilter,
			limit: limit.toString()
		});
		if (after !== void 0) params.set("after", after);
		const context = `Failed to get comments for user ${username}`;
		return (await Try.async(async () => {
			const response = (await this.makeRequest(`/user/${normalizeUsername(username)}/comments.json?${params}`)).orThrow();
			if (!response.ok) throw new HttpError(response.status, `${context}: HTTP ${response.status}`);
			const json = await response.json();
			return {
				items: json.data.children.filter((child) => child.kind === "t1").map((child) => parseCommentData(child.data)),
				...listingCursor(json.data)
			};
		})).toEither((error) => classifyRedditError(error, context));
	}
};
const clientHolder = { instance: Option.none() };
function initializeRedditClient(config) {
	const client = new RedditClient(config);
	clientHolder.instance = Option(client);
	return client;
}
function getRedditClient() {
	return clientHolder.instance;
}
// src/utils/env.ts
/**
* Read an environment variable, treating an empty or whitespace-only value as unset.
*
* dotenv turns a `KEY=` line into an empty string, so a copied `.env.example` would
* otherwise read as configured: `OAUTH_TOKEN=` locked out every HTTP client, and
* `REDDIT_AUTH_MODE=authenticated` with blank credentials started keyless instead of failing.
* The value is returned as written; it is not trimmed, so a password may contain spaces.
*/
function readEnv(name, env = process.env) {
	return Option(env[name]).filter((value) => value.trim() !== "");
}
/** True when both `REDDIT_USERNAME` and `REDDIT_PASSWORD` are set to non-blank values. */
function hasUserCredentials(env = process.env) {
	return readEnv("REDDIT_USERNAME", env).isSome() && readEnv("REDDIT_PASSWORD", env).isSome();
}
// src/utils/formatters.ts
function formatTimestamp(timestamp) {
	return Try(() => {
		return (/* @__PURE__ */ new Date(timestamp * 1e3)).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
	}).orElse(String(timestamp));
}
function analyzeUserActivity(karmaRatio, isMod, accountAgeDays) {
	return [
		...karmaRatio > 5 ? ["Primarily a commenter, highly engaged in discussions"] : karmaRatio < .2 ? ["Content creator, focuses on sharing posts"] : ["Balanced participation in both posting and commenting"],
		...accountAgeDays < 30 ? ["New user, still exploring Reddit"] : accountAgeDays > 1825 ? ["Long-time Redditor with extensive platform experience"] : [],
		...isMod ? ["Community leader who helps maintain subreddit quality"] : []
	].join("\n  - ");
}
function analyzePostEngagement(score, ratio, numComments) {
	const insights = [...score > 1e3 && ratio > .95 ? ["Highly successful post with strong community approval"] : score > 100 && ratio > .8 ? ["Well-received post with good engagement"] : ratio < .5 ? ["Controversial post that sparked debate"] : [], ...numComments > 100 ? ["Generated significant discussion"] : numComments > score * .5 ? ["Highly discussable content with active comment section"] : numComments === 0 ? ["Yet to receive community interaction"] : []];
	return insights.length > 0 ? insights.join("\n  - ") : "Moderate engagement with no standout signals";
}
function analyzeSubredditHealth(subscribers, activeUsers, ageDays) {
	const sizeInsights = subscribers > 1e6 ? ["Major subreddit with massive following"] : subscribers > 1e5 ? ["Well-established community"] : subscribers < 1e3 ? ["Niche community, potential for growth"] : [];
	const activityInsights = activeUsers.map((active) => active / subscribers).fold(() => [], (activityRatio) => activityRatio > .1 ? ["Highly active community with strong engagement"] : activityRatio < .01 ? ["Could benefit from more community engagement initiatives"] : []);
	const ageInsights = ageDays > 1825 ? ["Mature subreddit with established culture"] : ageDays < 90 ? ["New subreddit still forming its community"] : [];
	const insights = [
		...sizeInsights,
		...activityInsights,
		...ageInsights
	];
	const fallback = activeUsers.isEmpty ? "Mid-sized community with no standout age signals; active-user count unavailable" : "Mid-sized community with no standout activity or age signals";
	return insights.length > 0 ? insights.join("\n  - ") : fallback;
}
function getUserRecommendations(karmaRatio, isMod, accountAgeDays) {
	const recommendations = [
		...karmaRatio > 5 ? ["Consider creating more posts to share your expertise"] : karmaRatio < .2 ? ["Engage more in discussions to build community connections"] : [],
		...accountAgeDays < 30 ? ["Explore popular subreddits in your areas of interest", "Read community guidelines before posting"] : [],
		...isMod ? ["Share moderation insights with other community leaders"] : []
	];
	return recommendations.length > 0 ? recommendations.join("\n  - ") : "Maintain your balanced engagement across Reddit";
}
function getBestEngagementTime(createdUtc) {
	const postHour = (/* @__PURE__ */ new Date(createdUtc * 1e3)).getHours();
	if (14 <= postHour && postHour <= 18) return "Posted during peak engagement hours (2 PM - 6 PM), good timing!";
	else if (23 <= postHour || postHour <= 5) return "Consider posting during more active hours (morning to evening)";
	else return "Posted during moderate activity hours, timing could be optimized";
}
function getSubredditEngagementTips(subreddit) {
	const sizeTips = subreddit.subscribers > 1e6 ? ["Post during peak hours for maximum visibility", "Ensure content is highly polished due to high competition"] : subreddit.subscribers < 1e3 ? ["Engage actively to help grow the community", "Consider cross-posting to related larger subreddits"] : [];
	const activityTips = Option(subreddit.activeUserCount).map((active) => active / subreddit.subscribers).fold(() => [], (activityRatio) => activityRatio > .1 ? ["Quick responses recommended due to high activity"] : []);
	const allTips = [...sizeTips, ...activityTips];
	return allTips.length > 0 ? allTips.join("\n  - ") : "Regular engagement recommended to maintain community presence";
}
function analyzeCommentImpact(score, isEdited, isOp) {
	const insights = [
		...score > 100 ? ["Highly upvoted comment with significant community agreement"] : score < 0 ? ["Controversial or contested viewpoint"] : [],
		...isEdited ? ["Refined for clarity or accuracy"] : [],
		...isOp ? ["Author's perspective adds context to original post"] : []
	];
	return insights.length > 0 ? insights.join("\n  - ") : "Standard engagement with discussion";
}
function formatUserInfo(user) {
	const accountAgeDays = (Date.now() / 1e3 - user.createdUtc) / 86400;
	const karmaRatio = user.commentKarma / (user.linkKarma === 0 ? 1 : user.linkKarma);
	const status = [
		...user.isMod ? ["Moderator"] : [],
		...user.isGold ? ["Reddit Gold Member"] : [],
		...user.isEmployee ? ["Reddit Employee"] : []
	];
	return {
		username: user.name,
		karma: {
			commentKarma: user.commentKarma,
			postKarma: user.linkKarma,
			totalKarma: user.totalKarma
		},
		accountStatus: status.length > 0 ? status : ["Regular User"],
		accountCreated: formatTimestamp(user.createdUtc),
		profileUrl: user.profileUrl,
		activityAnalysis: analyzeUserActivity(karmaRatio, user.isMod, accountAgeDays),
		recommendations: getUserRecommendations(karmaRatio, user.isMod, accountAgeDays)
	};
}
const POST_CONTENT_MAX_LENGTH = 1e4;
const COMMENT_CONTENT_MAX_LENGTH = 5e3;
function truncateText(text, maxLength) {
	return text.length > maxLength ? `${text.substring(0, maxLength - 3)}...` : text;
}
function postContent(post) {
	const body = truncateText(post.selftext ?? "", POST_CONTENT_MAX_LENGTH);
	if (post.isSelf) return body;
	return [body, post.url ?? ""].filter((part) => part.length > 0).join("\n\n");
}
function formatPostInfo(post) {
	const contentType = post.isSelf ? "Text Post" : "Link Post";
	const flags = [
		...post.over18 ? ["NSFW"] : [],
		...post.spoiler === true ? ["Spoiler"] : [],
		...post.edited ? ["Edited"] : []
	];
	return {
		title: post.title,
		type: contentType,
		content: postContent(post),
		author: post.author,
		subreddit: post.subreddit,
		stats: {
			score: post.score,
			upvoteRatio: post.upvoteRatio,
			comments: post.numComments
		},
		metadata: {
			posted: formatTimestamp(post.createdUtc),
			flags,
			flair: post.linkFlairText ?? "None"
		},
		links: {
			fullPost: `https://reddit.com${post.permalink}`,
			shortLink: `https://redd.it/${post.id}`
		},
		engagementAnalysis: analyzePostEngagement(post.score, post.upvoteRatio, post.numComments),
		bestTimeToEngage: getBestEngagementTime(post.createdUtc)
	};
}
function formatSubredditInfo(subreddit) {
	const flags = [...subreddit.over18 ? ["NSFW"] : [], ...Option(subreddit.subredditType).fold(() => [], (type) => [`Type: ${type}`])];
	const ageDays = (Date.now() / 1e3 - subreddit.createdUtc) / 86400;
	return {
		name: subreddit.displayName,
		title: subreddit.title,
		stats: {
			subscribers: subreddit.subscribers,
			activeUsers: Option(subreddit.activeUserCount).fold(() => "Unknown", (count) => count)
		},
		description: {
			short: subreddit.publicDescription,
			full: subreddit.description.length > 300 ? `${subreddit.description.substring(0, 297)}...` : subreddit.description
		},
		metadata: {
			created: formatTimestamp(subreddit.createdUtc),
			flags: flags.length > 0 ? flags : ["None"]
		},
		links: {
			subreddit: `https://reddit.com${subreddit.url}`,
			wiki: `https://reddit.com/r/${subreddit.displayName}/wiki`
		},
		communityAnalysis: analyzeSubredditHealth(subreddit.subscribers, Option(subreddit.activeUserCount), ageDays),
		engagementTips: getSubredditEngagementTips(subreddit)
	};
}
function formatCommentInfo(comment, maxLength = COMMENT_CONTENT_MAX_LENGTH) {
	const flags = [...comment.edited ? ["Edited"] : [], ...comment.isSubmitter ? ["OP"] : []];
	return {
		author: comment.author,
		content: truncateText(comment.body, maxLength),
		stats: {
			score: comment.score,
			controversiality: comment.controversiality
		},
		context: {
			subreddit: comment.subreddit,
			thread: comment.submissionTitle
		},
		metadata: {
			posted: formatTimestamp(comment.createdUtc),
			flags: flags.length > 0 ? flags : ["None"]
		},
		link: `https://reddit.com${comment.permalink}`,
		commentAnalysis: analyzeCommentImpact(comment.score, comment.edited, comment.isSubmitter)
	};
}
// src/index.ts
dotenv.config({ quiet: true });
const VERSION = "2.0.2";
function validateUserAgent(userAgent, username) {
	if (!/^[\w-]+:[\w-]+:[\d.]+ \(by \/u\/\w+\)$/.test(userAgent)) {
		console.error("[Warning] User-Agent does not follow Reddit's recommended format");
		console.error("[Warning] Recommended: 'platform:app_id:version (by /u/username)'");
		console.error("[Warning] Non-standard User-Agents may increase ban risk");
		if (username !== void 0) console.error(`[Warning] Consider using: 'typescript:reddit-mcp-server:${VERSION} (by /u/${username})'`);
	}
}
function buildUserAgent(customAgent, username) {
	if (customAgent !== void 0) {
		validateUserAgent(customAgent, username);
		return customAgent;
	}
	if (username !== void 0) {
		const autoAgent = `typescript:reddit-mcp-server:${VERSION} (by /u/${username})`;
		console.error(`[Setup] Auto-generated User-Agent: ${autoAgent}`);
		return autoAgent;
	}
	const fallbackAgent = `typescript:reddit-mcp-server:${VERSION} (by /u/anonymous)`;
	console.error("[Setup] No REDDIT_USERNAME set — using anonymous User-Agent. Set REDDIT_USERNAME for a personalized agent.");
	return fallbackAgent;
}
function buildSafeModeConfig(safeMode) {
	switch (safeMode) {
		case "off": return {
			enabled: false,
			mode: "off",
			writeDelayMs: 0,
			duplicateCheck: false,
			maxRecentHashes: 10
		};
		case "standard": return {
			enabled: true,
			mode: "standard",
			writeDelayMs: 2e3,
			duplicateCheck: true,
			maxRecentHashes: 10
		};
		case "strict": return {
			enabled: true,
			mode: "strict",
			writeDelayMs: 5e3,
			duplicateCheck: true,
			maxRecentHashes: 20
		};
	}
}
function toolError(text) {
	return {
		content: [{
			text,
			type: "text"
		}],
		isError: true
	};
}
function unwrapClient() {
	return getRedditClient().orThrow(/* @__PURE__ */ new Error("Reddit client not initialized"));
}
const ARCHIVE_DISCLAIMER = "\n\n> **Archive mode** — from the Arctic Shift archive, a free third-party copy of Reddit, not Reddit's API. Scores and comment counts lag and are often 0 or 1 on recent posts, and recent comments may be missing. Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET for live data.";
function sourceDisclaimer(page) {
	const notice = Option(page.notice).fold(() => "", (text) => `\n\n> **Note** — ${text}`);
	if (page.source === "rss") return `${notice}\n\n> **RSS mode** — scores, comment counts, and upvote ratios are unavailable. Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET for full data.`;
	return page.source === "arctic" ? `${notice}${ARCHIVE_DISCLAIMER}` : notice;
}
function archiveDisclaimer(client) {
	return client.keyless ? ARCHIVE_DISCLAIMER : "";
}
function postStatsLines(score, upvoteRatio, comments, source) {
	return source === "rss" || source === "arctic" ? [] : [`- Score: ${score.toLocaleString()} (${(upvoteRatio * 100).toFixed(1)}% upvoted)`, `- Comments: ${comments.toLocaleString()}`];
}
function formatPostSummary(post, index, source) {
	return [
		`### ${index + 1}. ${post.title}`,
		`- Author: u/${post.author}`,
		...postStatsLines(post.stats.score, post.stats.upvoteRatio, post.stats.comments, source),
		`- Posted: ${post.metadata.posted}`,
		`- Link: ${post.links.shortLink}`
	].join("\n");
}
const SEARCH_ABOUT_MAX_LENGTH = 200;
function formatSearchResult(post, index, type, source) {
	const flags = [...post.over18 ? ["**NSFW**"] : [], ...post.spoiler === true ? ["**Spoiler**"] : []];
	const heading = `### ${index + 1}. ${[post.title, ...flags].join(" ")}`;
	const created = (/* @__PURE__ */ new Date(post.createdUtc * 1e3)).toLocaleString();
	const link = `- Link: https://reddit.com${post.permalink}`;
	if (type === "sr") {
		const about = truncateText((post.selftext ?? "").replace(/\s+/g, " ").trim(), SEARCH_ABOUT_MAX_LENGTH);
		return [
			heading,
			...about !== "" ? [`- About: ${about}`] : [],
			`- Created: ${created}`,
			link
		].join("\n");
	}
	if (type === "user") return [
		heading,
		`- Account created: ${created}`,
		link
	].join("\n");
	return [
		heading,
		`- Subreddit: r/${post.subreddit}`,
		`- Author: u/${post.author}`,
		...postStatsLines(post.score, post.upvoteRatio, post.numComments, source),
		`- Posted: ${created}`,
		link
	].join("\n");
}
function nextPageHint(after) {
	return Option(after).fold(() => "", (cursor) => `\n\n---\nMore results available — call again with after="${cursor}" for the next page.`);
}
function formatUserContent(heading, content) {
	return `# ${heading}\n\n${content.posts.length === 0 ? "" : `## Posts (${content.posts.length})\n${content.posts.map((post, index) => `${index + 1}. ${post.title} — r/${post.subreddit}, score ${post.score.toLocaleString()} — https://reddit.com${post.permalink}`).join("\n")}\n\n`}${content.comments.length === 0 ? "" : `## Comments (${content.comments.length})\n${content.comments.map((comment, index) => {
		const formatted = formatCommentInfo(comment, 200);
		return `${index + 1}. in r/${comment.subreddit}: ${formatted.content} — ${formatted.link}`;
	}).join("\n")}\n\n`}${content.posts.length === 0 && content.comments.length === 0 ? "No items found.\n\n" : ""}`.trimEnd() + nextPageHint(content.after);
}
async function setupRedditClient() {
	const clientId = readEnv("REDDIT_CLIENT_ID").orUndefined();
	const clientSecret = readEnv("REDDIT_CLIENT_SECRET").orUndefined();
	const customUserAgent = readEnv("REDDIT_USER_AGENT").orUndefined();
	const username = readEnv("REDDIT_USERNAME").orUndefined();
	const password = readEnv("REDDIT_PASSWORD").orUndefined();
	const authMode = readEnv("REDDIT_AUTH_MODE").orElse("auto");
	const safeMode = readEnv("REDDIT_SAFE_MODE").orElse("standard");
	if (![
		"auto",
		"authenticated",
		"anonymous"
	].includes(authMode)) {
		console.error(`[Error] Invalid REDDIT_AUTH_MODE: ${authMode}`);
		console.error("[Error] Valid options are: auto, authenticated, anonymous");
		process.exit(1);
	}
	if (![
		"off",
		"standard",
		"strict"
	].includes(safeMode)) {
		console.error(`[Error] Invalid REDDIT_SAFE_MODE: ${safeMode}`);
		console.error("[Error] Valid options are: off, standard, strict");
		process.exit(1);
	}
	if (authMode === "authenticated" && (clientId === void 0 || clientSecret === void 0)) {
		console.error("[Error] Authenticated mode requires REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET");
		process.exit(1);
	}
	const hasCredentials = Boolean(clientId && clientSecret);
	const userAgent = buildUserAgent(customUserAgent, username);
	const safeModeConfig = buildSafeModeConfig(safeMode);
	const botDisclosureMode = readEnv("REDDIT_BOT_DISCLOSURE").orElse("off");
	const botDisclosureConfig = {
		enabled: botDisclosureMode === "auto",
		footer: botDisclosureMode === "auto" ? readEnv("REDDIT_BOT_FOOTER").orElse("\n\n---\n^(🤖 I am a bot | Built with) [^reddit-mcp-server](https://github.com/jordanburke/reddit-mcp-server)") : ""
	};
	const cacheEnabled = readEnv("REDDIT_CACHE").orElse("on") !== "off";
	const cacheMaxMb = Number(readEnv("REDDIT_CACHE_MAX_MB").orElse("50"));
	const cacheConfig = {
		enabled: cacheEnabled,
		maxBytes: (Number.isFinite(cacheMaxMb) && cacheMaxMb > 0 ? cacheMaxMb : 50) * 1024 * 1024
	};
	const maxRetriesRaw = Number(readEnv("REDDIT_MAX_RETRIES").orElse("3"));
	const client = initializeRedditClient({
		clientId: clientId ?? "",
		clientSecret: clientSecret ?? "",
		userAgent,
		username,
		password,
		authMode,
		safeMode: safeModeConfig,
		botDisclosure: botDisclosureConfig,
		cache: cacheConfig,
		retry: {
			maxRetries: Number.isFinite(maxRetriesRaw) && maxRetriesRaw >= 0 ? Math.floor(maxRetriesRaw) : 3,
			baseDelayMs: 1e3,
			maxDelayMs: 6e4
		}
	});
	console.error("[Setup] Reddit client initialized");
	console.error(`[Setup] Authentication mode: ${authMode}`);
	if (authMode === "anonymous") console.error("[Warning] REDDIT_AUTH_MODE=anonymous is deprecated; it is now an alias for auto without credentials.");
	if (authMode === "anonymous" || !hasCredentials) {
		console.error("[Setup] Keyless mode — no OAuth credentials detected.");
		console.error("[Setup] Reads come from RSS feeds (ranked listings; Reddit said it would end them 2026-11-13)");
		console.error("[Setup] and the Arctic Shift archive (a free third-party Reddit archive; scores lag).");
		console.error("[Setup] Existing REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET still give live data (60-100 req/min).");
		console.error("[Setup] Reddit takes no new API access requests and closes its public API in March 2027.");
		console.error("[Setup] See: https://github.com/jordanburke/reddit-mcp-server#reddit-is-closing-its-public-api");
	} else {
		console.error("[Setup] Testing Reddit API connection...");
		if (await client.checkAuthentication()) {
			console.error("[Setup] ✓ Reddit API connection successful");
			console.error("[Setup] Using OAuth Reddit API (60-100 req/min)");
		} else if (authMode === "authenticated") {
			console.error("[Error] ✗ Failed to connect to Reddit API");
			console.error("[Error] Please check your REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET");
			process.exit(1);
		} else {
			console.error("[Warning] ✗ Could not authenticate with the Reddit API; starting anyway");
			console.error("[Warning] Check REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET. Tool calls retry and report the error");
			console.error("[Warning] Set REDDIT_AUTH_MODE=authenticated to exit on this instead");
		}
	}
	if (username !== void 0 && password !== void 0) {
		console.error(`[Setup] ✓ User credentials set for: ${username}`);
		console.error("[Setup] Write operations enabled (posting, replying, editing, deleting)");
	} else {
		console.error("[Setup] Read-only mode (no user credentials)");
		console.error("[Setup] For write operations, set REDDIT_USERNAME and REDDIT_PASSWORD");
	}
	if (safeModeConfig.enabled) {
		console.error(`[Setup] ✓ Safe mode enabled: ${safeModeConfig.mode}`);
		console.error(`[Setup]   - Write delay: ${safeModeConfig.writeDelayMs}ms between operations`);
		console.error(`[Setup]   - Duplicate detection: enabled (tracking last ${safeModeConfig.maxRecentHashes} items)`);
	} else console.error("[Setup] Safe mode: off (explicitly disabled — ensure compliance with Reddit's Responsible Builder Policy)");
	if (botDisclosureConfig.enabled) console.error("[Setup] ✓ Bot disclosure: enabled (automated content will include bot footer)");
	else {
		console.error("[Setup] Bot disclosure: off");
		console.error("[Setup] For Reddit policy compliance, consider REDDIT_BOT_DISCLOSURE=auto");
	}
}
const configuredOauthToken = readEnv("OAUTH_TOKEN");
const oauthToken = configuredOauthToken.orElse(crypto.randomBytes(32).toString("hex"));
if (readEnv("OAUTH_ENABLED").orElse("false") === "true" && configuredOauthToken.isNone()) console.error(`[Auth] Generated OAuth token: ${oauthToken}`);
function authenticateBearer(request) {
	const authHeader = getRequestHeader(request, "authorization");
	if (!(authHeader === null || authHeader === void 0 ? void 0 : authHeader.startsWith("Bearer "))) return Promise.reject(new Response(null, { status: 401 }));
	const tokenHash = crypto.createHash("sha256").update(Buffer.from(authHeader.slice(7))).digest();
	const expectedHash = crypto.createHash("sha256").update(Buffer.from(oauthToken)).digest();
	if (!crypto.timingSafeEqual(tokenHash, expectedHash)) return Promise.reject(new Response(null, { status: 403 }));
	return Promise.resolve({ authenticated: true });
}
const transportType = readEnv("TRANSPORT_TYPE").orElse("stdio");
const useHttp = transportType === "httpStream" || transportType === "http";
const server = createServer({
	name: "reddit-mcp-server",
	version: VERSION,
	instructions: `A comprehensive Reddit MCP server that provides tools for interacting with Reddit API.

Available capabilities:
- Fetch Reddit posts, comments, and user information
- Get subreddit details and statistics
- Search Reddit content across posts and subreddits
- Create posts and reply to posts/comments (with authentication)
- Edit your own posts and comments (with authentication)
- Save or unsave posts and comments (with authentication)
- Delete your own posts and comments (with authentication)
- Analyze engagement metrics and community insights

For write operations (posting, replying, editing, deleting), ensure REDDIT_USERNAME and REDDIT_PASSWORD are configured.

IMPORTANT - Reddit Responsible Builder Policy compliance:
- Data retrieved via these tools must NOT be used for AI model training without Reddit's written approval
- Data must NOT be sold, licensed, or commercially redistributed
- Do NOT attempt to de-anonymize or re-identify Reddit users
- Do NOT post identical or substantially similar content across multiple subreddits
- Do NOT use these tools to manipulate votes, karma, or circumvent Reddit safety mechanisms
- All bot-generated content must clearly disclose its automated nature
- Bots must NOT send private/direct messages without explicit user consent
For details: https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy`,
	...useHttp && readEnv("OAUTH_ENABLED").orElse("false") === "true" ? { authenticate: authenticateBearer } : {},
	enableIntrospection: false,
	enableInfoEndpoint: false,
	enableDashboard: false,
	streamKeepalive: { enabled: useHttp }
});
server.addTool({
	name: "test_reddit_mcp_server",
	description: "Health check for the Reddit MCP server. Read-only and side-effect-free — inspects local configuration only and makes no Reddit API calls. Returns the server version, whether the Reddit client is initialized, whether OAuth credentials are present, and whether write access (REDDIT_USERNAME/REDDIT_PASSWORD) is configured. Use this first to diagnose setup/auth problems. Do NOT use it to check Reddit's own status or connectivity — it never contacts Reddit. A \"✗ Write Access\" result means the write tools (create_post, reply_to_post, edit_*, delete_*) will fail.",
	annotations: {
		title: "Test Reddit MCP Server",
		readOnlyHint: true,
		openWorldHint: false
	},
	parameters: z.object({}),
	execute: () => {
		const client = getRedditClient();
		const hasAuth = client.fold(() => "✗", () => "✓");
		const hasWriteAccess = hasUserCredentials() ? "✓" : "✗";
		return Promise.resolve(`Reddit MCP Server Status:
- Server: ✓ Running
- Reddit Client: ${hasAuth} ${client.fold(() => "Not initialized", () => "Initialized")}
- Read Source: ${client.fold(() => "Unknown", (c) => c.keyless ? "Keyless (RSS feeds + Arctic Shift archive; scores lag)" : "Reddit API (OAuth)")}
- Write Access: ${hasWriteAccess} ${hasWriteAccess === "✓" ? "Available" : "Read-only mode"}
- Version: ${VERSION}

Ready to handle Reddit API requests!`);
	}
});
server.addTool({
	name: "get_user_info",
	description: "Get a public profile for any Reddit user: comment/post/total karma, account age and status flags, plus a short activity analysis and engagement tips. Read-only; works without credentials via the Arctic Shift archive (scores lag). Returns profile stats only — use get_user_posts / get_user_comments for their actual content. Use get_me instead for your own authenticated account; do NOT expect private fields here, as only public data is returned.",
	annotations: {
		title: "Get User Info",
		readOnlyHint: true,
		openWorldHint: true
	},
	parameters: z.object({ username: z.string().describe("The target user's Reddit username, without the u/ prefix (e.g. 'spez', not 'u/spez').") }),
	execute: async (args) => {
		const client = unwrapClient();
		return (await client.getUser(args.username)).fold((err) => toolError(`Failed to get user info: ${err.message}`), (user) => {
			const formattedUser = formatUserInfo(user);
			return `# User Information: u/${formattedUser.username}

## Profile Overview
- Username: u/${formattedUser.username}
- Karma:
  - Comment Karma: ${formattedUser.karma.commentKarma.toLocaleString()}
  - Post Karma: ${formattedUser.karma.postKarma.toLocaleString()}
  - Total Karma: ${formattedUser.karma.totalKarma.toLocaleString()}
- Account Status: ${client.keyless ? "Unknown (not in the archive)" : formattedUser.accountStatus.join(", ")}
- Account Created: ${client.keyless && user.createdUtc === 0 ? "Unknown (no archived activity)" : formattedUser.accountCreated}
- Profile URL: ${formattedUser.profileUrl}

## Activity Analysis
- ${formattedUser.activityAnalysis.replace(/\n {2}- /g, "\n- ")}

## Recommendations
- ${formattedUser.recommendations.replace(/\n {2}- /g, "\n- ")}${client.keyless ? "\n\n> Account Created is estimated from the user's first archived post or comment." : ""}${archiveDisclaimer(client)}`;
		});
	}
});
server.addTool({
	name: "get_me",
	description: "Get the authenticated user's own profile (karma, account age, status flags). Read-only, but requires user credentials (REDDIT_USERNAME/REDDIT_PASSWORD) and fails without user credentials. Use this instead of get_user_info when you need the current account rather than an arbitrary user. Do NOT use it to look up other users — it always returns the logged-in account.",
	annotations: {
		title: "Get My Account",
		readOnlyHint: true,
		openWorldHint: true
	},
	parameters: z.object({}),
	execute: async () => {
		return (await unwrapClient().getMe()).fold((err) => toolError(`Failed to get authenticated user: ${err.message}`), (user) => {
			const formattedUser = formatUserInfo(user);
			return `# Your Account: u/${formattedUser.username}

## Profile Overview
- Username: u/${formattedUser.username}
- Karma:
  - Comment Karma: ${formattedUser.karma.commentKarma.toLocaleString()}
  - Post Karma: ${formattedUser.karma.postKarma.toLocaleString()}
  - Total Karma: ${formattedUser.karma.totalKarma.toLocaleString()}
- Account Status: ${formattedUser.accountStatus.join(", ")}
- Account Created: ${formattedUser.accountCreated}
- Profile URL: ${formattedUser.profileUrl}`;
		});
	}
});
server.addTool({
	name: "get_my_overview",
	description: "Get the authenticated user's own recent activity — posts and comments interleaved, newest first. Read-only but requires user credentials (REDDIT_USERNAME/REDDIT_PASSWORD). Returns up to `limit` items plus an `after` cursor for the next page. Use get_my_saved for saved items, or get_user_posts / get_user_comments for another user. Do NOT use this to fetch a specific post's thread — use get_post_comments.",
	annotations: {
		title: "Get My Overview",
		readOnlyHint: true,
		openWorldHint: true
	},
	parameters: z.object({
		limit: z.number().min(1).max(100).default(25).describe("How many activity items to return, 1–100 (default 25)."),
		after: z.string().optional().describe("Forward pagination cursor: the `after` value returned by a previous call. Omit for the first page.")
	}),
	execute: async (args) => {
		return (await unwrapClient().getMyOverview({
			limit: args.limit,
			after: args.after
		})).fold((err) => toolError(`Failed to get your overview: ${err.message}`), (content) => formatUserContent("Your Overview", content));
	}
});
server.addTool({
	name: "get_my_saved",
	description: "Get the authenticated user's saved posts and comments (private to the account). Read-only but requires user credentials (REDDIT_USERNAME/REDDIT_PASSWORD). Returns up to `limit` items plus an `after` pagination cursor. Use get_my_overview for your authored activity. Do NOT use this for another user — saved items are private and have no cross-user equivalent.",
	annotations: {
		title: "Get My Saved",
		readOnlyHint: true,
		openWorldHint: true
	},
	parameters: z.object({
		limit: z.number().min(1).max(100).default(25).describe("How many saved items to return, 1–100 (default 25)."),
		after: z.string().optional().describe("Forward pagination cursor: the `after` value returned by a previous call. Omit for the first page.")
	}),
	execute: async (args) => {
		return (await unwrapClient().getMySaved({
			limit: args.limit,
			after: args.after
		})).fold((err) => toolError(`Failed to get saved content: ${err.message}`), (content) => formatUserContent("Your Saved Content", content));
	}
});
server.addTool({
	name: "get_user_posts",
	description: "Get posts submitted by a specific user, with sort (new/hot/top) and time filter. Read-only; works without credentials via the Arctic Shift archive, newest first and without scores or comment counts. Returns a page of posts (title, subreddit, score, upvote ratio, comment count, permalink) plus an `after` cursor for paging. Use get_user_comments for their comments, or get_user_info for karma/profile stats. Do NOT use this to search a subreddit — use search_reddit or browse_subreddit.",
	annotations: {
		title: "Get User Posts",
		readOnlyHint: true,
		openWorldHint: true
	},
	parameters: z.object({
		username: z.string().describe("The author's Reddit username, without the u/ prefix (e.g. 'spez')."),
		sort: z.enum([
			"new",
			"hot",
			"top"
		]).default("new").describe("Ordering: 'new' (most recent), 'hot' (currently active), or 'top' (highest score within `time_filter`). Default 'new'."),
		time_filter: z.enum([
			"hour",
			"day",
			"week",
			"month",
			"year",
			"all"
		]).default("all").describe("Time window for scoring; only applies when sort='top'. Ignored for 'new'/'hot'. Default 'all'."),
		limit: z.number().min(1).max(100).default(10).describe("How many posts to return, 1–100 (default 10)."),
		after: z.string().optional().describe("Forward pagination cursor: the `after` value from a previous call. Omit for the first page.")
	}),
	execute: async (args) => {
		return (await unwrapClient().getUserPosts(args.username, {
			sort: args.sort,
			timeFilter: args.time_filter,
			limit: args.limit,
			after: args.after
		})).fold((err) => toolError(`Failed to get user posts: ${err.message}`), (page) => {
			const posts = page.items;
			if (posts.length === 0) return `No posts found for u/${args.username} with the specified filters.`;
			const postSummaries = posts.map((post, index) => {
				const flags = [...post.over18 ? ["**NSFW**"] : [], ...post.spoiler === true ? ["**Spoiler**"] : []];
				return [
					`### ${index + 1}. ${[post.title, ...flags].join(" ")}`,
					`- Subreddit: r/${post.subreddit}`,
					...postStatsLines(post.score, post.upvoteRatio, post.numComments, page.source),
					`- Posted: ${(/* @__PURE__ */ new Date(post.createdUtc * 1e3)).toLocaleString()}`,
					`- Link: https://reddit.com${post.permalink}`
				].join("\n");
			}).join("\n\n");
			return `# Posts by u/${args.username} (${args.sort} - ${args.time_filter})

${postSummaries}${nextPageHint(page.after)}${sourceDisclaimer(page)}`;
		});
	}
});
server.addTool({
	name: "get_user_comments",
	description: "Get comments made by a specific user, with sort (new/hot/top) and time filter. Read-only; works without credentials via the Arctic Shift archive, newest first and without scores. Returns a page of comments (subreddit, parent post title, body excerpt, score, permalink) plus an `after` cursor. Use get_user_posts for their submissions, or get_user_info for karma/profile stats. Do NOT use this to read one post's thread — use get_post_comments.",
	annotations: {
		title: "Get User Comments",
		readOnlyHint: true,
		openWorldHint: true
	},
	parameters: z.object({
		username: z.string().describe("The author's Reddit username, without the u/ prefix (e.g. 'spez')."),
		sort: z.enum([
			"new",
			"hot",
			"top"
		]).default("new").describe("Ordering: 'new' (most recent), 'hot' (currently active), or 'top' (highest score within `time_filter`). Default 'new'."),
		time_filter: z.enum([
			"hour",
			"day",
			"week",
			"month",
			"year",
			"all"
		]).default("all").describe("Time window for scoring; only applies when sort='top'. Ignored for 'new'/'hot'. Default 'all'."),
		limit: z.number().min(1).max(100).default(10).describe("How many comments to return, 1–100 (default 10)."),
		after: z.string().optional().describe("Forward pagination cursor: the `after` value from a previous call. Omit for the first page.")
	}),
	execute: async (args) => {
		return (await unwrapClient().getUserComments(args.username, {
			sort: args.sort,
			timeFilter: args.time_filter,
			limit: args.limit,
			after: args.after
		})).fold((err) => toolError(`Failed to get user comments: ${err.message}`), (page) => {
			const comments = page.items;
			if (comments.length === 0) return `No comments found for u/${args.username} with the specified filters.`;
			const commentSummaries = comments.map((comment, index) => {
				const formatted = formatCommentInfo(comment, 300);
				const flags = [...comment.edited ? ["*(edited)*"] : [], ...comment.isSubmitter ? ["**OP**"] : []];
				return `### ${index + 1}. Comment ${flags.join(" ")}
In r/${comment.subreddit} on "${comment.submissionTitle}"

> ${formatted.content}

${page.source === "arctic" ? "" : `- Score: ${comment.score.toLocaleString()}\n`}- Posted: ${(/* @__PURE__ */ new Date(comment.createdUtc * 1e3)).toLocaleString()}
- Link: ${formatted.link}`;
			}).join("\n\n");
			return `# Comments by u/${args.username} (${args.sort} - ${args.time_filter})

${commentSummaries}${nextPageHint(page.after)}${sourceDisclaimer(page)}`;
		});
	}
});
server.addTool({
	name: "get_reddit_post",
	description: "Get a single post by subreddit + post id: title, author, self-text or link content, score, upvote ratio, comment count, flair/flags, and an engagement analysis. Read-only; works without credentials via the Arctic Shift archive, which omits the score, upvote ratio, comment count and engagement analysis. Returns the post only — use get_post_comments for its comment thread. Do NOT use this to list a subreddit's posts (use browse_subreddit / get_top_posts) or to find posts by keyword (use search_reddit).",
	annotations: {
		title: "Get Reddit Post",
		readOnlyHint: true,
		openWorldHint: true
	},
	parameters: z.object({
		subreddit: z.string().describe("The subreddit the post lives in, without the r/ prefix (e.g. 'programming')."),
		post_id: z.string().describe("Base36 post id — the segment after /comments/ in a permalink like reddit.com/r/<sub>/comments/<post_id>/... (e.g. '1abc23'). With or without a t3_ prefix.")
	}),
	execute: async (args) => {
		const client = unwrapClient();
		return (await client.getPost(args.post_id, args.subreddit)).fold((err) => toolError(`Failed to get post: ${err.message}`), (post) => {
			const formattedPost = formatPostInfo(post);
			return `# Post from r/${formattedPost.subreddit}

## Post Details
- Title: ${formattedPost.title}
- Type: ${formattedPost.type}
- Author: u/${formattedPost.author}

## Content
${formattedPost.content}

## Stats
${client.keyless ? "- Not shown: the archive's scores and comment counts lag, and are often 0 or 1 on recent posts." : `- Score: ${formattedPost.stats.score.toLocaleString()}
- Upvote Ratio: ${(formattedPost.stats.upvoteRatio * 100).toFixed(1)}%
- Comments: ${formattedPost.stats.comments.toLocaleString()}`}

## Metadata
- Posted: ${formattedPost.metadata.posted}
- Flags: ${formattedPost.metadata.flags.length > 0 ? formattedPost.metadata.flags.join(", ") : "None"}
- Flair: ${formattedPost.metadata.flair}

## Links
- Full Post: ${formattedPost.links.fullPost}
- Short Link: ${formattedPost.links.shortLink}

${client.keyless ? "" : `## Engagement Analysis\n- ${formattedPost.engagementAnalysis.replace(/\n {2}- /g, "\n- ")}\n\n`}## Best Time to Engage
${formattedPost.bestTimeToEngage}${archiveDisclaimer(client)}`;
		});
	}
});
server.addTool({
	name: "get_top_posts",
	description: "Get the top-scoring posts from a subreddit — or from the authenticated home feed if no subreddit is given — within a time window (hour…all). Read-only; works without credentials via RSS (titles and links only, no scores); if RSS fails, it falls back to the Arctic Shift archive's newest posts, which have no ranking. Returns a page of posts plus an `after` cursor. This is a shortcut for the 'top' sort; use browse_subreddit for hot/new/rising/controversial, or search_reddit to find posts by keyword.",
	annotations: {
		title: "Get Top Posts",
		readOnlyHint: true,
		openWorldHint: true
	},
	parameters: z.object({
		subreddit: z.string().optional().describe("Subreddit to read, without the r/ prefix (e.g. 'science'). Omit to use the authenticated home feed (requires credentials)."),
		time_filter: z.enum([
			"hour",
			"day",
			"week",
			"month",
			"year",
			"all"
		]).default("week").describe("Time window the 'top' ranking is computed over (e.g. 'day' = top today). Default 'week'."),
		limit: z.number().min(1).max(100).default(10).describe("How many posts to return, 1–100 (default 10)."),
		after: z.string().optional().describe("Forward pagination cursor: the `after` value from a previous call. Omit for the first page.")
	}),
	execute: async (args) => {
		return (await unwrapClient().getTopPosts(args.subreddit ?? "", args.time_filter, args.limit, args.after)).fold((err) => toolError(`Failed to get top posts: ${err.message}`), (page) => {
			const posts = page.items;
			if (posts.length === 0) return `No posts found in ${Option(args.subreddit).fold(() => "home feed", (sr) => `r/${sr}`)} for the specified time period.`;
			const postSummaries = posts.map(formatPostInfo).map((post, index) => formatPostSummary(post, index, page.source)).join("\n\n");
			return `# Top Posts from ${Option(args.subreddit).fold(() => "Home Feed", (sr) => `r/${sr}`)} (${args.time_filter})

${postSummaries}${nextPageHint(page.after)}${sourceDisclaimer(page)}`;
		});
	}
});
server.addTool({
	name: "browse_subreddit",
	description: "Browse a subreddit — or the authenticated home feed when no subreddit is given — by sort order: hot, new, top, rising, or controversial. Read-only; works without credentials via RSS (titles and links only, no scores); if RSS fails, it falls back to the Arctic Shift archive's newest posts, which have no ranking. `time_filter` applies only to the top and controversial sorts. Returns a page of posts plus an `after` cursor. Use get_top_posts as a shortcut for the top sort, or search_reddit to find posts by keyword rather than by feed order.",
	annotations: {
		title: "Browse Subreddit",
		readOnlyHint: true,
		openWorldHint: true
	},
	parameters: z.object({
		subreddit: z.string().optional().describe("Subreddit to browse, without the r/ prefix (e.g. 'news'). Omit to use the authenticated home feed (requires credentials)."),
		sort: z.enum([
			"hot",
			"new",
			"top",
			"rising",
			"controversial"
		]).default("hot").describe("Feed ordering: 'hot' (default), 'new', 'rising', 'top', or 'controversial'. 'top'/'controversial' honor `time_filter`."),
		time_filter: z.enum([
			"hour",
			"day",
			"week",
			"month",
			"year",
			"all"
		]).default("week").describe("Time window; only applies to sort='top' or 'controversial'. Ignored otherwise. Default 'week'."),
		limit: z.number().min(1).max(100).default(10).describe("How many posts to return, 1–100 (default 10)."),
		after: z.string().optional().describe("Forward pagination cursor: the `after` value from a previous call. Omit for the first page.")
	}),
	execute: async (args) => {
		return (await unwrapClient().browseSubreddit(args.subreddit ?? "", args.sort, args.time_filter, args.limit, args.after)).fold((err) => toolError(`Failed to browse subreddit: ${err.message}`), (page) => {
			const posts = page.items;
			const location = Option(args.subreddit).fold(() => "home feed", (sr) => `r/${sr}`);
			if (posts.length === 0) return `No posts found in ${location}.`;
			const postSummaries = posts.map(formatPostInfo).map((post, index) => formatPostSummary(post, index, page.source)).join("\n\n");
			const timeSuffix = args.sort === "top" || args.sort === "controversial" ? `, ${args.time_filter}` : "";
			const heading = location === "home feed" ? "Home Feed" : location;
			return `# ${args.sort} posts from ${heading} (${args.sort}${timeSuffix})

${postSummaries}${nextPageHint(page.after)}${sourceDisclaimer(page)}`;
		});
	}
});
server.addTool({
	name: "get_subreddit_info",
	description: "Get a subreddit's profile: title, description, subscriber and active-user counts, creation date, flags, wiki/link URLs, plus a community analysis and posting tips. Read-only; works without credentials via the Arctic Shift archive (scores lag). Returns metadata about the community itself — use browse_subreddit / get_top_posts for its posts, or get_subreddit_rules for its posting rules. Do NOT use this to find subreddits by topic — use search_reddit with type='sr'.",
	annotations: {
		title: "Get Subreddit Info",
		readOnlyHint: true,
		openWorldHint: true
	},
	parameters: z.object({ subreddit_name: z.string().describe("The subreddit name, without the r/ prefix (e.g. 'askscience').") }),
	execute: async (args) => {
		const client = unwrapClient();
		return (await client.getSubredditInfo(args.subreddit_name)).fold((err) => toolError(`Failed to get subreddit info: ${err.message}`), (subreddit) => {
			const formattedSubreddit = formatSubredditInfo(subreddit);
			return `# Subreddit Information: r/${formattedSubreddit.name}

## Overview
- Name: r/${formattedSubreddit.name}
- Title: ${formattedSubreddit.title}
- Subscribers: ${formattedSubreddit.stats.subscribers.toLocaleString()}
- Active Users: ${typeof formattedSubreddit.stats.activeUsers === "number" ? formattedSubreddit.stats.activeUsers.toLocaleString() : formattedSubreddit.stats.activeUsers}

## Description
${formattedSubreddit.description.short}

## Detailed Description
${formattedSubreddit.description.full}

## Metadata
- Created: ${formattedSubreddit.metadata.created}
- Flags: ${formattedSubreddit.metadata.flags.join(", ")}

## Links
- Subreddit: ${formattedSubreddit.links.subreddit}
- Wiki: ${formattedSubreddit.links.wiki}

## Community Analysis
- ${formattedSubreddit.communityAnalysis.replace(/\n {2}- /g, "\n- ")}

## Engagement Tips
- ${formattedSubreddit.engagementTips.replace(/\n {2}- /g, "\n- ")}${archiveDisclaimer(client)}`;
		});
	}
});
server.addTool({
	name: "get_subreddit_rules",
	description: "Get a subreddit's posting rules (each rule's name, what it applies to, and its description). Read-only; works without credentials via the Arctic Shift archive (scores lag). Returns the rules list, or a note when the subreddit lists none. Call this before create_post to check requirements and avoid auto-removal. For available post flairs use get_post_flairs instead.",
	annotations: {
		title: "Get Subreddit Rules",
		readOnlyHint: true,
		openWorldHint: true
	},
	parameters: z.object({ subreddit_name: z.string().describe("The subreddit name, without the r/ prefix (e.g. 'AskReddit').") }),
	execute: async (args) => {
		const client = unwrapClient();
		return (await client.getSubredditRules(args.subreddit_name)).fold((err) => toolError(`Failed to get subreddit rules: ${err.message}`), (rules) => {
			if (rules.length === 0) return `r/${args.subreddit_name} has no listed subreddit-specific rules.`;
			const ruleList = rules.map((rule, index) => {
				const applies = rule.kind === "all" ? "posts & comments" : `${rule.kind}s`;
				const detail = rule.description.trim() === "" ? "" : `\n${rule.description.trim()}`;
				return `### ${index + 1}. ${rule.shortName} _(applies to ${applies})_${detail}`;
			}).join("\n\n");
			return `# Posting Rules for r/${args.subreddit_name}

${ruleList}${archiveDisclaimer(client)}`;
		});
	}
});
server.addTool({
	name: "get_post_flairs",
	description: "List a subreddit's selectable link flairs (flair text + flair_id) for use with create_post. Read-only, but requires user credentials; many subreddits expose flairs only to members, so this can 403 or return empty without credentials. Pass a returned flair_id (and flair_text for text-editable flairs) to create_post. For the subreddit's posting rules use get_subreddit_rules instead.",
	annotations: {
		title: "Get Post Flairs",
		readOnlyHint: true,
		openWorldHint: true
	},
	parameters: z.object({ subreddit_name: z.string().describe("The subreddit name, without the r/ prefix (e.g. 'gadgets').") }),
	execute: async (args) => {
		return (await unwrapClient().getPostFlairs(args.subreddit_name)).fold((err) => toolError(`Failed to get post flairs: ${err.message}`), (flairs) => {
			if (flairs.length === 0) return `r/${args.subreddit_name} has no selectable link flairs (or none are visible to this account).`;
			const flairList = flairs.map((flair) => {
				const editable = flair.textEditable === true ? " _(text editable)_" : "";
				return `- ${flair.text}${editable} — \`flair_id: ${flair.id}\``;
			}).join("\n");
			return `# Available Link Flairs for r/${args.subreddit_name}

${flairList}

Pass the desired \`flair_id\` to \`create_post\`.`;
		});
	}
});
server.addTool({
	name: "get_trending_subreddits",
	description: "Get the subreddits Reddit is currently featuring as trending/popular. Read-only, no parameters; requires OAuth credentials. Returns a list of subreddit names that changes through the day (cached briefly server-side). To find subreddits by keyword instead of by trend, use search_reddit with type='sr'.",
	annotations: {
		title: "Get Trending Subreddits",
		readOnlyHint: true,
		openWorldHint: true
	},
	parameters: z.object({}),
	execute: async () => {
		return (await unwrapClient().getTrendingSubreddits()).fold((err) => toolError(`Failed to get trending subreddits: ${err.message}`), (trendingSubreddits) => `# Trending Subreddits

${trendingSubreddits.map((subreddit, index) => `${index + 1}. r/${subreddit}`).join("\n")}`);
	}
});
server.addTool({
	name: "search_reddit",
	description: "Search Reddit for posts — or subreddits/users via `type` — optionally scoped to one subreddit, with sort and time filters. Read-only. Without credentials it uses the Arctic Shift archive, which needs `subreddit` for post search, matches subreddit names by prefix, cannot search users, and omits scores and comment counts. Returns a page of results (title, subreddit, author, score, comments, link) plus an `after` cursor for paging. Use this to find content by keyword; use browse_subreddit / get_top_posts to list a known subreddit's feed instead.",
	annotations: {
		title: "Search Reddit",
		readOnlyHint: true,
		openWorldHint: true
	},
	parameters: z.object({
		query: z.string().describe("Search terms; supports Reddit operators (quotes for exact phrases, author:name, self:yes). Must be non-empty."),
		subreddit: z.string().optional().describe("Restrict results to this subreddit, without the r/ prefix (e.g. 'python'). Omit to search all of Reddit."),
		sort: z.enum([
			"relevance",
			"hot",
			"top",
			"new",
			"comments"
		]).default("relevance").describe("Sort order. Prefer 'relevance' (default) for finding posts about a topic. Use 'top'/'hot' only for what's currently popular and 'new' for the latest — these rank by karma/recency and, especially combined with a narrow time_filter, can surface loosely-matching posts over the best topical results."),
		time_filter: z.enum([
			"hour",
			"day",
			"week",
			"month",
			"year",
			"all"
		]).default("all").describe("Restrict to results from this recent window (e.g. 'week'). Default 'all' (no time limit)."),
		limit: z.number().min(1).max(100).default(10).describe("How many results to return, 1–100 (default 10)."),
		type: z.enum([
			"link",
			"sr",
			"user"
		]).default("link").describe("What to search for: 'link' = posts (default), 'sr' = subreddits, 'user' = users."),
		after: z.string().optional().describe("Forward pagination cursor: the `after` value from a previous call. Omit for the first page.")
	}),
	execute: async (args) => {
		const client = unwrapClient();
		if (args.query.trim() === "") return toolError("Search query cannot be empty");
		return (await client.searchReddit(args.query, {
			subreddit: args.subreddit,
			sort: args.sort,
			timeFilter: args.time_filter,
			limit: args.limit,
			type: args.type,
			after: args.after
		})).fold((err) => toolError(`Failed to search: ${err.message}`), (page) => {
			const posts = page.items;
			if (posts.length === 0) {
				const searchLocation = Option(args.subreddit).fold(() => "", (sr) => ` in r/${sr}`);
				return `No results found for "${args.query}"${searchLocation}.`;
			}
			const searchResults = posts.map((post, index) => formatSearchResult(post, index, args.type, page.source)).join("\n\n");
			const searchLocation = Option(args.subreddit).fold(() => "", (sr) => ` in r/${sr}`);
			return `# Reddit Search Results for: "${args.query}"${searchLocation}

Sorted by: ${page.source !== "arctic" ? args.sort : args.type === "sr" ? "subscribers (archive)" : "newest first (archive)"} | Time: ${args.time_filter} | Type: ${args.type}

${searchResults}${nextPageHint(page.after)}${sourceDisclaimer(page)}`;
		});
	}
});
server.addTool({
	name: "create_post",
	description: "Create a new text or link post in a subreddit. Mutating and NOT idempotent — each call publishes a separate post. Requires REDDIT_USERNAME and REDDIT_PASSWORD; fails without them. Returns the new post's id and URL. Check get_subreddit_rules and get_post_flairs first, since many subreddits require a flair or reject certain content. WARNING: rapid posting or duplicate content may trigger Reddit's spam detection and account bans — enable REDDIT_SAFE_MODE=standard for rate limiting and duplicate detection.",
	annotations: {
		title: "Create Post",
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true
	},
	parameters: z.object({
		subreddit: z.string().describe("Target subreddit, without the r/ prefix (e.g. 'test')."),
		title: z.string().describe("Post title (cannot be edited after creation)."),
		content: z.string().describe("For a self post (is_self=true): the body text, Reddit markdown supported. For a link post (is_self=false): the destination URL."),
		is_self: z.boolean().default(true).describe("true = text/self post using `content` as the body (default); false = link post using `content` as the URL."),
		flair_id: z.string().optional().describe("Link flair template id from get_post_flairs; many subreddits require one or the post is auto-removed."),
		flair_text: z.string().optional().describe("Custom flair text, allowed only for flairs whose template is text-editable.")
	}),
	execute: async (args) => {
		const client = unwrapClient();
		if (!hasUserCredentials()) return toolError("User authentication required. Please set REDDIT_USERNAME and REDDIT_PASSWORD environment variables.");
		return (await client.createPost(args.subreddit, args.title, args.content, args.is_self, args.flair_id, args.flair_text)).fold((err) => toolError(`Failed to create post: ${err.message}`), (post) => {
			const formattedPost = formatPostInfo(post);
			return `# Post Created Successfully

## Post Details
- Title: ${formattedPost.title}
- Subreddit: r/${formattedPost.subreddit}
- Type: ${formattedPost.type}
- Link: ${formattedPost.links.fullPost}

Your post has been successfully submitted to r/${formattedPost.subreddit}.`;
		});
	}
});
server.addTool({
	name: "reply_to_post",
	description: "Post a reply to an existing post or comment. Mutating and NOT idempotent — each call adds a new comment. Requires REDDIT_USERNAME and REDDIT_PASSWORD. The parent is identified by its thing id — t3_ for a post, t1_ for a comment — so this creates both top-level and nested replies. Returns the new comment's id. Use edit_comment to change a reply you already posted. WARNING: rapid or duplicate replies may trigger Reddit's spam detection; enable REDDIT_SAFE_MODE=standard for rate limiting and duplicate detection.",
	annotations: {
		title: "Reply to Post or Comment",
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true
	},
	parameters: z.object({
		post_id: z.string().describe("Parent thing id to reply under: t3_<id> for a post (creates a top-level comment) or t1_<id> for a comment (creates a nested reply)."),
		content: z.string().describe("Reply body text; Reddit markdown supported.")
	}),
	execute: async (args) => {
		const client = unwrapClient();
		if (!hasUserCredentials()) return toolError("User authentication required. Please set REDDIT_USERNAME and REDDIT_PASSWORD environment variables.");
		return (await client.replyToPost(args.post_id, args.content)).fold((err) => toolError(`Failed to reply: ${err.message}`), (comment) => `# Reply Posted Successfully

## Comment Details
- Posted to: ${args.post_id}
- Author: u/${readEnv("REDDIT_USERNAME").orElse("")}
- Comment ID: ${comment.id}

Your reply has been successfully posted.`);
	}
});
server.addTool({
	name: "delete_post",
	description: "Permanently delete one of your own posts. Mutating and destructive but idempotent — deleting an already-deleted post is a no-op. Requires REDDIT_USERNAME and REDDIT_PASSWORD, and only works on posts authored by the authenticated account. Only affects the post you name; use delete_comment for comments. WARNING: this cannot be undone — the content is removed, though the post id remains.",
	annotations: {
		title: "Delete Post",
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true
	},
	parameters: z.object({ thing_id: z.string().describe("The post to delete: a full thing id 't3_<id>' or just the base36 post id '<id>' (the 't3_' prefix is added automatically). Must be a post you authored.") }),
	execute: async (args) => {
		const client = unwrapClient();
		if (!hasUserCredentials()) return toolError("User authentication required. Please set REDDIT_USERNAME and REDDIT_PASSWORD environment variables.");
		return (await client.deletePost(args.thing_id)).fold((err) => toolError(`Failed to delete post: ${err.message}`), () => `# Post Deleted Successfully

The post ${args.thing_id} has been permanently deleted from Reddit.

**Note**: This action cannot be undone. The post content has been removed and cannot be recovered.`);
	}
});
server.addTool({
	name: "delete_comment",
	description: "Permanently delete one of your own comments. Mutating and destructive but idempotent — deleting an already-deleted comment is a no-op. Requires REDDIT_USERNAME and REDDIT_PASSWORD, and only works on comments authored by the authenticated account. Only affects the comment you name; use delete_post for posts. WARNING: this cannot be undone — the content is removed, though the comment id remains.",
	annotations: {
		title: "Delete Comment",
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true
	},
	parameters: z.object({ thing_id: z.string().describe("The comment to delete: a full thing id 't1_<id>' or just the base36 comment id '<id>' (the 't1_' prefix is added automatically). Must be a comment you authored.") }),
	execute: async (args) => {
		const client = unwrapClient();
		if (!hasUserCredentials()) return toolError("User authentication required. Please set REDDIT_USERNAME and REDDIT_PASSWORD environment variables.");
		return (await client.deleteComment(args.thing_id)).fold((err) => toolError(`Failed to delete comment: ${err.message}`), () => `# Comment Deleted Successfully

The comment ${args.thing_id} has been permanently deleted from Reddit.

**Note**: This action cannot be undone. The comment content has been removed and cannot be recovered.`);
	}
});
server.addTool({
	name: "edit_post",
	description: "Replace the body text of one of your own self-text posts. Mutating and idempotent (same text → same result); it overwrites the previous body. Requires REDDIT_USERNAME and REDDIT_PASSWORD, and works only on self posts you authored — titles and link posts cannot be edited. Adds an \"edited\" marker. Use create_post to make a new post, or edit_comment for comments. WARNING: rapid edits may trigger spam detection; enable REDDIT_SAFE_MODE for protection.",
	annotations: {
		title: "Edit Post",
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true
	},
	parameters: z.object({
		thing_id: z.string().describe("The post to edit: a full thing id 't3_<id>' or just the base36 post id '<id>' (the 't3_' prefix is added automatically). Must be a self-text post you authored."),
		new_text: z.string().describe("Replacement body text; fully overwrites the current body. Reddit markdown supported.")
	}),
	execute: async (args) => {
		const client = unwrapClient();
		if (!hasUserCredentials()) return toolError("User authentication required. Please set REDDIT_USERNAME and REDDIT_PASSWORD environment variables.");
		return (await client.editPost(args.thing_id, args.new_text)).fold((err) => toolError(`Failed to edit post: ${err.message}`), () => `# Post Edited Successfully

The post ${args.thing_id} has been updated with your new content.

**Note**:
- Only self (text) posts can be edited
- Post titles cannot be edited
- Link posts cannot be edited
- An "edited" marker will appear on your post`);
	}
});
server.addTool({
	name: "edit_comment",
	description: "Replace the text of one of your own comments. Mutating and idempotent (same text → same result); it overwrites the previous content. Requires REDDIT_USERNAME and REDDIT_PASSWORD, and works only on comments you authored. Adds an \"edited\" marker. Use reply_to_post to add a new comment, or edit_post for posts. WARNING: rapid edits may trigger spam detection; enable REDDIT_SAFE_MODE for protection.",
	annotations: {
		title: "Edit Comment",
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true
	},
	parameters: z.object({
		thing_id: z.string().describe("The comment to edit: a full thing id 't1_<id>' or just the base36 comment id '<id>' (the 't1_' prefix is added automatically). Must be a comment you authored."),
		new_text: z.string().describe("Replacement comment text; fully overwrites the current content. Reddit markdown supported.")
	}),
	execute: async (args) => {
		const client = unwrapClient();
		if (!hasUserCredentials()) return toolError("User authentication required. Please set REDDIT_USERNAME and REDDIT_PASSWORD environment variables.");
		return (await client.editComment(args.thing_id, args.new_text)).fold((err) => toolError(`Failed to edit comment: ${err.message}`), () => `# Comment Edited Successfully

The comment ${args.thing_id} has been updated with your new content.

**Note**: An "edited" marker will appear on your comment to show it has been modified.`);
	}
});
server.addTool({
	name: "save_content",
	description: "Save a post or comment to your account (a private bookmark, listed by get_my_saved). Mutating but idempotent — saving an already-saved item is a no-op. Requires REDDIT_USERNAME and REDDIT_PASSWORD; works on any post/comment you can see, not just your own. Accepts a full thing id (t3_ for a post, t1_ for a comment) — a bare id is treated as a post. Use unsave_content to undo.",
	annotations: {
		title: "Save Post or Comment",
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	},
	parameters: z.object({
		thing_id: z.string().describe("The post or comment to save: a full thing id 't3_<id>' (post) or 't1_<id>' (comment). A bare id is treated as a post."),
		category: z.string().optional().describe("Optional save category to file this under (Reddit Premium feature; ignored on other accounts).")
	}),
	execute: async (args) => {
		const client = unwrapClient();
		if (!hasUserCredentials()) return toolError("User authentication required. Please set REDDIT_USERNAME and REDDIT_PASSWORD environment variables.");
		return (await client.saveContent(args.thing_id, args.category)).fold((err) => toolError(`Failed to save content: ${err.message}`), () => `# Content Saved Successfully

${args.thing_id} has been saved to your account. Use get_my_saved to view your saved items.`);
	}
});
server.addTool({
	name: "unsave_content",
	description: "Remove a post or comment from your saved items (undoes save_content). Mutating but idempotent — unsaving an item that isn't saved is a no-op. Requires REDDIT_USERNAME and REDDIT_PASSWORD. Accepts a full thing id (t3_ for a post, t1_ for a comment) — a bare id is treated as a post.",
	annotations: {
		title: "Unsave Post or Comment",
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	},
	parameters: z.object({ thing_id: z.string().describe("The post or comment to unsave: a full thing id 't3_<id>' (post) or 't1_<id>' (comment). A bare id is treated as a post.") }),
	execute: async (args) => {
		const client = unwrapClient();
		if (!hasUserCredentials()) return toolError("User authentication required. Please set REDDIT_USERNAME and REDDIT_PASSWORD environment variables.");
		return (await client.unsaveContent(args.thing_id)).fold((err) => toolError(`Failed to unsave content: ${err.message}`), () => `# Content Unsaved Successfully

${args.thing_id} has been removed from your saved items.`);
	}
});
server.addTool({
	name: "get_post_comments",
	description: "Get the comment thread for a post (by post id + subreddit), sorted best/top/new/controversial/old/qa. Read-only; works without credentials via the Arctic Shift archive (scores lag). Returns the post header plus threaded comments (author, OP/edited badges, score, body, nesting depth) up to `limit`. Long threads are truncated with 'load more' stubs — expand those with get_more_comments. Use get_reddit_post for just the post body, not the thread.",
	annotations: {
		title: "Get Post Comments",
		readOnlyHint: true,
		openWorldHint: true
	},
	parameters: z.object({
		post_id: z.string().describe("Base36 post id — the segment after /comments/ in a permalink (e.g. '1abc23'). With or without a t3_ prefix."),
		subreddit: z.string().describe("The subreddit the post lives in, without the r/ prefix (e.g. 'movies')."),
		sort: z.enum([
			"best",
			"top",
			"new",
			"controversial",
			"old",
			"qa"
		]).default("best").describe("Comment ordering: 'best' (default), 'top', 'new', 'controversial', 'old', or 'qa' (Q&A)."),
		limit: z.number().min(1).max(500).default(100).describe("Maximum comments to return, 1–500 (default 100). Deeply nested replies may still be truncated as 'load more' stubs.")
	}),
	execute: async (args) => {
		const client = unwrapClient();
		if (args.post_id === "" || args.subreddit === "") return toolError("post_id and subreddit are required");
		return (await client.getPostComments(args.post_id, args.subreddit, {
			sort: args.sort,
			limit: args.limit
		})).fold((err) => toolError(`Failed to get comments: ${err.message}`), ({ post, comments, moreIds }) => {
			const statsLine = client.keyless ? "" : `- Score: ${post.score.toLocaleString()} | Comments: ${post.numComments.toLocaleString()}\n`;
			const header = `# Comments for: ${post.title}

**Post by u/${post.author} in r/${post.subreddit}**
${statsLine}- Posted: ${(/* @__PURE__ */ new Date(post.createdUtc * 1e3)).toLocaleString()}

---

`;
			if (comments.length === 0) return `${header}No comments found for this post.`;
			const commentSummaries = comments.map((comment) => {
				const indent = "└─".repeat(Math.min(comment.depth ?? 0, 3));
				const authorBadge = comment.isSubmitter ? " **[OP]**" : "";
				const editedBadge = comment.edited ? " *(edited)*" : "";
				return `${indent} **u/${comment.author}**${authorBadge}${editedBadge} (${comment.score.toLocaleString()} points)

${comment.body}

---`;
			}).join("\n\n");
			const moreHint = moreIds.length > 0 ? `\n\n**${moreIds.length} more comments are collapsed.** Expand them with get_more_comments: link_id="t3_${post.id}", comment_ids=${JSON.stringify(moreIds.slice(0, 100))}${moreIds.length > 100 ? " (first 100 shown)" : ""}` : "";
			const sortNote = client.keyless && args.sort !== "best" ? `\n\n> sort="${args.sort}" is not applied to archive comments.` : "";
			return header + commentSummaries + moreHint + sortNote + archiveDisclaimer(client);
		});
	}
});
server.addTool({
	name: "get_more_comments",
	description: "Expand truncated 'load more comments' stubs in a thread. Read-only; works without credentials via the Arctic Shift archive (scores lag). Pass the post's link id and the comment ids from a 'more' node (surfaced by get_post_comments) to fetch those hidden comments; returns the expanded comments (author, body excerpt, score, link). Call get_post_comments first to obtain the thread and its 'more' node ids — do NOT invent ids.",
	annotations: {
		title: "Get More Comments",
		readOnlyHint: true,
		openWorldHint: true
	},
	parameters: z.object({
		link_id: z.string().describe("The parent post's link id (base36, with or without the t3_ prefix) that the stub belongs to."),
		comment_ids: z.array(z.string()).min(1).describe("Base36 comment ids to expand, taken from a 'more' node returned by get_post_comments (not arbitrary ids).")
	}),
	execute: async (args) => {
		const client = unwrapClient();
		return (await client.getMoreComments(args.link_id, args.comment_ids)).fold((err) => toolError(`Failed to expand comments: ${err.message}`), (comments) => {
			if (comments.length === 0) return "No additional comments were returned for those ids.";
			const commentList = comments.map((comment, index) => {
				const formatted = formatCommentInfo(comment, 300);
				const flags = [...comment.edited ? ["*(edited)*"] : [], ...comment.isSubmitter ? ["**OP**"] : []];
				return `### ${index + 1}. u/${comment.author} ${flags.join(" ")}
> ${formatted.content}

- Score: ${comment.score.toLocaleString()}
- Link: ${formatted.link}`;
			}).join("\n\n");
			return `# Expanded Comments (${comments.length})

${commentList}${archiveDisclaimer(client)}`;
		});
	}
});
async function main() {
	await setupRedditClient();
	const port = parseInt(readEnv("PORT").orElse("3000"));
	const host = readEnv("HOST").orElse("127.0.0.1");
	if (useHttp) {
		console.error(`[Setup] Starting HTTP server on ${host}:${port}`);
		await server.start({
			transportType: "httpStream",
			httpStream: {
				port,
				host,
				endpoint: "/mcp",
				cors: true
			}
		});
		console.error(`[Setup] HTTP server ready at http://${host}:${port}/mcp`);
	} else {
		console.error("[Setup] Starting in stdio mode");
		if (process.stdin.isTTY) {
			console.error("[Setup] ⚠ stdin is a terminal. This server speaks MCP JSON-RPC over stdio and expects an MCP client (Claude Desktop, Claude Code, MCP Inspector) on the other end — typed input will cause JSON parse errors.");
			console.error("[Setup]   Test interactively: npx @modelcontextprotocol/inspector npx reddit-mcp-server");
			console.error("[Setup]   Or run as HTTP:       TRANSPORT_TYPE=httpStream npx reddit-mcp-server");
		}
		await server.start({ transportType: "stdio" });
	}
}
process.on("SIGINT", () => {
	console.error("[Shutdown] Shutting down Reddit MCP Server...");
	process.exit(0);
});
process.on("SIGTERM", () => {
	console.error("[Shutdown] Shutting down Reddit MCP Server...");
	process.exit(0);
});
main().catch(console.error);
export {};

//# sourceMappingURL=index.js.map