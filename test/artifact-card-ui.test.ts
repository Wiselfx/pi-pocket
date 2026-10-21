// An artifact Pi published, as a card in the message (web/artifact-cards.js), in an isolated real browser.
// These tests never select a real provider or use the running server's people, data, or browser profile.
import {
    type App,
    cleanUp,
    home,
    lastText,
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
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
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

/** The model publishes an artifact, then says what it did. */
const route: FauxResponseStep = (context) => {
    const { role } = lastText(context as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText("Here it is.")]);
    }

    return fauxAssistantMessage(
        [fauxToolCall("artifact", { id: "demo", title: "Demo Page", content: "<h1>one</h1>" })],
        { stopReason: "toolUse" },
    );
};

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

before(async () => {
    if (chromium === undefined) {
        return;
    }

    const faux = scriptedModel(route);

    app = await PocketApp.open({
        dataDir: join(root, "artifact-card-data"),
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
        dataDir: mkdtempSync(join(root, "artifact-card-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    conversation = await newSession(app);
    await say(app, conversation, "make an artifact");

    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${Number(conversation)}`);
    await see(
        `(await import("/store.js")).store.state.view.conversation?.id === ${JSON.stringify(conversation)}`,
        "the conversation",
    );
    await see(`document.querySelector(".artifact-tile") !== null`, "the card");
});

after(async () => {
    // The viewer keeps fetching a moment after the page closes; the profile folder must be free to remove.
    await browsers?.closeAll({ final: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    server?.closeAllConnections();
    server?.close();
    await cleanUp();
});

test("an artifact shows as a card, with its name and what it is", real, async () => {
    assert.equal(await count(".artifact-tile"), 1);

    const card = await inPage<{ name: string; kind: string }>(
        `return JSON.stringify({
            name: document.querySelector(".artifact-card-name").textContent,
            kind: document.querySelector(".artifact-card-kind").textContent,
        })`,
    );

    assert.equal(card.name, "Demo Page");
    assert.equal(card.kind, "Artifact");
    // The card says what it is in a mark of its own.
    assert.equal(await count(".artifact-card-cover svg"), 1);
});

test("the publication is not a call in a group", real, async () => {
    // The card is the only trace of the publication: no step line, and no group left empty around it.
    assert.equal(await count(".step"), 0);
    assert.equal(await count(".activity"), 0);
    // The card stands in the message, beside Pi's words and not inside them.
    const place = await inPage<{ inside: boolean; before: boolean }>(
        `return JSON.stringify({
            inside: document.querySelector(".reply .artifact-tile") !== null,
            before: (document.querySelector(".artifact-tile").compareDocumentPosition(document.querySelector(".reply")) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        })`,
    );

    assert.deepEqual(place, { inside: false, before: true });
});

test("the card opens the artifact in the viewer", real, async () => {
    await page.click({ selector: ".artifact-card" });
    await see(`document.querySelector(".viewer") !== null`, "the viewer");

    const title = await inPage<string>(
        `return JSON.stringify(document.querySelector(".viewer-title strong").textContent)`,
    );

    assert.equal(title, "Demo Page");
    // The page itself runs in the viewer's frame.
    await see(`document.querySelector(".viewer iframe") !== null`, "the frame");
});
