// Bare links in a message that show as the thing itself: a YouTube video as a player, an image as an image.
//
// A link alone in its paragraph, with its own address as its text, is a bare link. Anything written as `[text](url)`
// is somebody's words about a link, and stays a link. The card is drawn as markup, because `Markdown` draws replies
// from an HTML string and redraws them whenever the room changes: a listener bound to one card would be gone at the
// next word. So the tap is handled once, on the document, for every card.

/** Hosts whose bare links play here. Playback itself goes to the nocookie domain, and only after a tap. */
const VIDEO_HOSTS = new Set(["youtube.com", "youtube-nocookie.com", "youtu.be"]);

/** What counts as an image far away, as a file name at the end of the address (a query or fragment is allowed). */
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)(?:[?#]|$)/i;

/** The eleven characters a YouTube address's `v` names, if it names one at all. */
const VIDEO_ID = /^[\w-]{11}$/;

/** What a video's still is called where it is hosted, so the card needs no call to YouTube to know. */
const stillUrl = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

/**
 * The video a YouTube address names, as its eleven characters, or null. `watch?v=`, `youtu.be/`, `shorts/`, `live/`
 * and `embed/` all name one; any subdomain may carry it (`m.`, `music.`).
 */
export function videoId(href) {
    let url;

    try {
        url = new URL(href);
    } catch {
        return null;
    }

    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const bare = host.split(".").slice(-2).join(".");

    if (!VIDEO_HOSTS.has(host) && !VIDEO_HOSTS.has(bare)) {
        return null;
    }

    const parts = url.pathname.split("/").filter((part) => part !== "");
    const query = url.searchParams.get("v");
    const named = host === "youtu.be" ? parts[0] : undefined;
    const inPath = ["embed", "shorts", "live", "v"].includes(parts[0]) ? parts[1] : undefined;
    const id = named ?? query ?? inPath;

    return id !== undefined && VIDEO_ID.test(id) ? id : null;
}

/** Whether an address names an image far away, which the app's policy then lets that one host load. */
export function imageHref(href) {
    let url;

    try {
        url = new URL(href);
    } catch {
        return false;
    }

    return (
        url.protocol === "https:" && IMAGE_EXTENSION.test(`${url.pathname}${url.search}${url.hash}`)
    );
}

/** The card for one bare address, or null when the address is an ordinary link after all. */
function card(href) {
    const id = videoId(href);

    if (id !== null) {
        return videoCard(id, href);
    }

    if (imageHref(href)) {
        return imageCard(href);
    }

    return null;
}

/**
 * A video as its still with a play mark, and as the player once it is asked for. The frame is not made until then,
 * so nothing reaches YouTube while a message is only being read (or is still streaming).
 */
function videoCard(id, href) {
    // A `span`, not a `div`: `Markdown` hands its HTML to the browser to draw, and a block element inside a
    // paragraph would make the parser close it, leaving an empty paragraph behind the card.
    const frame = document.createElement("span");

    frame.className = "media-card media-video";
    frame.dataset.href = href;

    const button = document.createElement("button");

    button.type = "button";
    button.className = "media-play";
    button.dataset.video = id;
    button.title = "Play video";
    button.setAttribute("aria-label", `Play video: ${href}`);

    const still = document.createElement("img");

    // The same, for the still: 16:9 before anything is styled.
    still.width = 480;
    still.height = 360;
    still.src = stillUrl(id);
    still.alt = "";
    still.loading = "lazy";
    button.append(still);

    const mark = document.createElement("span");

    mark.className = "media-mark";
    mark.textContent = "▶";
    button.append(mark);

    const caption = document.createElement("span");

    caption.className = "media-caption";
    caption.textContent = href;
    button.append(caption);

    frame.append(button);

    return frame;
}

/**
 * An image as an image. A card the app's policy will not load, or an address that is not an image after all, becomes
 * the link it was: the same choice `sanitize` makes for an image in a reply.
 */
function imageCard(href) {
    const frame = document.createElement("span");

    frame.className = "media-card media-image";
    frame.dataset.href = href;

    const image = document.createElement("img");

    image.src = href;
    image.alt = "";
    image.loading = "lazy";
    // Sized in the markup as well as the stylesheet: an image with neither is its own size, whatever the CSS says.
    image.width = 480;
    image.height = 360;
    // Nothing but the picture is sent to its host: no referrer, so it learns no address, no port, and not that
    // the picture came from someone's own server. The app's policy decides which hosts may load at all.
    image.referrerPolicy = "no-referrer";
    frame.append(image);

    return frame;
}

/**
 * Whether these nodes are one bare link: nothing in them but the link, and the link's text its own address. Written
 * `[text](url)` has somebody's words in it, and a line with a link among others is part of a sentence; neither cards.
 */
function bareLink(nodes) {
    let anchor = null;

    for (const node of nodes) {
        if ((node.textContent ?? "").trim() === "") {
            // The spaces around it are nothing; a line of its own still counts.
            continue;
        }

        if (anchor !== null || node.nodeType !== Node.ELEMENT_NODE || !node.matches("a[href]")) {
            return null;
        }

        anchor = node;
    }

    if (anchor === null || anchor.textContent?.trim() !== anchor.getAttribute("href")?.trim()) {
        return null;
    }

    // The link itself, which is not always the first node of its line.
    return anchor;
}

/**
 * Every bare link alone in a line of rendered Markdown, as a card, in the holder it was sanitized into. A line is a
 * paragraph, or what a line break in one splits it into: Pi writes a link under what it says about it far more often
 * than it leaves it a paragraph. Links in a list, a quote, or a table stay links: a card there would break what the
 * line is for.
 */
export function mediaCards(holder) {
    for (const paragraph of [...holder.querySelectorAll(":scope > p")]) {
        const lines = [[]];

        for (const node of paragraph.childNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && node.matches("br")) {
                lines.push([]);
            } else {
                lines[lines.length - 1].push(node);
            }
        }

        for (const line of lines) {
            const anchor = bareLink(line);

            if (anchor === null) {
                continue;
            }

            const shown = card(anchor.getAttribute("href") ?? "");

            if (shown !== null) {
                anchor.replaceWith(shown);
            }
        }
    }

    return holder;
}

/** A card's play mark, in place of the player it asked for. A card already playing is left as it is. */
function play(button) {
    const card = button.closest(".media-card");

    if (card === null || card.querySelector("iframe") !== null) {
        return;
    }

    card.textContent = "";

    const player = document.createElement("iframe");

    // Sized in the markup as well as the stylesheet: a frame with neither is 300x150, whatever the CSS says.
    player.width = 640;
    player.height = 360;
    player.src = `https://www.youtube-nocookie.com/embed/${button.dataset.video}?autoplay=1&rel=0`;
    player.title = "Play video";
    player.allow = "accelerometer; autoplay; encrypted-media; picture-in-picture";
    player.allowFullScreen = true;
    player.loading = "lazy";
    card.append(player);
}

/**
 * An image that would not load, as the link it was: the same choice `sanitize` makes for an image in a reply. Handled
 * on the document, in the capture phase, because `error` does not bubble and the card's own elements are replaced
 * whenever the room is drawn again.
 */
function failed(image) {
    const card = image.closest(".media-card");

    if (card === null || card.dataset.fallback === "done") {
        return;
    }

    const href = card.dataset.href ?? image.src;
    const link = document.createElement("a");

    link.href = href;
    link.textContent = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    card.dataset.fallback = "done";
    card.className = "media-card media-file";
    card.textContent = "";
    card.append(link);
}

// One listener for every card, now and after the next redraw of the reply that holds it.
document.addEventListener(
    "error",
    (event) => {
        if (event.target instanceof HTMLImageElement) {
            failed(event.target);
        }
    },
    true,
);

// One listener for every card, now and after the next redraw of the reply that holds it.
document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest(".media-play") : null;

    if (button === null) {
        return;
    }

    // A card is not the message under it: choosing the message in the people panel would be a surprise.
    event.preventDefault();
    event.stopPropagation();
    play(button);
});

// ─── How a card looks ────────────────────────────────────────────────────────────────────────
// In this module rather than `style.css`, as `rich.js` and `theme.js` do theirs: a card is one thing with one
// file, and the app's own stylesheet stays as upstream keeps it. A tab that has not loaded this file yet shows
// a card as the browser would draw it, which is why the still and the frame are sized in the markup too.

const STYLE = `
.media-card {
    display: block;
    margin: 0.45rem 0;
    max-width: min(100%, 34rem);
    border: 1px solid var(--hair);
    border-radius: var(--r-card);
    overflow: hidden;
    background: var(--bg);
}

.media-card img,
.media-card iframe {
    display: block;
    width: 100%;
    height: auto;
    aspect-ratio: 16 / 9;
    object-fit: cover;
    border: 0;
}

.media-play {
    display: block;
    position: relative;
    width: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    cursor: pointer;
}

.media-mark {
    position: absolute;
    inset: 0;
    margin: auto;
    width: 3.2rem;
    height: 3.2rem;
    display: grid;
    place-items: center;
    padding-left: 0.2rem;
    border-radius: 50%;
    background: #000000b8;
    color: #fff;
    font-size: 1.2rem;
    line-height: 1;
}

.media-caption {
    display: block;
    padding: 0.35rem 0.6rem;
    border-top: 1px solid var(--hair);
    font-size: 0.78rem;
    color: var(--muted);
    opacity: 0.75;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.media-image img {
    aspect-ratio: auto;
    object-fit: contain;
    max-height: 70vh;
    background: var(--bg);
}

.media-file {
    padding: 0.5rem 0.7rem;
    overflow-wrap: anywhere;
    font-size: 0.85rem;
}
`;

if (!document.querySelector("style[data-media-cards]")) {
    const style = document.createElement("style");

    style.dataset.mediaCards = "";
    style.textContent = STYLE;
    document.head.append(style);
}
