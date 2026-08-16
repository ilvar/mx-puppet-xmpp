import {
	IProtocolInformation,
	IRetData,
	Log,
	PuppetBridge,
} from "mx-puppet-bridge";
import commandLineArgs from "command-line-args";
import commandLineUsage from "command-line-usage";
import { Client } from "./client";
import { Xmpp } from "./xmpp";

const log = new Log("XmppPuppet:index");

const commandOptions = [
	{name: "register", alias: "r", type: Boolean},
	{name: "registration-file", alias: "f", type: String},
	{name: "config", alias: "c", type: String},
	{name: "help", alias: "h", type: Boolean},
];
const options = Object.assign({
	register: false,
	"registration-file": "xmpp-registration.yaml",
	config: "config.yaml",
	help: false,
}, commandLineArgs(commandOptions));

if (options.help) {
	console.log(commandLineUsage([
		{
			header: "Matrix XMPP Puppet Bridge",
			content: "A Matrix puppeting bridge for XMPP",
		},
		{
			header: "Options",
			optionList: commandOptions,
		},
	]));
	process.exit(0);
}

const protocol: IProtocolInformation = {
	features: {
		image: false,
		audio: false,
		file: false,
		edit: false,
		reply: false,
		globalNamespace: true,
	},
	id: "xmpp",
	displayname: "XMPP",
	externalUrl: "https://xmpp.org/",
};

const puppet = new PuppetBridge(options["registration-file"], options.config, protocol);

if (options.register) {
	puppet.readConfig(false);
	try {
		puppet.generateRegistration({
			prefix: "_xmpppuppet_",
			id: "xmpp-puppet",
			url: `http://${puppet.Config.bridge.bindAddress}:${puppet.Config.bridge.port}`,
		});
	} catch (err) {
		console.error("Couldn't generate registration file:", err);
		process.exitCode = 1;
	}
} else {
	void run().catch((err) => {
		log.error("Bridge failed", err);
		process.exitCode = 1;
	});
}

async function run(): Promise<void> {
	await puppet.init();
	const xmpp = new Xmpp(puppet);
	puppet.on("puppetNew", xmpp.newPuppet.bind(xmpp));
	puppet.on("puppetDelete", xmpp.deletePuppet.bind(xmpp));
	puppet.on("message", xmpp.handleMatrixMessage.bind(xmpp));
	puppet.setCreateUserHook(xmpp.createUser.bind(xmpp));
	puppet.setCreateRoomHook(xmpp.createRoom.bind(xmpp));
	puppet.setGetDmRoomIdHook(xmpp.getDmRoom.bind(xmpp));
	puppet.setListUsersHook(xmpp.listUsers.bind(xmpp));
	puppet.setListRoomsHook(xmpp.listRooms.bind(xmpp));
	puppet.setGetUserIdsInRoomHook(xmpp.getUserIdsInRoom.bind(xmpp));
	puppet.setGetDescHook(async (_puppetId: number, data: {username?: string}): Promise<string> => {
		return data.username ? `XMPP as \`${data.username}\`` : "XMPP";
	});
	puppet.setGetDataFromStrHook(async (str: string): Promise<IRetData> => {
		const separator = str.indexOf(" ");
		if (separator <= 0 || separator === str.length - 1) {
			return {success: false, error: "Expected: <jid> <password>"} as IRetData;
		}
		const username = str.slice(0, separator).trim();
		const password = str.slice(separator + 1);
		const data = {username, password};
		const client = new Client(username, password);
		try {
			await client.connect();
			return {success: true, data} as IRetData;
		} catch (err) {
			log.verbose(`Failed to authenticate ${username}`);
			log.silly(err);
			return {success: false, error: "Could not authenticate to XMPP"} as IRetData;
		} finally {
			await client.disconnect();
		}
	});
	puppet.setBotHeaderMsgHook(() => "XMPP Puppet Bridge");
	await puppet.start();
}
