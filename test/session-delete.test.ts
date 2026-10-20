// Deleting a session: its messages, its work, its files, and every record of it go; nothing else does.
import {
    type App,
    cleanUp,
    context,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { FollowsDoc } from "../src/server/docs.ts";

const model = scriptedModel((request) => {
    const messages = (request as { messages: { role: string; content: string }[] }).messages;
    const text = messages.at(-1)?.content ?? "";

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
});

let app: App;

before(async () => {
    app = await openApp(model, join(root, "delete-data"));
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** What the store still holds of a conversation: its rows, counted. */
function rows(id: ConversationId): { entries: number; tasks: number; submissions: number } {
    const database = new DatabaseSync(join(app.dataDir, "pocket.sqlite"));

    try {
        const count = (sql: string) =>
            (database.prepare(sql).get(Number(id)) as { n: number } | undefined)?.n ?? 0;

        return {
            entries: count("SELECT count(*) AS n FROM entries WHERE conversation_id = ?"),
            tasks: count("SELECT count(*) AS n FROM tasks WHERE conversation_id = ?"),
            submissions: count("SELECT count(*) AS n FROM submissions WHERE conversation_id = ?"),
        };
    } finally {
        database.close();
    }
}

test("a deleted session is gone: its messages, its work, and its files", async () => {
    const session = await newSession(app);

    await say(app, session, "hello");

    assert.ok(rows(session).entries > 0, "the session has messages");
    assert.ok(app.sessionMeta(session) !== undefined, "the session is listed");

    // A file it left: an upload of its own.
    const uploads = app.workspace.uploadDirectory(session);

    mkdirSync(uploads, { recursive: true });
    writeFileSync(join(uploads, "note.txt"), "hello");

    await app.deleteSession(session, owner(app));

    assert.equal(app.sessionMeta(session), undefined, "the session is not listed");
    assert.equal(await app.harness.conversation(session, context), undefined, "it is gone");
    assert.deepEqual(rows(session), { entries: 0, tasks: 0, submissions: 0 }, "its rows are gone");
    assert.equal(existsSync(uploads), false, "its files are gone");
    assert.ok(!app.sessions().some((each) => each.id === Number(session)), "it is out of the list");
});

test("another session keeps everything when one is deleted", async () => {
    const gone = await newSession(app);
    const kept = await newSession(app);

    await say(app, kept, "still here");
    await say(app, gone, "not for long");

    const before = rows(kept);

    assert.ok(before.entries > 0, "the other session has messages");

    await app.deleteSession(gone, owner(app));

    assert.deepEqual(rows(kept), before, "the other session's rows are untouched");
    assert.ok(app.sessionMeta(kept) !== undefined, "the other session is still listed");
    assert.ok(
        (await app.harness.conversation(kept, context)) !== undefined,
        "the other session is still there",
    );
});

test("deleting a session with a fork is refused, so the fork keeps its history", async () => {
    const session = await newSession(app);

    await say(app, session, "inherited words");

    const page = await (await app.harness.conversation(session, context))!.entries(
        {},
        32,
        undefined,
        context,
    );
    const answer = page.items.find((entry) => entry.kind === "pi.assistant");

    assert.ok(answer !== undefined, "the session has an answer to fork from");

    const { id: fork } = await app.commands.fork(session, owner(app), {
        entryId: Number(answer.id),
    });

    await assert.rejects(app.deleteSession(session, owner(app)), /forks/i);

    assert.ok(app.sessionMeta(session) !== undefined, "the parent is still listed");
    assert.ok(rows(session).entries > 0, "the parent's rows are still there");
    assert.match(
        (await modelTexts(app, fork)).join("\n"),
        /inherited words/,
        "the fork reads its inherited history",
    );
});

test("deleting a session twice does not throw", async () => {
    const session = await newSession(app);

    await say(app, session, "hello");
    await app.deleteSession(session, owner(app));

    // The second delete has nothing to do: it says so by doing nothing.
    await app.deleteSession(session, owner(app));

    assert.equal(app.sessionMeta(session), undefined, "the session is still gone");
});

test("a follow of a deleted session goes with it", async () => {
    const pip = await app.pip.ensure(owner(app));
    const session = await newSession(app);

    await app.pip.follow(pip, Number(session), "req-1", "follow-key");

    const follows = (await app.harness.snapshot(FollowsDoc, pip, context))?.items ?? {};

    assert.equal(Object.keys(follows).length, 1, "the follow is registered");

    await app.deleteSession(session, owner(app));

    const left = (await app.harness.snapshot(FollowsDoc, pip, context))?.items ?? {};

    assert.deepEqual(Object.keys(left), [], "the follow is gone");
});

test("PiP deletes a session its person looked at", async () => {
    const pip = await app.pip.ensure(owner(app));
    const session = await newSession(app);

    await say(app, session, "hello");
    await app.pip.read(pip, Number(session));

    await app.pip.delete(pip, Number(session));

    assert.equal(app.sessionMeta(session), undefined, "the session is gone");
    assert.deepEqual(rows(session), { entries: 0, tasks: 0, submissions: 0 }, "its rows are gone");
});

test("only the owner may delete a session", async () => {
    const guest = app.config.addUser("Guest", "guest").user;
    const session = await newSession(app);

    await say(app, session, "hello");

    await assert.rejects(app.deleteSession(session, guest), /owner/i);
    assert.ok(app.sessionMeta(session) !== undefined, "the session is still there");
});
