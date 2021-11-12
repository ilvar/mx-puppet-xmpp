/*
Copyright 2020 mx-puppet-xmpp
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {
	PuppetBridge, IRemoteUser, IRemoteRoom, IReceiveParams, IMessageEvent, IFileEvent, Log, MessageDeduplicator, Util,
	IRetList, IReplyEvent,
} from "mx-puppet-bridge";
import { Client } from "./client";
import * as decodeHtml from "decode-html";
import * as escapeHtml from "escape-html";
import { MatrixMessageParser } from "./matrixmessageparser";
import { XmppMessageParser } from "./xmppmessageparser";
import * as cheerio from "cheerio";
import ExpireSet from "expire-set";

const log = new Log("XmppPuppet:xmpp");

interface IXmppPuppet {
	client: Client;
	data: any;
	deletedMessages: ExpireSet<string>;
	restarting: boolean;
}

interface IXmppPuppets {
	[puppetId: number]: IXmppPuppet;
}

interface IStanza {
	attrs: {to: string, from:string, id: string};

	getChild(path: string): {text: () => string}
}

export class Xmpp {
	private puppets: IXmppPuppets = {};
	private messageDeduplicator: MessageDeduplicator;
	private matrixMessageParser: MatrixMessageParser;
	private xmppMessageParser: XmppMessageParser;
	constructor(
		private puppet: PuppetBridge,
	) {
		this.messageDeduplicator = new MessageDeduplicator();
		this.matrixMessageParser = new MatrixMessageParser();
		this.xmppMessageParser = new XmppMessageParser();
	}

	public getUserParams(puppetId: number, contact: any): IRemoteUser {
		return {
			puppetId,
			userId: contact.mri,
			name: contact.displayName,
			avatarUrl: contact.profile ? contact.profile.avatarUrl : null,
		};
	}

	public getRoomParams(puppetId: number, conversation: any): IRemoteRoom {
		let avatarUrl: string | null = null;
		let name: string | null = null;
		const p = this.puppets[puppetId];
		return {
			puppetId,
			roomId: conversation.id,
			name,
			avatarUrl,
			downloadFile: async (url: string): Promise<any> => {
				return await p.client.downloadFile(url, "swx_avatar");
			},
		};
	}

	public async getSendParams(puppetId: number, stanza: IStanza): Promise<IReceiveParams | null> {
		const p = this.puppets[puppetId];
		const contact = await p.client.getContact(stanza.attrs.from);
		log.info("stanza.attrs", stanza.attrs);
		const conversation = await p.client.getConversation({
			puppetId: puppetId,
			roomId: stanza.attrs.from.split("/")[0],
		});
		log.info("Received contact", contact);
		log.info("Received conversation", conversation);
		if (!contact || !conversation) {
			return null;
		}
		return {
			user: this.getUserParams(puppetId, contact),
			room: this.getRoomParams(puppetId, conversation),
			eventId: stanza.attrs.id, // tslint:disable-line no-any
		};
	}

	public async stopClient(puppetId: number) {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		await p.client.disconnect();
	}

	public async startClient(puppetId: number) {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		await this.stopClient(puppetId);
		p.client = new Client(p.data.username, p.data.password);
		const client = p.client;
		client.on("text", async (stanza: any) => {
			try {
				await this.handleXmppText(puppetId, stanza);
			} catch (err) {
				log.error("Error while handling text event", err);
			}
		});
		client.on("edit", async (stanza: any) => {
			try {
				await this.handleXmppEdit(puppetId, stanza);
			} catch (err) {
				log.error("Error while handling edit event", err);
			}
		});
		client.on("location", async (stanza: any) => {
			try {

			} catch (err) {
				log.error("Error while handling location event", err);
			}
		});
		client.on("file", async (stanza: any) => {
			try {
				await this.handleXmppFile(puppetId, stanza);
			} catch (err) {
				log.error("Error while handling file event", err);
			}
		});
		client.on("typing", async (stanza: any, typing: boolean) => {
			try {
				await this.handleXmppTyping(puppetId, stanza, typing);
			} catch (err) {
				log.error("Error while handling typing event", err);
			}
		});
		client.on("presence", async (stanza: any) => {
			try {
				await this.handleXmppPresence(puppetId, stanza);
			} catch (err) {
				log.error("Error while handling presence event", err);
			}
		});
		client.on("receipt", async (stanza: any) => {
			try {
				await this.handleXmppPresence(puppetId, stanza);
			} catch (err) {
				log.error("Error while handling receipt event", err);
			}
		});
		client.on("updateContact", async (oldContact: any | null, newContact: any) => {
			try {
				let update = oldContact === null;
				const newUser = this.getUserParams(puppetId, newContact);
				if (oldContact) {
					const oldUser = this.getUserParams(puppetId, oldContact);
					update = oldUser.name !== newUser.name || oldUser.avatarUrl !== newUser.avatarUrl;
				}
				if (update) {
					await this.puppet.updateUser(newUser);
				}
			} catch (err) {
				log.error("Error while handling updateContact event", err);
			}
		});
		const MINUTE = 60000;
		client.on("error", async (err: Error) => {
			if (p.restarting) {
				await this.puppet.sendStatusMessage(puppetId, "Got an error, but am already restarting, ignoring....");
				return;
			}
			p.restarting = true;
			const causeName = (err as any).cause ? (err as any).cause.name : "";
			log.error("Error when polling", err.message);
			log.error(err);
			if (causeName === "UnexpectedHttpStatus") {
				await this.puppet.sendStatusMessage(puppetId, "Error: " + err);
				await this.puppet.sendStatusMessage(puppetId, "Reconnecting in a minute... ");
				await this.stopClient(puppetId);
				p.data.state = undefined; // delete the sate so that we re-login for sure
				setTimeout(async () => {
					await this.startClient(puppetId);
				}, MINUTE);
			} else {
				log.error("baaaad error");
				await this.puppet.sendStatusMessage(puppetId, "Super bad error, restarting in a minute. This is stupid. And will hopefully be fixed in the future.");
				await this.stopClient(puppetId);
				p.data.state = undefined; // delete the sate so that we re-login for sure
				setTimeout(async () => {
					await this.startClient(puppetId);
				}, MINUTE);
			}
		});
		try {
			await client.connect();
			p.restarting = false;
			await this.puppet.setUserId(puppetId, client.username);
			p.data.state = client.getState;
			await this.puppet.setPuppetData(puppetId, p.data);
			await this.puppet.sendStatusMessage(puppetId, "connected");
		} catch (err) {
			log.error("Failed to connect", err.body || err);
			p.data.state = undefined; // delete the sate so that we re-login for sure
			await this.puppet.sendStatusMessage(puppetId, "Failed to connect, reconnecting in a minute... " + err);
			setTimeout(async () => {
				await this.startClient(puppetId);
			}, MINUTE);
		}
	}

	public async newPuppet(puppetId: number, data: any) {
		if (this.puppets[puppetId]) {
			await this.deletePuppet(puppetId);
		}
		const client = new Client(data.username, data.password);
		const TWO_MIN = 120000;
		this.puppets[puppetId] = {
			client,
			data,
			deletedMessages: new ExpireSet(TWO_MIN),
			restarting: false,
		};
		await this.startClient(puppetId);
	}

	public async deletePuppet(puppetId: number) {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		await p.client.disconnect();
		delete this.puppets[puppetId];
	}

	public async createUser(remoteUser: IRemoteUser): Promise<IRemoteUser | null> {
		const p = this.puppets[remoteUser.puppetId];
		if (!p) {
			return null;
		}
		log.info(`Received create request for user update puppetId=${remoteUser.puppetId} userId=${remoteUser.userId}`);
		const contact = await p.client.getContact(remoteUser.userId);
		if (!contact) {
			return null;
		}
		return this.getUserParams(remoteUser.puppetId, contact);
	}

	public async createRoom(room: IRemoteRoom): Promise<IRemoteRoom | null> {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return null;
		}
		log.info(`Received create request for channel update puppetId=${room.puppetId} roomId=${room.roomId}`);
		const conversation = await p.client.getConversation(room);
		if (!conversation) {
			return null;
		}
		return this.getRoomParams(room.puppetId, conversation);
	}

	public async getDmRoom(remoteUser: IRemoteUser): Promise<string | null> {
		const p = this.puppets[remoteUser.puppetId];
		if (!p) {
			return null;
		}
		const contact = await p.client.getContact(remoteUser.userId);
		if (!contact) {
			return null;
		}
		return `dm-${remoteUser.puppetId}-${contact.mri}`;
	}

	public async listUsers(puppetId: number): Promise<IRetList[]> {
		const p = this.puppets[puppetId];
		if (!p) {
			return [];
		}
		const reply: IRetList[] = [];
		for (const [, contact] of p.client.contacts) {
			if (!contact) {
				continue;
			}
			reply.push({
				id: contact.mri,
				name: contact.displayName,
			});
		}
		return reply;
	}

	public async listRooms(puppetId: number): Promise<IRetList[]> {
		const p = this.puppets[puppetId];
		if (!p) {
			return [];
		}
		const reply: IRetList[] = [];
		for (const [, conversation] of p.client.conversations) {
			if (!conversation || conversation.id.startsWith("8:")) {
				continue;
			}
			reply.push({
				id: conversation.id,
				name: (conversation.threadProperties && conversation.threadProperties.topic) || "",
			});
		}
		return reply;
	}

	public async getUserIdsInRoom(room: IRemoteRoom): Promise<Set<string> | null> {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return null;
		}
		log.info("getUserIdsInRoom", room);
		const conversation = await p.client.getConversation(room);
		if (!conversation) {
			return null;
		}
		const users = new Set<string>();
		if (conversation.members) {
			for (const member of conversation.members) {
				users.add(member);
			}
		}
		log.info("getUserIdsInRoom users", users);
		return users;
	}

	public async handleMatrixMessage(room: IRemoteRoom, data: IMessageEvent) {
		log.info("handleMatrixMessage");
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		log.info("Received message from matrix");
		const conversation = await p.client.getConversation(room);
		if (!conversation) {
			log.warn(`Room ${room.roomId} not found!`);
			return;
		}
		let msg: string;
		if (data.formattedBody) {
			msg = this.matrixMessageParser.parse(data.formattedBody);
		} else {
			msg = escapeHtml(data.body);
		}
		const dedupeKey = `${room.puppetId};${room.roomId}`;
		this.messageDeduplicator.lock(dedupeKey, p.client.username, msg);
		const ret = await p.client.sendMessage(conversation.id, msg);
		const eventId = ret && ret.MessageId;
		this.messageDeduplicator.unlock(dedupeKey, p.client.username, eventId);
		if (eventId) {
			await this.puppet.eventSync.insert(room, data.eventId!, eventId);
		}
	}

	public async handleMatrixEdit(room: IRemoteRoom, eventId: string, data: IMessageEvent) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		log.info("Received edit from matrix");
		const conversation = await p.client.getConversation(room);
		if (!conversation) {
			log.warn(`Room ${room.roomId} not found!`);
			return;
		}
		let msg: string;
		if (data.formattedBody) {
			msg = this.matrixMessageParser.parse(data.formattedBody);
		} else {
			msg = escapeHtml(data.body);
		}
		const dedupeKey = `${room.puppetId};${room.roomId}`;
		this.messageDeduplicator.lock(dedupeKey, p.client.username, msg);
		await p.client.sendEdit(conversation.id, eventId, msg);
		const newEventId = "";
		this.messageDeduplicator.unlock(dedupeKey, p.client.username, newEventId);
		if (newEventId) {
			await this.puppet.eventSync.insert(room, data.eventId!, newEventId);
		}
	}

	public async handleMatrixReply(room: IRemoteRoom, eventId: string, data: IReplyEvent) {
		log.info("handleMatrixReply");
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		log.info("Received reply from matrix");
		const conversation = await p.client.getConversation(room);
		if (!conversation) {
			log.warn(`Room ${room.roomId} not found!`);
			return;
		}
		let msg: string;
		if (data.formattedBody) {
			msg = this.matrixMessageParser.parse(data.formattedBody);
		} else {
			msg = escapeHtml(data.body);
		}
		// now prepend the reply
		const reply = data.reply;
		const authorRawId = reply.user.user ? reply.user.user.userId : p.client.username;
		const author = escapeHtml(authorRawId.substr(authorRawId.indexOf(":") + 1));
		const ownContact = await p.client.getContact(p.client.username);
		const authorname = escapeHtml(reply.user.displayname);
		const conversationId = escapeHtml(conversation.id);
		const timestamp = Math.round(Number(eventId) / 1000).toString();
		const origEventId = (await this.puppet.eventSync.getMatrix(room, eventId))[0];
		let contents = "";
		if (reply.message) {
			if (reply.message.formattedBody) {
				contents = this.matrixMessageParser.parse(reply.message.formattedBody);
			} else {
				contents = escapeHtml(reply.message.body);
			}
		} else if (reply.file) {
			contents = `${reply.file.filename}: ${reply.file.url}`;
		}
		const quote = `<quote author="${author}" authorname="${authorname}" timestamp="${timestamp}" ` +
			`conversation="${conversationId}" messageid="${escapeHtml(eventId)}">` +
			`<legacyquote>[${timestamp}] ${authorname}: </legacyquote>${contents}<legacyquote>

&lt;&lt;&lt; </legacyquote></quote>`;
		msg = quote + msg;
		const dedupeKey = `${room.puppetId};${room.roomId}`;
		this.messageDeduplicator.lock(dedupeKey, p.client.username, msg);
		const ret = await p.client.sendMessage(conversation.id, msg);
		const newEventId = ret && ret.MessageId;
		this.messageDeduplicator.unlock(dedupeKey, p.client.username, newEventId);
		if (newEventId) {
			await this.puppet.eventSync.insert(room, data.eventId!, newEventId);
		}
	}

	public async handleMatrixRedact(room: IRemoteRoom, eventId: string) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		log.info("Received edit from matrix");
		const conversation = await p.client.getConversation(room);
		if (!conversation) {
			log.warn(`Room ${room.roomId} not found!`);
			return;
		}
		p.deletedMessages.add(eventId);
		await p.client.sendDelete(conversation.id, eventId);
	}

	public async handleMatrixImage(room: IRemoteRoom, data: IFileEvent) {
		// TODO
		// await this.handleMatrixFile(room, data, "sendImage");
	}

	public async handleMatrixAudio(room: IRemoteRoom, data: IFileEvent) {
		// TODO
		// await this.handleMatrixFile(room, data, "sendAudio");
	}

	public async handleMatrixFile(room: IRemoteRoom, data: IFileEvent, method?: string) {
		// TODO
		// if (!method) {
		// 	method = "sendDocument";
		// }
		// const p = this.puppets[room.puppetId];
		// if (!p) {
		// 	return;
		// }
		// log.info("Received file from matrix");
		// const conversation = await p.client.getConversation(room);
		// if (!conversation) {
		// 	log.warn(`Room ${room.roomId} not found!`);
		// 	return;
		// }
		// const buffer = await Util.DownloadFile(data.url);
		// const opts: XmppNewMediaMessage = {
		// 	file: buffer,
		// 	name: data.filename,
		// };
		// if (data.info) {
		// 	if (data.info.w) {
		// 		opts.width = data.info.w;
		// 	}
		// 	if (data.info.h) {
		// 		opts.height = data.info.h;
		// 	}
		// }
		// const dedupeKey = `${room.puppetId};${room.roomId}`;
		// this.messageDeduplicator.lock(dedupeKey, p.client.username, `file:${data.filename}`);
		// const ret = await p.client[method](conversation.id, opts);
		// const eventId = ret && ret.MessageId;
		// this.messageDeduplicator.unlock(dedupeKey, p.client.username, eventId);
		// if (eventId) {
		// 	await this.puppet.eventSync.insert(room, data.eventId!, eventId);
		// }
	}

	private async handleXmppText(
		puppetId: number,
		stanza: IStanza,
	) {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		log.info("Got new xmpp message");
		log.silly(stanza);
		const params = await this.getSendParams(puppetId, stanza);
		if (!params) {
			log.warn("Couldn't generate params");
			return;
		}
		let msg = stanza.getChild("body").text();
		let emote = false;
		const dedupeKey = `${puppetId};${params.room.roomId}`;

		if (await this.messageDeduplicator.dedupe(dedupeKey, params.user.userId, params.eventId, msg)) {
			log.silly("normal message dedupe");
			return;
		}
		if (msg.trim().startsWith("<quote")) {
			// TODO
			// okay, we might have a reply...
			// const $ = cheerio.load(msg);
			// const quote = $("quote");
			// const messageid = quote.attr("messageid");
			// if (messageid) {
			// 	const sendQuoteMsg = this.xmppMessageParser.parse(msg, { noQuotes: true });
			// 	await this.puppet.sendReply(params, messageid, sendQuoteMsg);
			// 	return;
			// }
		}
		let sendMsg: IMessageEvent;
		sendMsg = {
			body: msg,
		};
		await this.puppet.sendMessage(params, sendMsg);
	}

	private async handleXmppEdit(
		puppetId: number,
		stanza: IStanza,
	) {
		// TODO
		// const p = this.puppets[puppetId];
		// if (!p) {
		// 	return;
		// }
		// const rich = resource.native.messagetype.startsWith("RichText");
		// log.info("Got new xmpp edit");
		// log.silly(resource);
		// const params = await this.getSendParams(puppetId, resource);
		// if (!params) {
		// 	log.warn("Couldn't generate params");
		// 	return;
		// }
		// let msg = resource.content;
		// let emote = false;
		// if (resource.native.xmppemoteoffset) {
		// 	emote = true;
		// 	msg = msg.substr(Number(resource.native.xmppemoteoffset));
		// }
		// const dedupeKey = `${puppetId};${params.room.roomId}`;
		// if (await this.messageDeduplicator.dedupe(dedupeKey, params.user.userId, params.eventId, msg)) {
		// 	log.silly("normal message dedupe");
		// 	return;
		// }
		// let sendMsg: IMessageEvent;
		// if (rich) {
		// 	sendMsg = this.xmppMessageParser.parse(msg, { noQuotes: msg.trim().startsWith("<quote") });
		// } else {
		// 	sendMsg = {
		// 		body: msg,
		// 	};
		// }
		// if (emote) {
		// 	sendMsg.emote = true;
		// }
		// if (resource.content) {
		// 	await this.puppet.sendEdit(params, resource.id, sendMsg);
		// } else if (p.deletedMessages.has(resource.id)) {
		// 	log.silly("normal message redact dedupe");
		// 	return;
		// } else {
		// 	await this.puppet.sendRedact(params, resource.id);
		// }
	}

	private async handleXmppFile(puppetId: number, stanza: IStanza) {
		// TODO
		// const p = this.puppets[puppetId];
		// if (!p) {
		// 	return;
		// }
		// log.info("Got new xmpp file");
		// log.silly(resource);
		// const params = await this.getSendParams(puppetId, resource);
		// if (!params) {
		// 	log.warn("Couldn't generate params");
		// 	return;
		// }
		// const filename = resource.original_file_name;
		// const dedupeKey = `${puppetId};${params.room.roomId}`;
		// if (await this.messageDeduplicator.dedupe(dedupeKey, params.user.userId, params.eventId, `file:${filename}`)) {
		// 	log.silly("file message dedupe");
		// 	return;
		// }
		// const buffer = await p.client.downloadFile(resource.uri);
		// await this.puppet.sendFileDetect(params, buffer, filename);
	}

	private async handleXmppTyping(puppetId: number, stanza: IStanza, typing: boolean) {
		// TODO
		// const p = this.puppets[puppetId];
		// if (!p) {
		// 	return;
		// }
		// log.info("Got new xmpp typing event");
		// log.silly(resource);
		// const params = await this.getSendParams(puppetId, resource);
		// if (!params) {
		// 	log.warn("Couldn't generate params");
		// 	return;
		// }
		// await this.puppet.setUserTyping(params, typing);
	}

	private async handleXmppPresence(puppetId: number, stanza: IStanza) {
		// TODO
		// const p = this.puppets[puppetId];
		// if (!p) {
		// 	return;
		// }
		// log.info("Got new xmpp presence event");
		// log.silly(resource);
		// const content = JSON.parse(resource.native.content);
		// const contact = await p.client.getContact(content.user);
		// const conversation = await p.client.getConversation({
		// 	puppetId,
		// 	roomId: resource.conversation,
		// });
		// if (!contact || !conversation) {
		// 	log.warn("Couldn't generate params");
		// 	return;
		// }
		// const params: IReceiveParams = {
		// 	user: this.getUserParams(puppetId, contact),
		// 	room: this.getRoomParams(puppetId, conversation),
		// };
		// const [id, _, clientId] = content.consumptionhorizon.split(";");
		// params.eventId = id;
		// await this.puppet.sendReadReceipt(params);
		// params.eventId = clientId;
		// await this.puppet.sendReadReceipt(params);
	}
}
