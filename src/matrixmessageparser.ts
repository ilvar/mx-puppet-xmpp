import * as Parser from "node-html-parser";

/**
 * Convert Matrix formatted HTML into XEP-0393-compatible plain-text styling.
 * The returned value is suitable for use as an XMPP <body>; XML escaping is
 * deliberately left to the XMPP XML builder.
 */
export class MatrixMessageParser {
	public parse(msg: string): string {
		const nodes = Parser.parse(`<wrap>${msg}</wrap>`);
		return this.walkNode(nodes).trimEnd();
	}

	private walkChildNodes(node: Parser.Node): string {
		return node.childNodes.map((child) => this.walkNode(child)).join("");
	}

	private walkNode(node: Parser.Node): string {
		if (node instanceof Parser.TextNode) {
			return node.text;
		}
		if (!(node instanceof Parser.HTMLElement)) {
			return "";
		}

		const tagName = (node.tagName || "").toLowerCase();
		const children = () => this.walkChildNodes(node);
		switch (tagName) {
			case "em":
			case "i":
				return `_${children()}_`;
			case "strong":
			case "b":
				return `*${children()}*`;
			case "del":
			case "s":
				return `~${children()}~`;
			case "code":
				return `\`${children()}\``;
			case "pre":
				return `\n\`\`\`\n${children()}\n\`\`\`\n`;
			case "a": {
				const href = node.getAttribute("href") || "";
				const label = children();
				if (!href || label === href) {
					return label || href;
				}
				return `${label} (${href})`;
			}
			case "blockquote": {
				const body = children().replace(/\n+$/, "");
				return body.split("\n").map((line) => `> ${line}`).join("\n") + "\n";
			}
			case "br":
				return "\n";
			case "p":
			case "div":
				return `${children()}\n`;
			case "li":
				return `- ${children()}\n`;
			case "ul":
			case "ol":
			case "wrap":
				return children();
			case "mx-reply":
				return "";
			default:
				return children();
		}
	}
}
