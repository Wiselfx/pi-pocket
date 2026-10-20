// The delete entry in a session's own menu: under Archive, in the menu's own style, and it asks before it takes
// anything away.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const sheet = readFileSync(join(process.cwd(), "web", "sheets", "session.js"), "utf8");

test("the session menu offers delete under archive, and asks first", () => {
    const order = ['"Pin to the top"', '"Mark unread"', '"Archive"', '"Delete"', '"Select"'];
    const at = order.map((label) => sheet.indexOf(label));

    assert.ok(
        at.every((each) => each >= 0),
        "the menu has every entry",
    );
    assert.deepEqual(
        at,
        [...at].sort((a, b) => a - b),
        "delete sits under archive",
    );
});

test("the delete entry is one of the menu's own, and it asks before it removes anything", () => {
    const entry = sheet.slice(sheet.indexOf('"Delete"'));

    assert.match(entry, /item\(/, "it is a menu entry like the others");
    assert.match(entry.slice(0, 600), /confirm\(/, "it asks first");
});
