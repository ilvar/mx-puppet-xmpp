export interface IParsedJid {
	bare: string;
	local: string;
	domain: string;
}

export function bareJid(value: string): string {
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");
	return slash === -1 ? trimmed : trimmed.slice(0, slash);
}

export function parseJid(value: string): IParsedJid {
	const bare = bareJid(value);
	const at = bare.lastIndexOf("@");
	if (at <= 0 || at === bare.length - 1) {
		throw new Error(`Invalid XMPP JID: ${value}`);
	}
	return {
		bare,
		local: bare.slice(0, at),
		domain: bare.slice(at + 1),
	};
}
