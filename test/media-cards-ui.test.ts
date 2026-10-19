// Bare links that show as the thing itself, in an isolated real browser (`web/media-cards.js`).
// These tests never select a real provider or use the running server's people, data, or browser profile.
import {
    type App,
    cleanUp,
    home,
    newSession,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const { PocketApp } = await import("../src/server/app.ts");

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const SHORT = "https://youtu.be/9QyiEgv33z4";
const PICTURE = "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg";
/** What Pi answers with, so every form of link is in one reply to look at. */
const REPLY = [
    "A video:",
    "",
    VIDEO,
    "",
    // A link under what is said about it, with no blank line: one paragraph, split by the line break.
    ["Under a line:", "A video:", SHORT].join("\n"),
    "",
    "An image:",
    "",
    PICTURE,
    "",
    "In a sentence:",
    "",
    `Watch ${VIDEO} when you can.`,
    "",
    "Written as words:",
    "",
    "[the trailer](https://www.youtube.com/watch?v=5qap5aO4i9A)",
    "",
    "Not a video:",
    "",
    "https://www.youtube.com/watch?v=short",
].join("\n");

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let conversation: ConversationId;

/** Run a script in the page and read back the JSON it returns. */
const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;

/** Wait until a condition in the page is true. */
const see = (condition: string, what: string) =>
    until(() => inPage<boolean>(`return JSON.stringify(Boolean(${condition}))`), what, 20_000);

const count = (selector: string) =>
    inPage<number>(
        `return JSON.stringify(document.querySelectorAll(${JSON.stringify(selector)}).length)`,
    );

/** The links of the reply, as their addresses: what stayed a link, rather than becoming a card. */
const plainLinks = () =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll("p a[href]")].map((each) => each.textContent.trim()))`,
    );

before(async () => {
    if (chromium === undefined) {
        return;
    }

    const faux = scriptedModel(() => fauxAssistantMessage([fauxText(REPLY)]));

    app = await PocketApp.open({
        dataDir: join(root, "media-cards-data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => models.registerNativeProvider(faux.provider),
    });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "media-cards-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    conversation = await newSession(app);
    await say(app, conversation, "Two carriers of links");

    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${Number(conversation)}`);
    await see(
        `(await import("/store.js")).store.state.view.conversation?.id === ${JSON.stringify(conversation)}`,
        "the conversation",
    );
    await see(`document.querySelectorAll(".media-card").length > 0`, "a card");
});

after(async () => {
    // The player keeps fetching a moment after the page closes; the profile folder must be free to remove.
    await browsers?.closeAll({ final: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    server?.closeAllConnections();
    server?.close();
    cleanUp();
});

test("a bare video link shows as its still, and as the player once asked for", real, async () => {
    // Two videos (the long form, and one under a line), no image yet, and no player before a tap.
    assert.equal(await count(".media-video"), 2);
    assert.equal(await count(".media-card iframe"), 0);

    // The card knows which video it is, and its still comes from where YouTube hosts them.
    const still = await inPage<string>(
        `return JSON.stringify(document.querySelector(".media-video").dataset.href + " " + document.querySelector(".media-video img").src)`,
    );

    assert.equal(still, `${VIDEO} https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg`);

    await page.click({ selector: ".media-video .media-play" });
    await see(`document.querySelector(".media-video iframe") !== null`, "the player");

    const played = await inPage<string>(
        `return JSON.stringify([...document.querySelectorAll(".media-video iframe")].map((each) => each.getAttribute("src") + " | " + each.getAttribute("allow")).join(";"))`,
    );

    assert.equal(
        played,
        "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0 | accelerometer; autoplay; encrypted-media; picture-in-picture",
    );
});

test("a bare image link shows as the image", real, async () => {
    await see(`document.querySelector(".media-image") !== null`, "the image");
    assert.equal(await count(".media-image img"), 1);
    assert.equal(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(".media-image img").src)`,
        ),
        PICTURE,
    );
});

test(
    "a link among words, one written as words, and a malformed address stay links",
    real,
    async () => {
        const links = await plainLinks();

        // `v=short` names no video, so it stays an ordinary link rather than an empty player.
        assert.deepEqual(links, [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "the trailer",
            "https://www.youtube.com/watch?v=short",
        ]);

        assert.equal(await count(".media-video"), 2);
        assert.equal(await count(".media-image"), 1);
    },
);

test("a card sits in its paragraph, and sends nothing about where it came from", real, async () => {
    // A block element inside a paragraph would make the browser close it, leaving an empty one behind the card.
    const around = await inPage<{ parent: string; empties: number }>(
        `return JSON.stringify((() => {
            const card = document.querySelector(".media-image");

            return {
                parent: card.parentElement.tagName,
                empties: [...card.closest(".md").querySelectorAll("p")].filter((p) => p.textContent.trim() === "" && p.children.length === 0).length,
            };
        })())`,
    );

    assert.equal(around.parent, "P");
    assert.equal(around.empties, 0);

    // Nothing is sent to the host but the picture: no referrer, so it learns no address, port, or self-hosting.
    assert.equal(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(".media-image img").referrerPolicy)`,
        ),
        "no-referrer",
    );
});

test("an image the browser will not load falls back to the link it was", real, async () => {
    // Point a card at a name that cannot resolve, the way a dead link does.
    await inPage(`
        document.querySelector(".media-image img").src = "https://does-not-exist.invalid/nothing.png";
        return JSON.stringify(true);
    `);

    await see(`document.querySelector(".media-file a") !== null`, "the fallback");

    // The link is the address the card was made from, so a picture that stops loading leaves the way open.
    assert.equal(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(".media-file a").getAttribute("href"))`,
        ),
        PICTURE,
    );
    assert.equal(await count(".media-image img"), 0);
});

test("a card fits the width of a phone and is big enough to tap", real, async () => {
    const box = await inPage<{ width: number; screen: number; height: number }>(
        `return JSON.stringify((() => {
            const card = document.querySelector(".media-play");

            return {
                width: card.getBoundingClientRect().width,
                screen: document.documentElement.clientWidth,
                height: card.getBoundingClientRect().height,
            };
        })())`,
    );

    assert.ok(box.width <= box.screen, `the card is ${box.width} wide on a ${box.screen} screen`);
    assert.ok(box.height >= 40, `the play mark is ${box.height} tall`);
});
