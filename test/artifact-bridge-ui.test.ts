// What an artifact's page may ask of the app (#88, #89), in a real Chromium: its saved state, and a follow-up in the
// message box, only after the person taps the page, marked as the artifact's, unsent; nothing from a frame inside it, or
// once it navigates elsewhere; one follow-up every 2 seconds; and a notice, not a message, for a viewer.
import {
    type App,
    cleanUp,
    context,
    openApp,
    owner,
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
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { ArtifactStateDoc } from "../src/server/docs.ts";
import createArtifacts from "../src/server/extensions/artifacts.ts";
import type { PocketHost } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/**
 * Counts its opens in its saved state; offers a follow-up at once (refused: nobody tapped it) and again when tapped
 * anywhere; and has a frame of its own inside that tries to save state for it (refused: not the artifact's page).
 */
const CALC = `<!doctype html><html><body style="margin:0">
<button id="go" style="position:fixed;inset:0;width:100%;height:100%">Ask</button>
<script>
let count = 0;
const ask = (message) => new Promise((resolve) => {
    const requestId = String(Math.random()).slice(2);
    addEventListener("message", function hear(event) {
        if (event.source === parent && event.data && event.data.requestId === requestId) {
            removeEventListener("message", hear);
            resolve(event.data);
        }
    });
    parent.postMessage({ ...message, requestId }, "*");
});
(async () => {
    const got = await ask({ type: "pocket-state-get", schema: "v1" });
    count = ((got.state && got.state.count) || 0) + 1;
    await ask({ type: "pocket-state-set", schema: "v1", state: { count } });
    parent.postMessage({ type: "pocket-follow-up", text: "at load" }, "*");
    const inner = document.createElement("iframe");
    inner.srcdoc = "<script>parent.parent.postMessage({ type: 'pocket-state-set', requestId: 'inner', schema: 'v1', state: { inner: true } }, '*')<\\/script>";
    document.body.append(inner);
})();
document.getElementById("go").onclick = () =>
    parent.postMessage({ type: "pocket-follow-up", text: "Tell me about option " + count, selection: { option: count } }, "*");
</script></body></html>`;

/** Goes elsewhere at once; the page there tries to save state, and to offer a follow-up when tapped. */
const AWAY = `<!doctype html><html><body><script>
location.href = "data:text/html," + encodeURIComponent(
    '<body style="margin:0"><button style="position:fixed;inset:0;width:100%;height:100%" onclick="parent.postMessage({ type: \\'pocket-follow-up\\', text: \\'from elsewhere\\' }, \\'*\\')">x</button>' +
    '<script>parent.postMessage({ type: "pocket-state-set", requestId: "away", state: { away: true } }, "*")<' + '/script></body>'
);
</script></body></html>`;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;
let calls = 0;
/** What a busy machine (the whole suite at once) may take to open a viewer and load its page. */
const SLOW = 30_000;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const boxText = () =>
    inPage<string>(
        `return JSON.stringify(document.querySelector(".composer textarea")?.value ?? "")`,
    );

const setBox = (text: string) =>
    inPage(`
        const box = document.querySelector(".composer textarea");
        box.value = ${JSON.stringify(text)};
        box.dispatchEvent(new Event("input", { bubbles: true }));
        return "null";
    `);

const notices = () =>
    inPage<string[]>(
        `const { store } = await import("/store.js"); return JSON.stringify(store.state.notices.map((each) => each.message))`,
    );

/** Open an artifact's viewer as the app does, once the one before has gone (a sheet stays for its fade). */
async function openViewer(id: string) {
    await until(
        async () =>
            !(await inPage<boolean>(
                `return JSON.stringify(Boolean(document.querySelector(".viewer")))`,
            )),
        "no viewer open",
        SLOW,
    );
    await inPage(`
        const { openSheet } = await import("/store.js");
        openSheet({ type: "viewer", id: ${JSON.stringify(id)} });
        return "null";
    `);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(Boolean(document.querySelector(".viewer iframe")))`,
            ),
        "the viewer's frame",
        SLOW,
    );
}

const closeSheet = () =>
    inPage(`const { closeSheet } = await import("/store.js"); closeSheet(); return "null";`);

/** Tap the middle of a frame, as a person does: the frame takes the focus, and its page the click. */
async function tapFrame(selector: string) {
    const box = await inPage<{ x: number; y: number }>(`
        const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    `);

    await page.click({ x: Math.round(box.x), y: Math.round(box.y) });
}

const savedFor = async (artifact: string) =>
    (await app.harness.snapshot(ArtifactStateDoc, session, context))?.items[artifact]?.[
        owner(app).id
    ]?.value;

async function publish(id: string, content: string) {
    await createArtifacts({} as PocketHost).tools![0]!.execute(
        { id, title: id === "calc" ? "Calculator" : "Away", content } as never,
        {
            conversationId: session,
            taskId: 9000 + (calls += 1),
            callId: "publish",
            agent: async () => ({ cwd: work }),
            snapshot: app.harness.snapshot.bind(app.harness),
            commit: app.harness.commit.bind(app.harness),
        } as never,
        context,
    );
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    ({ id: session } = await app.commands.createSession(owner(app), { cwd: work }));
    await publish("calc", CALC);
    await publish("away", AWAY);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "artifact-bridge-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(Boolean(document.querySelector(".composer textarea")))`,
            ),
        "the message box",
        SLOW,
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "a tap's follow-up joins the draft, the artifact named first; nothing before a tap, and nothing is sent",
    real,
    async () => {
        await setBox("my draft");
        await openViewer("calc");
        await until(
            async () => (await savedFor("calc")) !== undefined,
            "the page's saved state",
            SLOW,
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(await boxText(), "my draft", "the follow-up at load, with no tap, is refused");
        assert.deepEqual(await savedFor("calc"), { count: 1 }, "the frame inside it saved nothing");

        await tapFrame(".viewer iframe");
        await until(
            async () => (await boxText()).includes("option 1"),
            "the follow-up in the box",
            SLOW,
        );
        assert.equal(
            await boxText(),
            'my draft\n\nFrom the artifact “Calculator”:\nTell me about option 1\n\n```json\n{\n  "option": 1\n}\n```',
        );
        assert.equal(
            (await app.transcripts.allEntries(session, false)).length,
            0,
            "the page made Pi do nothing",
        );
    },
);

test("its saved state comes back when it opens again", real, async () => {
    await closeSheet();
    await setBox("");
    await openViewer("calc");
    await until(
        async () =>
            (await savedFor("calc")) !== undefined &&
            ((await savedFor("calc")) as { count: number }).count === 2,
        "the count saved again",
        SLOW,
    );
    await tapFrame(".viewer iframe");
    await until(
        async () => (await boxText()).includes("option 2"),
        "the second open's follow-up",
        SLOW,
    );
    assert.match(
        await boxText(),
        /^From the artifact “Calculator”:/,
        "never a command: the box starts with what it is from",
    );
});

test("a frame that went elsewhere is not heard", real, async () => {
    await closeSheet();
    await setBox("");
    await openViewer("away");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(await savedFor("away"), undefined, "the page elsewhere saved nothing");
    await tapFrame(".viewer iframe");
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(await boxText(), "", "nor offered a follow-up");
    await closeSheet();
});

test("HTML run from a reply: one follow-up every 2 seconds", real, async () => {
    const button = `<button id=b style="position:fixed;inset:0;width:100%;height:100%" onclick="parent.postMessage({type:'pocket-follow-up',text:'ran'},'*')">x</button>`;

    await say(
        app,
        session,
        `here:\n\`\`\`html\n<!doctype html><html><body style="margin:0">${button}</body></html>\n\`\`\``,
    );
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify([...document.querySelectorAll(".rich-run")].length > 0)`,
            ),
        "the reply's Run",
        SLOW,
    );
    await page.click({ selector: ".rich-run" });
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(Boolean(document.querySelector("iframe.run-frame")))`,
            ),
        "the running frame",
        SLOW,
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    await setBox("");
    await tapFrame("iframe.run-frame");
    await tapFrame("iframe.run-frame");
    await until(async () => (await boxText()).includes("ran"), "the first follow-up", SLOW);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
        await boxText(),
        "From the page in Pi's reply:\nran",
        "the second, too soon, is refused",
    );
});

test("a viewer gets a notice, not a message", real, async () => {
    const viewer = app.config.addUser("Vee", "viewer");
    // A browser of their own: this one is signed in as the owner.
    const theirs = new Browsers({
        dataDir: mkdtempSync(join(root, "artifact-bridge-viewer-")),
        load: async () => undefined,
        save: () => {},
    });

    page = await theirs.open(1);
    await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });

    try {
        await page.navigate(`${base}/login?token=${encodeURIComponent(viewer.token)}`);
        await page.navigate(`${base}/s/${session}`);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(Boolean(document.querySelector(".transcript")))`,
                ),
            "the session, as a viewer",
            SLOW,
        );
        await openViewer("calc");
        await new Promise((resolve) => setTimeout(resolve, 800));
        await tapFrame(".viewer iframe");
        await until(
            async () => (await notices()).some((each) => each.includes("you can only view here")),
            "the notice",
            SLOW,
        );
        assert.ok(
            await inPage<boolean>(
                `return JSON.stringify(Boolean(document.querySelector(".viewer")))`,
            ),
            "the viewer stays open",
        );
    } finally {
        await theirs.closeAll({ final: true });
        app.config.removeUser(viewer.user.id);
    }
});
