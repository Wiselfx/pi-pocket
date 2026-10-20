/**
 * Deleting a session for good. Everything of it goes: its messages, its work and its files from the durable store,
 * the app's own records of it (the list, the hooks and watches that message it, the spend it made, the follows that
 * wait for its runs), and what this process keeps of it in memory. Nothing of another session is touched.
 *
 * The store's rows go in one transaction, so they go together or not at all. The app's own records go first, and are
 * put back if that transaction fails. The session's live work and follows are stopped before either, and a failure
 * does not bring them back: what can be restored is the app's records and the session's rows, not the run.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import {
    FollowsDoc,
    type FollowItem,
    HooksDoc,
    type Hook,
    RepoWatchesDoc,
    type RepoWatch,
    SessionsDoc,
    type SessionMeta,
    SpendDoc,
} from "./docs.ts";
import { describe, HttpError } from "./errors.ts";

const context = BACKGROUND_CONTEXT;

/** How long the session's work may take to settle before the delete gives up on it. */
const STOP_LIMIT_MS = 15_000;

/** What the store's rows are called, one statement each: the order they go in. */
const ERASE = {
    taskRevisions: `DELETE FROM document_revisions WHERE document_id IN (
        SELECT id FROM documents WHERE scope_kind = 'task' AND owner_id IN (
            SELECT id FROM tasks WHERE conversation_id = ?))`,
    taskDocuments: `DELETE FROM documents WHERE scope_kind = 'task' AND owner_id IN (
        SELECT id FROM tasks WHERE conversation_id = ?)`,
    conversationRevisions: `DELETE FROM document_revisions WHERE document_id IN (
        SELECT id FROM documents WHERE scope_kind = 'conversation' AND owner_id = ?)`,
    conversationDocuments: `DELETE FROM documents WHERE scope_kind = 'conversation' AND owner_id = ?`,
    entries: "DELETE FROM entries WHERE conversation_id = ?",
    submissions: "DELETE FROM submissions WHERE conversation_id = ?",
    tasks: "DELETE FROM tasks WHERE conversation_id = ?",
    conversation: "DELETE FROM conversations WHERE id = ?",
    taskRevisionsOf:
        "DELETE FROM document_revisions WHERE document_id IN (SELECT id FROM documents WHERE owner_id = ?)",
    taskDocumentsOf: "DELETE FROM documents WHERE owner_id = ?",
    task: "DELETE FROM tasks WHERE id = ?",
};

/**
 * Delete a session, and the subagents under it: their messages, their work, their files, and every record the app
 * keeps of them.
 */
export async function deleteSession(app: PocketApp, id: ConversationId, user: User): Promise<void> {
    app.requireSee(user, id);
    app.requireSteer(user);

    // A delete cannot be undone, and it takes everyone's copy of the session with it: the owner's call.
    if (user.role !== "owner") {
        throw new HttpError(403, "Only the owner can delete a session.");
    }

    const meta = app.sessionMeta(id);

    if (meta === undefined) {
        // A session that is already gone: there is nothing left to delete.
        return;
    }

    if (meta.pip !== undefined) {
        throw new HttpError(404, "PiP is not a session");
    }

    // A fork's conversation still points at its parent's entries in the durable store: taking the parent's rows would
    // leave the fork unable to read the history it inherited. Its pointer in the list is no substitute, so refuse.
    const forks = Object.values(app.sessionCatalogue()).filter(
        (each) => each.forkedFrom?.id === Number(id),
    );

    if (forks.length > 0) {
        throw new HttpError(
            409,
            "That session has forks, which inherit its history. Delete them first.",
        );
    }

    // The session and the subagents under it: they are its own.
    const conversations = app.conversationsOf(id);

    // There is no per-session deletion lock: a message that arrives after stopWork settles could start one more task
    // before the rows go. Deleting is the owner's own action, and the window is short, so it is left as it is.

    // Nothing of it may write after its rows are gone.
    await stopWork(app, conversations);

    // The room watches it: nothing watches a session that is going.
    app.closeRooms(conversations);

    // The app's own records of it, and how to put them back.
    const undo = await removeRecords(app, id, conversations);

    try {
        eraseRows(app, conversations, undo.followTasks);
    } catch (error) {
        await undo.restore().catch((restoreError: unknown) => {
            app.log(`the session could not be put back: ${describe(restoreError)}`);
        });

        throw new HttpError(500, `The session could not be deleted: ${describe(error)}`);
    }

    // The files it left: the uploads of it and of its subagents. The rows are gone now, so a file that will not go is
    // reported and left, not a delete that fails: the session is already gone.
    for (const each of conversations) {
        try {
            await rm(join(app.dataDir, "uploads", String(each)), { recursive: true, force: true });
        } catch (error) {
            app.ownerNotice(
                "warning",
                `A deleted session's files could not be removed: ${describe(error)}`,
            );
        }
    }

    // What this process keeps of it.
    app.forgetSession(id, conversations);
}

/**
 * Stop the session's work and wait for it to settle: a task that ran on would write to rows that are gone.
 */
async function stopWork(app: PocketApp, conversations: readonly ConversationId[]): Promise<void> {
    for (const each of conversations) {
        const conversation = await app.harness.conversation(each, context);

        await conversation?.abort(context).catch(() => undefined);
    }

    const until = Date.now() + STOP_LIMIT_MS;

    for (;;) {
        const { tasks } = await app.harness.inspect(context);
        const live = tasks.filter((task) => conversations.includes(task.record.conversationId));

        if (live.length === 0) {
            return;
        }

        if (Date.now() > until) {
            throw new HttpError(409, "The session is still working. Stop it, and try again.");
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

/** The app's own records of the session, and how to put them back. */
type Undone = {
    /** The follow tasks that waited for its runs: they go with it. */
    followTasks: number[];
    /** Put back what was taken, if the store's rows do not go. */
    restore: () => Promise<void>;
};

/** What the app kept of the session, as it was before the delete took it away. */
type Kept = {
    sessions: Record<string, SessionMeta>;
    hooks: Record<string, Hook>;
    watches: Record<string, RepoWatch>;
    counted: Record<string, number>;
    follows: Record<string, FollowItem>;
    pip: ConversationId | undefined;
};

/**
 * The app's own records of the session: its place in the list, the hooks and watches that message it, the spend it
 * made, and the follows that wait for its runs. What was taken is kept as it was, so it can be put back.
 */
async function removeRecords(
    app: PocketApp,
    id: ConversationId,
    conversations: readonly ConversationId[],
): Promise<Undone> {
    const pip = app.pip.idOf(app.config.users.find((each) => each.role === "owner")?.id ?? "");

    // What the app kept, read as plain values: a draft's own objects cannot be read once its commit has settled.
    const kept: Kept = {
        sessions: { ...((await app.harness.snapshot(SessionsDoc, context))?.items ?? {}) },
        hooks: { ...((await app.harness.snapshot(HooksDoc, context))?.items ?? {}) },
        watches: { ...((await app.harness.snapshot(RepoWatchesDoc, context))?.items ?? {}) },
        counted: { ...((await app.harness.snapshot(SpendDoc, context))?.counted ?? {}) },
        follows: {
            ...((pip === undefined
                ? undefined
                : (await app.harness.snapshot(FollowsDoc, pip, context))?.items) ?? {}),
        },
        pip,
    };

    await app.harness.commit(async (tx) => {
        const sessions = (await tx.doc(SessionsDoc)).items;

        delete sessions[String(id)];

        // A fork or a linked session that names this one names nothing now.
        for (const meta of Object.values(sessions)) {
            if (meta.forkedFrom?.id === Number(id) || meta.linkedFrom?.id === Number(id)) {
                delete meta.forkedFrom;
                delete meta.linkedFrom;
            }
        }

        const hooks = (await tx.doc(HooksDoc)).items;

        for (const [each, hook] of Object.entries(hooks)) {
            if (hook.target === Number(id)) {
                delete hooks[each];
            }
        }

        const watches = (await tx.doc(RepoWatchesDoc)).items;

        for (const [each, watch] of Object.entries(watches)) {
            if (watch.target === Number(id)) {
                delete watches[each];
            }
        }

        const spend = await tx.doc(SpendDoc);

        for (const each of conversations) {
            delete spend.counted[String(each)];
        }

        // The follows that wait for the session's runs: PiP's list of them.
        if (pip !== undefined) {
            const follows = (await tx.doc(FollowsDoc, pip)).items;

            for (const [key, follow] of Object.entries(follows)) {
                if (follow.session === Number(id)) {
                    delete follows[key];
                }
            }
        }
    }, context);

    const followTasks = Object.values(kept.follows)
        .filter((follow) => follow.session === Number(id))
        .map((follow) => follow.taskId);

    // A follow that waits for a run that will never come would report a session that is gone: stop it, and wait for
    // it to settle: a task whose rows are taken while it still runs leaves the harness writing to nothing.
    for (const taskId of followTasks) {
        await app.harness.abortTask(taskId as never, context).catch(() => undefined);
        await app.harness.waitForTask(taskId as never, context).catch(() => undefined);
    }

    return {
        followTasks,
        restore: async () => {
            await app.harness.commit(async (tx) => {
                const sessions = (await tx.doc(SessionsDoc)).items;
                const session = kept.sessions[String(id)];

                if (session !== undefined) {
                    sessions[String(id)] = session;
                }

                // A fork or a linked session that named this one names it again.
                for (const [other, meta] of Object.entries(kept.sessions)) {
                    const live = sessions[other];

                    if (live === undefined || other === String(id)) {
                        continue;
                    }

                    if (meta.forkedFrom !== undefined) {
                        live.forkedFrom = meta.forkedFrom;
                    }

                    if (meta.linkedFrom !== undefined) {
                        live.linkedFrom = meta.linkedFrom;
                    }
                }

                const hooks = (await tx.doc(HooksDoc)).items;

                for (const [each, hook] of Object.entries(kept.hooks)) {
                    if (hook.target === Number(id)) {
                        hooks[each] = hook;
                    }
                }

                const watches = (await tx.doc(RepoWatchesDoc)).items;

                for (const [each, watch] of Object.entries(kept.watches)) {
                    if (watch.target === Number(id)) {
                        watches[each] = watch;
                    }
                }

                const spend = await tx.doc(SpendDoc);

                for (const each of conversations) {
                    const cost = kept.counted[String(each)];

                    if (cost !== undefined) {
                        spend.counted[String(each)] = cost;
                    }
                }

                if (kept.pip !== undefined) {
                    const follows = (await tx.doc(FollowsDoc, kept.pip)).items;

                    for (const [key, follow] of Object.entries(kept.follows)) {
                        if (follow.session === Number(id)) {
                            follows[key] = follow;
                        }
                    }
                }
            }, context);
        },
    };
}

/**
 * The session's rows in the store, gone: its messages, its tasks and submissions, its documents, and the
 * conversation itself, with the subagents under it. One transaction: they go together or stay.
 */
function eraseRows(
    app: PocketApp,
    conversations: readonly ConversationId[],
    followTasks: readonly number[],
): void {
    const database = new DatabaseSync(join(app.dataDir, "pocket.sqlite"));

    try {
        database.exec("BEGIN IMMEDIATE");

        for (const id of conversations) {
            database.prepare(ERASE.taskRevisions).run(Number(id));
            database.prepare(ERASE.taskDocuments).run(Number(id));
            database.prepare(ERASE.conversationRevisions).run(Number(id));
            database.prepare(ERASE.conversationDocuments).run(Number(id));
            database.prepare(ERASE.entries).run(Number(id));
            database.prepare(ERASE.submissions).run(Number(id));
            database.prepare(ERASE.tasks).run(Number(id));
            database.prepare(ERASE.conversation).run(Number(id));
        }

        // The follow tasks that waited for the session's runs: PiP's records of them, gone with the session.
        for (const taskId of followTasks) {
            database.prepare(ERASE.taskRevisionsOf).run(taskId);
            database.prepare(ERASE.taskDocumentsOf).run(taskId);
            database.prepare(ERASE.task).run(taskId);
        }

        database.exec("COMMIT");
    } catch (error) {
        database.exec("ROLLBACK");

        throw error;
    } finally {
        database.close();
    }
}
