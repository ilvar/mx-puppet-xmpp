import { randomUUID } from "node:crypto";
import {
	IMessageEvent,
	IReceiveParams,
	IRemoteRoom,
	IRemoteUser,
	IRetList,
	Log,
	MessageDeduplicator,
	PuppetBridge,
} from "mx-puppet-bridge";
import { Client } from "./client";
import { bareJid } from "./jid";
import { MatrixMessageParser } from "./matrixmessageparser";

const log = new Log("XmppPuppet:xmpp");
const MAX_RECONNECT_DELAY_MS = 60_000;

interface IXmppPuppetData {
	username: string;
	password: string;
}

interface IXmppPuppet {
	client: Client | null;
	data: IXmppPuppetData;
	reconnectAttempt: number;
	reconnectTimer?: NodeJS.Timeout;
	stopping: boolean;
}

interface IXmppPuppets {
	[puppetId: number]: IXmppPuppet;
}

interface IStanza {
	attrs: {to?: string; from?: string; id?: string};
	getChild(path: string): {text: () => string} | undefined;
}

export class Xmpp {
	private readonly puppets: IXmppPuppets = {};
	private readonly messageDeduplicator = new MessageDeduplicator();
	private readonly matrixMessageParser = new MatrixMessageParser();

	constructor(private readonly puppet: PuppetBridge) {}

	public getUserParams(
		puppetId: number,
		contact: {mri: string; displayName: string; profile?: {avatarUrl?: string}},
	): IRemoteUser {
		return {
			puppetId,
			userId: bareJid(contact.mri),
			name: contact.displayName,
			avatarUrl: contact.profile?.avatarUrl || null,
		};
	}

	public getRoomParams(puppetId: number, conversation: {id: string}): IRemoteRoom {
		return {
			puppetId,
			roomId: bareJid(conversation.id),
			name: null,
			avatarUrl: null,
		};
	}

	public async getSendParams(puppetId: number, stanza: IStanza): Promise<IReceiveParams | null> {
		const p = this.puppets[puppetId];
		const from = stanza.attrs.from;
		if (!p?.client || !from) {
			return null;
		}
		const sender = bareJid(from);
		const [contact, conversation] = await Promise.all([
			p.client.getContact(sender),
			p.client.getConversation({puppetId, roomId: sender}),
		]);
		return {
			user: this.getUserParams(puppetId, contact),
			room: this.getRoomParams(puppetId, conversation),
			eventId: stanza.attrs.id || randomUUID(),
		};
	}

	public async stopClient(puppetId: number): Promise<void> {
		const p = this.puppets[puppetId];
		if (!p?.client) {
			return;
		}
		const client = p.client;
		p.client = null;
		p.stopping = true;
		try {
			await client.disconnect();
		} finally {
			p.stopping = false;
		}
	}

	public async startClient(puppetId: number): Promise<void> {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		if (p.reconnectTimer) {
			clearTimeout(p.reconnectTimer);
			p.reconnectTimer = undefined;
		}
		await this.stopClient(puppetId);

		const client = new Client(p.data.username, p.data.password);
		p.client = client;
		client.on("text", (stanza: IStanza) => {
			void this.handleXmppText(puppetId, stanza).catch((err) => {
				log.error("Error while handling XMPP message", err);
			});
		});
		client.on("error", (err: Error) => {
			void this.handleClientFailure(puppetId, client, err);
		});

		try {
			await client.connect();
			if (p.client !== client) {
				await client.disconnect();
				return;
			}
			p.reconnectAttempt = 0;
			await this.puppet.setUserId(puppetId, client.jid);
			await this.puppet.sendStatusMessage(puppetId, "connected");
		} catch (err) {
			await this.handleClientFailure(puppetId, client, err);
		}
	}

	public async newPuppet(puppetId: number, data: IXmppPuppetData): Promise<void> {
		if (this.puppets[puppetId]) {
			await this.deletePuppet(puppetId);
		}
		this.puppets[puppetId] = {
			client: null,
			data,
			reconnectAttempt: 0,
			stopping: false,
		};
		await this.startClient(puppetId);
	}

	public async deletePuppet(puppetId: number): Promise<void> {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		if (p.reconnectTimer) {
			clearTimeout(p.reconnectTimer);
		}
		p.stopping = true;
		const client = p.client;
		p.client = null;
		delete this.puppets[puppetId];
		if (client) {
			await client.disconnect();
		}
	}

	public async createUser(remoteUser: IRemoteUser): Promise<IRemoteUser | null> {
		const client = this.puppets[remoteUser.puppetId]?.client;
		if (!client) {
			return null;
		}
		const contact = await client.getContact(remoteUser.userId);
		return this.getUserParams(remoteUser.puppetId, contact);
	}

	public async createRoom(room: IRemoteRoom): Promise<IRemoteRoom | null> {
		const client = this.puppets[room.puppetId]?.client;
		if (!client) {
			return null;
		}
		const conversation = await client.getConversation(room);
		return this.getRoomParams(room.puppetId, conversation);
	}

	public async getDmRoom(remoteUser: IRemoteUser): Promise<string | null> {
		const client = this.puppets[remoteUser.puppetId]?.client;
		if (!client) {
			return null;
		}
		const contact = await client.getContact(remoteUser.userId);
		return bareJid(contact.mri);
	}

	public async listUsers(puppetId: number): Promise<IRetList[]> {
		const client = this.puppets[puppetId]?.client;
		if (!client) {
			return [];
		}
		return [...client.contacts.values()].map((contact) => ({
			id: contact.mri,
			name: contact.displayName,
		}));
	}

	public async listRooms(puppetId: number): Promise<IRetList[]> {
		const client = this.puppets[puppetId]?.client;
		if (!client) {
			return [];
		}
		return [...client.conversations.values()].map((conversation) => ({
			id: conversation.id,
			name: conversation.id,
		}));
	}

	public async getUserIdsInRoom(room: IRemoteRoom): Promise<Set<string> | null> {
		const client = this.puppets[room.puppetId]?.client;
		if (!client) {
			return null;
		}
		const conversation = await client.getConversation(room);
		return new Set(conversation.members.map(bareJid));
	}

	public async handleMatrixMessage(room: IRemoteRoom, data: IMessageEvent): Promise<void> {
		const client = this.puppets[room.puppetId]?.client;
		if (!client) {
			return;
		}
		const conversation = await client.getConversation(room);
		const msg = data.formattedBody ? this.matrixMessageParser.parse(data.formattedBody) : data.body;
		const dedupeKey = `${room.puppetId};${conversation.id}`;
		this.messageDeduplicator.lock(dedupeKey, client.jid, msg);
		const eventId = await client.sendMessage(conversation.id, msg);
		this.messageDeduplicator.unlock(dedupeKey, client.jid, eventId);
		if (data.eventId) {
			await this.puppet.eventSync.insert(room, data.eventId, eventId);
		}
	}

	private async handleXmppText(puppetId: number, stanza: IStanza): Promise<void> {
		const p = this.puppets[puppetId];
		const body = stanza.getChild("body");
		if (!p?.client || !body) {
			return;
		}
		const params = await this.getSendParams(puppetId, stanza);
		if (!params?.eventId) {
			return;
		}
		const msg = body.text();
		const dedupeKey = `${puppetId};${params.room.roomId}`;
		if (await this.messageDeduplicator.dedupe(
			dedupeKey,
			params.user.userId,
			params.eventId,
			msg,
		)) {
			return;
		}
		await this.puppet.sendMessage(params, {body: msg});
	}

	private async handleClientFailure(puppetId: number, source: Client, err: unknown): Promise<void> {
		const p = this.puppets[puppetId];
		if (!p || p.client !== source || p.stopping) {
			return;
		}
		p.client = null;
		await source.disconnect();
		const message = this.errorMessage(err);
		log.error(`XMPP connection failed for puppet ${puppetId}: ${message}`);
		if (this.isAuthenticationError(message)) {
			await this.puppet.sendStatusMessage(puppetId, `Authentication failed: ${message}`);
			return;
		}
		this.scheduleReconnect(puppetId, message);
	}

	private scheduleReconnect(puppetId: number, reason: string): void {
		const p = this.puppets[puppetId];
		if (!p || p.reconnectTimer) {
			return;
		}
		const baseDelay = Math.min(
			MAX_RECONNECT_DELAY_MS,
			1_000 * (2 ** Math.min(p.reconnectAttempt, 6)),
		);
		const jitter = Math.floor(baseDelay * 0.2 * Math.random());
		const delay = baseDelay + jitter;
		p.reconnectAttempt += 1;
		void this.puppet.sendStatusMessage(
			puppetId,
			`Disconnected (${reason}); reconnecting in ${Math.ceil(delay / 1000)}s`,
		);
		p.reconnectTimer = setTimeout(() => {
			p.reconnectTimer = undefined;
			void this.startClient(puppetId);
		}, delay);
	}

	private isAuthenticationError(message: string): boolean {
		return /not-authorized|authentication failed|invalid credentials|sasl/i.test(message);
	}

	private errorMessage(err: unknown): string {
		return err instanceof Error ? err.message : String(err);
	}
}
