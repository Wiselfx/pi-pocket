// An artifact Pi published, as a card in the message: its name, and a tap that opens it.
//
// The card is drawn here, and not in the transcript, so that the transcript only says what a card is and where it
// comes from. The styles live in this module too, as `media-cards.js` and `rich.js` keep theirs: a card is one thing
// with one file, and the app's own stylesheet stays as upstream keeps it.

import { openSheet, store } from "./store.js";
import { html, Icon, Spinner } from "./ui.js";

/**
 * The artifact a call published, as the app knows it now: its kind, and its version. The call's own result says
 * what it published; the app's list says what that is.
 */
function published(details) {
    const { view } = store.state;
    const artifact = view.artifacts?.find((each) => each.id === details?.id);

    return {
        id: details?.id,
        version: details?.version,
        title: details?.title ?? artifact?.title ?? details?.id ?? "Artifact",
        type: artifact?.type,
    };
}

/**
 * The card of an artifact: what it is called, and a tap that opens it in the viewer. A call that is still publishing
 * shows its name and a spinner; one that failed says what went wrong.
 */
export function ArtifactCard({ call, result }) {
    const { view } = store.state;
    const args = call.args ?? {};
    const details = result?.details;
    const artifact = published(details);
    const title = artifact.title === "Artifact" ? (args.title ?? artifact.title) : artifact.title;
    const failed = result?.isError === true;
    const working = result === undefined;
    const src =
        details?.id === undefined
            ? null
            : `/a/${view.conversation?.id ?? ""}/${encodeURIComponent(details.id)}/${details.version}`;
    // What the tap will do, for a reader who cannot see the card: the name, the kind, and the version.
    const hint = [
        title,
        artifact.type,
        artifact.version === undefined ? "" : `version ${artifact.version}`,
    ]
        .filter(Boolean)
        .join(" · ");

    return html`<div class=${`artifact-tile ${failed ? "failed" : ""} ${working ? "working" : ""}`}>
        <button
            class="artifact-card"
            type="button"
            disabled=${failed || details?.id === undefined}
            title=${details?.id === undefined ? undefined : `Open ${hint}`}
            onClick=${() => openSheet({ type: "viewer", id: details.id, version: details.version })}
        >
            <span class="artifact-card-cover" aria-hidden="true">
                ${
                    artifact.type === "svg" && src
                        ? html`<img src=${src} alt="" loading="lazy" decoding="async" />`
                        : html`<${Icon} name="shapes" size=${23.5} stroke=${1.63} class="artifact-card-icon" />`
                }
            </span>
            <span class="artifact-card-info">
                <span class="artifact-card-name">${title}</span>
                <span class="artifact-card-kind">
                    ${
                        failed
                            ? html`<span class="err">${result?.text ?? "It could not be published."}</span>`
                            : working
                              ? html`<${Spinner} label="Publishing" hidden=${true} /> publishing…`
                              : "Artifact"
                    }
                </span>
            </span>
        </button>
    </div>`;
}

// ─── How a card looks ────────────────────────────────────────────────────────────────────────
// In this module rather than `style.css`, as `media-cards.js` and `rich.js` do theirs.

const STYLE = `
/* The card's place in the message: a little room on either side, and never wider than a column. */
.artifact-tile {
    margin: calc(8px * var(--space-y)) 14px;
    max-width: 34rem;
}

/*
 * The app's own stylesheet has a rule for ".artifact-card" (the Artifacts sheet's cards), so these rules are scoped
 * under ".artifact-tile" and say the layout in full: they must outrank that one.
 */
.artifact-tile .artifact-card {
    position: relative;
    box-sizing: border-box;
    display: flex;
    flex-direction: row;
    flex-wrap: nowrap;
    justify-content: flex-start;
    align-items: stretch;
    align-content: stretch;
    gap: 20px;
    width: 100%;
    height: auto;
    max-height: none;
    min-height: 70px;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 14px;
    background: #17161c;
    color: inherit;
    font: inherit;
    text-align: left;
    overflow: hidden;
    cursor: pointer;
    appearance: none;
    -webkit-appearance: none;
    -webkit-tap-highlight-color: transparent;
    -webkit-font-smoothing: antialiased;
}

.artifact-tile .artifact-card:disabled {
    cursor: default;
}

/* The hairline, drawn on top so that it also crosses the cover. */
.artifact-tile .artifact-card::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    box-shadow: inset 0 0 0 0.33px rgba(255, 255, 255, 0.2);
}

@media (max-resolution: 1.99dppx) {
    .artifact-tile .artifact-card::after {
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
    }
}

/* The cover: a deep bar that goes down to the card's floor. The card clips it. */
.artifact-tile .artifact-card-cover {
    flex: none;
    align-self: stretch;
    display: grid;
    place-items: center;
    width: 57px;
    height: auto;
    min-height: 0;
    margin: 16px 0 0 19px;
    border-radius: 10px 10px 0 0;
    background: linear-gradient(to bottom, #2d2851 0%, #1a1742 78%, #1a1742 100%);
    box-shadow: inset 0 0 0 0.67px rgba(190, 180, 255, 0.1);
    color: #a299e1;
    overflow: hidden;
}

.artifact-tile .artifact-card-icon {
    display: block;
    width: 23.5px;
    height: 23.5px;
}

.artifact-tile .artifact-card-cover img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #fff;
}

.artifact-tile .artifact-card-info {
    flex: 1;
    min-width: 0;
    align-self: center;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 14px 22px 14px 0;
    line-height: 1.3;
}

.artifact-tile .artifact-card-name {
    color: #f9f9fb;
    font-size: 16px;
    font-weight: 450;
    letter-spacing: -0.015em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.artifact-tile .artifact-card-kind {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #8f8f91;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.artifact-tile.failed .artifact-card-name {
    color: var(--err);
}

/* Still publishing: the name is not yet a thing to open. */
.artifact-tile.working .artifact-card-name {
    color: var(--muted);
}
`;

if (!document.querySelector("style[data-artifact-cards]")) {
    const style = document.createElement("style");

    style.dataset.artifactCards = "";
    style.textContent = STYLE;
    document.head.append(style);
}
