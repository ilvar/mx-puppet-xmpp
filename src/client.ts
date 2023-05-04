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

import { Log, IRemoteRoom } from "mx-puppet-bridge";
import { EventEmitter } from "events";
import { client, xml } from "@xmpp/client";
import { Client as XmppClient } from "@xmpp/client-core";
import * as Parser from "node-html-parser";
import fetch from "node-fetch";

const log = new Log("XmppPuppet:client");

type Contact = {
	personId: string,
	workloads: any,
	mri: string,
	blocked: boolean,
	authorized: boolean,
	creationTime: Date,
	displayName: string,
	displayNameSource: any, // tslint:disable-line no-any
	profile: {
		roomId: string,
		avatarUrl: string | undefined,
		name: {
			first: string | undefined,
			surname: string | undefined,
			nickname: string | undefined,
		},
	},
}

export class Client extends EventEmitter {
	public contacts: Map<string, Contact> = new Map();
	public conversations: Map<string, any> = new Map();
	private api: XmppClient;
	constructor(
		private loginUsername: string,
		private password: string,
	) { super(); }

	public get username(): string {
		return this.loginUsername.split("@")[0].trim();
	}

	public get domain(): string {
		return this.loginUsername.split("@")[1].trim();
	}

	public async getWebsocket(): Promise<string> {
		const response = await fetch(`https://${this.domain}/.well-known/host-meta`);
		const xmlData = await response.text();
		const document = Parser.parse(xmlData) as unknown as HTMLElement;
		const relValue = "urn:xmpp:alt-connections:websocket"
		const line = document.querySelectorAll(`[rel="${relValue}"]`);
		return line[0].getAttribute('href') as string;
	}

	public get getState() {
		return {};
	}

	public async connect() {
		const websocketUrl = await this.getWebsocket();
		log.info("Connecting to ", websocketUrl);
		log.info(this.username);
		log.info(this.domain);

		this.api = client({
			service: websocketUrl,
			domain: this.domain,
			//resource: "mx_bridge",
			username: this.username,
			password: this.password,
		});

		await this.startupApi();

		this.api.on("error", (err: Error) => {
			log.error("An error occured", err);
			this.emit("error", err);
		});
		this.api.start();
	}

	public async disconnect() {
		if (this.api) {
			await this.api.stop();
		}
	}

	public async getContact(username: string): Promise<any> {
		log.debug(`Fetching contact from: ` + username);
		if (this.contacts.has(username)) {
			const ret = this.contacts.get(username);
			return ret;
		}
		try {
			const contact = {
				personId: username,
				workloads: null,
				mri: username,
				blocked: false,
				authorized: true,
				creationTime: new Date(),
				displayName: username,
				displayNameSource: "profile" as any, // tslint:disable-line no-any
				profile: {
					roomId: username,
					avatarUrl: undefined,
					name: {
						first: undefined,
						surname: undefined,
						nickname: username,
					},
				},
			};
			this.contacts.set(contact.mri, contact);
			log.debug("Returning new result");
			log.silly(contact);
			return contact || null;
		} catch (err) {
			// contact not found
			log.debug("No such contact found");
			log.debug(err.body || err);
			return null;
		}
	}

	public async getConversation(room: IRemoteRoom): Promise<any> {
		log.info(`Fetching conversation`, room);
		log.info(`Fetching conversation puppetId=${room.puppetId} roomId=${room.roomId}`);
		let id = room.roomId;
		if (this.conversations.has(id)) {
			log.info("Returning cached result");
			const ret = this.conversations.get(id) || null;
			log.silly(ret);
			return ret;
		}
		try {
			const conversation = {id: room.roomId, members: []};
			this.conversations.set(room.roomId, conversation || null);
			log.info("Returning new result");
			log.info(conversation);
			return conversation || null;
		} catch (err) {
			// conversation not found
			log.error("No such conversation found");
			log.error(err.body || err);
			return null;
		}
	}

	public async downloadFile(url: string, type: string = "imgpsh_fullsize_anim") {
		// TODO
	}

	public async sendMessage(conversationId: string, msg: string) {
		return await this.api.send(xml(
			"message",
			{ type: "chat", to: conversationId },
			xml("body", {}, msg),
		));
	}

	public async sendEdit(conversationId: string, messageId: string, msg: string) {
		// TODO
		// return await this.api.sendEdit({
		// 	textContent: msg,
		// }, conversationId, messageId);
	}

	public async sendDelete(conversationId: string, messageId: string) {
		// TODO
		// return await this.api.sendDelete(conversationId, messageId);
	}

	public async sendAudio(
		conversationId: string,
		opts: any,
	) {
		// TODO
		// return await this.api.sendAudio(opts, conversationId);
	}

	public async sendDocument(
		conversationId: string,
		opts: any,
	) {
		// TODO
		// return await this.api.sendDocument(opts, conversationId);
	}

	public async sendImage(
		conversationId: string,
		opts: any,
	) {
		// TODO
		// return await this.api.sendImage(opts, conversationId);
	}

	private async startupApi() {
		this.api.on("stanza", async (stanza) => {
			if (stanza.is("message")) {
				this.emit("text", stanza);
			}
		});
		  
		this.api.on("online", async (address) => {
			await this.api.send(xml("presence"));
		});

		// const contacts = await this.api.getContacts();
		// for (const contact of contacts) {
		// 	this.contacts.set(contact.mri, contact);
		// }
	}
}

