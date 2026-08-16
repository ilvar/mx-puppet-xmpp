import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { client, xml } from "@xmpp/client";
import { IRemoteRoom, Log } from "mx-puppet-bridge";
import * as Parser from "node-html-parser";
import { bareJid, parseJid } from "./jid";

const log = new Log("XmppPuppet:client");
const WEBSOCKET_REL = "urn:xmpp:alt-connections:websocket";
const DISCOVERY_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 15_000;

type XmppApi = ReturnType<typeof client>;

type Contact = {
	personId: string;
	mri: string;
	blocked: boolean;
	authorized: boolean;
	creationTime: Date;
	displayName: string;
	profile: {
		roomId: string;
		avatarUrl: string | undefined;
		name: {
			first: string | undefined;
			surname: string | undefined;
			nickname: string | undefined;
		};
	};
};

export class Client extends EventEmitter {
	public contacts: Map<string, Contact> = new Map();
	public conversations: Map<string, {id: string; members: string[]}> = new Map();
	private api?: XmppApi;
	private readonly account: ReturnType<typeof parseJid>;

	constructor(
		private readonly loginUsername: string,
		private readonly password: string,
		private readonly websocketOverride = process.env.XMPP_WEBSOCKET_URL,
	) {
		super();
		this.account = parseJid(loginUsername);
	}

	public get username(): string {
		return this.account.local;
	}

	public get domain(): string {
		return this.account.domain;
	}

	public get jid(): string {
		return this.account.bare;
	}

	public async getWebsocket(): Promise<string> {
		if (this.websocketOverride) {
			return this.validateWebsocketUrl(this.websocketOverride);
		}

		const base = `https://${this.domain}`;
		const errors: string[] = [];
		try {
			const response = await this.fetchWithTimeout(`${base}/.well-known/host-meta`);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const document = Parser.parse(await response.text());
			const link = document.querySelectorAll("*").find((element) => {
				return (element.tagName || "").toLowerCase() === "link" && element.getAttribute("rel") === WEBSOCKET_REL;
			});
			const href = link?.getAttribute("href");
			if (!href) {
				throw new Error("websocket link missing");
			}
			return this.validateWebsocketUrl(href);
		} catch (err) {
			errors.push(`host-meta: ${this.errorMessage(err)}`);
		}

		try {
			const response = await this.fetchWithTimeout(`${base}/.well-known/host-meta.json`);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const document = await response.json() as {links?: Array<{rel?: string; href?: string}>};
			const href = document.links?.find((link) => link.rel === WEBSOCKET_REL)?.href;
			if (!href) {
				throw new Error("websocket link missing");
			}
			return this.validateWebsocketUrl(href);
		} catch (err) {
			errors.push(`host-meta.json: ${this.errorMessage(err)}`);
		}

		throw new Error(`Could not discover an XMPP WebSocket endpoint for ${this.domain}: ${errors.join("; ")}`);
	}

	public async connect(): Promise<void> {
		await this.disconnect();
		const websocketUrl = await this.getWebsocket();
		log.info(`Connecting ${this.jid} to ${websocketUrl}`);

		const api = client({
			service: websocketUrl,
			domain: this.domain,
			username: this.username,
			password: this.password,
			timeout: DISCOVERY_TIMEOUT_MS,
		});
		this.api = api;
		this.startupApi(api);
		await this.waitUntilOnline(api);
	}

	public async disconnect(): Promise<void> {
		const api = this.api;
		this.api = undefined;
		if (!api) {
			return;
		}
		try {
			await api.stop();
		} catch (err) {
			log.warn("Error while stopping XMPP client", err);
		}
	}

	public async getContact(username: string): Promise<Contact> {
		const id = bareJid(username);
		const cached = this.contacts.get(id);
		if (cached) {
			return cached;
		}
		const contact: Contact = {
			personId: id,
			mri: id,
			blocked: false,
			authorized: true,
			creationTime: new Date(),
			displayName: id,
			profile: {
				roomId: id,
				avatarUrl: undefined,
				name: {
					first: undefined,
					surname: undefined,
					nickname: id,
				},
			},
		};
		this.contacts.set(id, contact);
		return contact;
	}

	public async getConversation(room: IRemoteRoom): Promise<{id: string; members: string[]}> {
		const id = bareJid(room.roomId);
		const cached = this.conversations.get(id);
		if (cached) {
			return cached;
		}
		const conversation = {id, members: [id]};
		this.conversations.set(id, conversation);
		return conversation;
	}

	public async sendMessage(conversationId: string, msg: string): Promise<string> {
		const api = this.requireApi();
		const messageId = randomUUID();
		await api.send(xml(
			"message",
			{type: "chat", to: bareJid(conversationId), id: messageId},
			xml("body", {}, msg),
			xml("origin-id", {xmlns: "urn:xmpp:sid:0", id: messageId}),
		));
		return messageId;
	}

	private startupApi(api: XmppApi): void {
		api.on("stanza", (stanza: any) => {
			if (!stanza.is("message") || !stanza.getChild("body")) {
				return;
			}
			this.emit("text", stanza);
		});

		api.on("online", async () => {
			try {
				await api.send(xml("presence"));
			} catch (err) {
				log.error("Failed to send initial presence", err);
			}
		});

		api.on("error", (err: Error) => {
			log.error("XMPP client error", err);
			if (this.listenerCount("error") > 0) {
				this.emit("error", err);
			}
		});
	}

	private async waitUntilOnline(api: XmppApi): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (err?: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				api.removeListener("online", onOnline);
				api.removeListener("error", onError);
				if (err) reject(err); else resolve();
			};
			const onOnline = () => finish();
			const onError = (err: Error) => finish(err);
			const timer = setTimeout(() => finish(new Error("Timed out waiting for XMPP authentication")), CONNECT_TIMEOUT_MS);
			api.once("online", onOnline);
			api.once("error", onError);
			Promise.resolve(api.start()).catch(onError);
		});
	}

	private async fetchWithTimeout(url: string): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
		try {
			return await fetch(url, {
				signal: controller.signal,
				headers: {accept: "application/xrd+xml, application/json;q=0.9, */*;q=0.1"},
			});
		} finally {
			clearTimeout(timer);
		}
	}

	private validateWebsocketUrl(value: string): string {
		const url = new URL(value);
		if (url.protocol === "wss:") return url.toString();
		if (url.protocol === "ws:" && process.env.XMPP_ALLOW_INSECURE_WEBSOCKET === "true") {
			log.warn(`Using insecure XMPP WebSocket endpoint ${url.toString()}`);
			return url.toString();
		}
		throw new Error("XMPP WebSocket endpoint must use wss:// (set XMPP_ALLOW_INSECURE_WEBSOCKET=true to allow ws://)");
	}

	private requireApi(): XmppApi {
		if (!this.api) throw new Error("XMPP client is not connected");
		return this.api;
	}

	private errorMessage(err: unknown): string {
		return err instanceof Error ? err.message : String(err);
	}
}
