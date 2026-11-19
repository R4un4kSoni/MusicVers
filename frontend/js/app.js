
// ==========================================
// NEONWAVE - FRONTEND
// ==========================================

// ==========================================
// NEONWAVE - Playlist presets
// ==========================================

const PLAYLIST_GRADIENTS = [
    "linear-gradient(135deg, #141e30 0%, #243b55 50%, #4b6cb7 100%)",
    "linear-gradient(135deg, #42275a 0%, #734b6d 50%, #c471ed 100%)",
    "linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)",
    "linear-gradient(135deg, #134e5e 0%, #2a9d8f 55%, #71b280 100%)",
    "linear-gradient(135deg, #360033 0%, #6a0572 50%, #c94b4b 100%)",
    "linear-gradient(135deg, #232526 0%, #414345 50%, #6b7280 100%)",
    "linear-gradient(135deg, #1d4350 0%, #a43931 55%, #e76f51 100%)",
    "linear-gradient(135deg, #20002c 0%, #5b247a 50%, #cbb4d4 100%)",
    "linear-gradient(135deg, #005c97 0%, #363795 55%, #6dd5ed 100%)",
    "linear-gradient(135deg, #3a1c71 0%, #d76d77 55%, #ffaf7b 100%)",
    "linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #928dab 100%)",
    "linear-gradient(135deg, #4b134f 0%, #8e2de2 50%, #c94b4b 100%)",
    "linear-gradient(135deg, #16222a 0%, #3a6073 55%, #56ccf2 100%)",
    "linear-gradient(135deg, #3e5151 0%, #decba4 55%, #f5d6a6 100%)",
    "linear-gradient(135deg, #41295a 0%, #8e44ad 50%, #e056fd 100%)",
    "linear-gradient(135deg, #1a2a6c 0%, #b21f1f 55%, #fdbb2d 100%)",
    "linear-gradient(135deg, #283048 0%, #859398 55%, #dce3e8 100%)",
    "linear-gradient(135deg, #3c1053 0%, #ad5389 55%, #f7b2bd 100%)",
    "linear-gradient(135deg, #00416a 0%, #799f0c 55%, #ffe000 100%)",
    "linear-gradient(135deg, #42275a 0%, #f39f86 55%, #f7d794 100%)",
    "linear-gradient(135deg, #0b486b 0%, #3b8686 55%, #79bd9a 100%)",
    "linear-gradient(135deg, #614385 0%, #516395 55%, #92a8d1 100%)",
    "linear-gradient(135deg, #ff512f 0%, #dd2476 55%, #ff9966 100%)",
    "linear-gradient(135deg, #1f1c2c 0%, #928dab 55%, #c9c6d3 100%)",
    "linear-gradient(135deg, #355c7d 0%, #6c5b7b 55%, #c06c84 100%)"
];


// ==========================================
// YOUTUBE PLAYER INITIALIZATION
// ==========================================

function initializeYouTubePlayer() {
    const playerElement = document.getElementById("youtube-player");

    if (!playerElement) {
        console.error("YouTube player element not found.");
        return;
    }

    // Keep the player hidden until a video is selected.
    const container = document.getElementById("youtube-player-container");

    if (container) {
        container.style.width = "280px";
        container.style.height = "158px";
        container.style.maxWidth = "100%";
        container.style.display = "none";
    }

    // Load the official YouTube IFrame API.
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(script);
}

// YouTube calls this function when its API is loaded.
window.onYouTubeIframeAPIReady = function () {
    youtubeAPIReady = true;

    youtubePlayer = new YT.Player("youtube-player", {
        width: "360",
        height: "203",

        playerVars: {
            playsinline: 1,
            controls: 1,
            rel: 0,
            origin: window.location.origin
        },

        events: {
            onReady: function () {
                youtubePlayerReady = true;

                console.log("NeonWave YouTube player ready.");

                if (pendingYouTubeVideo) {
                    youtubePlayer.loadVideoById(pendingYouTubeVideo.id);
                    pendingYouTubeVideo = null;
                }
            },

            onStateChange: function (event) {
                // Playing
                if (event.data === YT.PlayerState.PLAYING) {
                    isPaused = false;
                    syncPlaybackGlyphs();
                }

                // Paused or ended
                if (
                    event.data === YT.PlayerState.PAUSED ||
                    event.data === YT.PlayerState.ENDED
                ) {
                    isPaused = true;
                    syncPlaybackGlyphs();
                }
            },

            onError: function (event) {
                console.error("YOUTUBE ERROR CODE:", event.data);

                console.error("FAILED VIDEO DETAILS:", {
                    currentSong: currentSong,
                    playerVideo: youtubePlayer
                        ? youtubePlayer.getVideoData()
                        : null
                });

                isPaused = true;
                syncPlaybackGlyphs();

                // Error 2/5/100/101/150/153 usually means this specific upload
                // cannot be embedded. Another version of the same song often
                // can, so try the remaining search results automatically.
                if (
                    [2, 5, 100, 101, 150, 153].includes(event.data) &&
                    currentProvider === "youtube"
                ) {
                    tryNextYouTubeVersion(event.data);
                } else {
                    showToast(
                        "This video could not be played.",
                        "error",
                        2600
                    );
                }
            }
        }
    });
};

// Wait until the HTML elements exist.
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeYouTubePlayer);
} else {
    initializeYouTubePlayer();
}

// Play the next embeddable version from the current YouTube results.
async function tryNextYouTubeVersion(errorCode = null) {
    if (youtubeHandlingError) return;

    youtubeHandlingError = true;

    const previous = currentSong;

    if (previous && previous.id) {
        youtubeTriedIds.add(previous.id);
    }

    const next = youtubeAlternatives.find(
        song => song && song.id && !youtubeTriedIds.has(song.id)
    );

    if (!next) {
        youtubeHandlingError = false;

        showToast(
            "No playable version found for this song. Try another search.",
            "error",
            3200
        );

        playbackState = "error";
        return;
    }

    try {
        youtubeResolvingFallback = true;
        await playOnlineSong(next);

        if (errorCode === 150 || errorCode === 153) {
            showToast(
                "That video blocks embedding — switched to another version.",
                "info",
                2600
            );
        }
    } catch (error) {
        console.error("Alternate version playback failed:", error);
        youtubeTriedIds.add(next.id);
        tryNextYouTubeVersion(errorCode);
    } finally {
        youtubeResolvingFallback = false;
        youtubeHandlingError = false;
    }
}

// ==========================================
// NEONWAVE - TOAST NOTIFICATIONS
// ==========================================

function showToast(message, type = "success", duration = 2500) {

    const toast = document.createElement("div");
    toast.className = `neon-toast neon-toast-${type}`;
    toast.textContent = message;

    document.body.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.add("show");
    });

    setTimeout(() => {
        toast.classList.remove("show");

        setTimeout(() => toast.remove(), 300);
    }, duration);
}


// ==========================================
// SHARED SONG ACTIONS
// ==========================================

// Streaming tracks are stored in SQLite with paths like
// `stream:jiosaavn:IPbuIHKX`. Playback recognises that prefix and sends the
// track back to its provider; likes/playlists keep using the integer row ID.
function parseSyntheticPath(path) {
    if (typeof path !== "string" || !path.startsWith("stream:")) return null;

    const parts = path.split(":");
    if (parts.length < 3) return null;

    return {
        provider: parts[1],
        id: parts.slice(2).join(":"),
    };
}

function savedIdForSong(song) {
    if (!song) return null;

    if (song.saved_id) {
        const saved = Number(song.saved_id);
        if (Number.isFinite(saved) && saved > 0) return saved;
    }

    const path = song.path;
    const localPath = typeof path === "string" && !path.startsWith("stream:");

    if (localPath && song.id && /^\d+$/.test(String(song.id))) {
        return Number(song.id);
    }

    return null;
}

async function decorateOnlineTracks(tracks) {
    const list = (tracks || []).filter(
        item => item && typeof item === "object" && item.id
    );

    if (!list.length || !pythonReady) return list;

    const alreadyResolved = list.filter(savedIdForSong);
    const unresolved = list.filter(item => !savedIdForSong(item));

    alreadyResolved.forEach(item => {
        item.saved_id = savedIdForSong(item);
    });

    if (!unresolved.length || !window.pywebview?.api?.resolve_saved_tracks) {
        return list;
    }

    try {
        const response = await window.pywebview.api.resolve_saved_tracks(
            unresolved.map(item => ({
                id: item.id,
                provider: item.provider || "youtube",
            }))
        );

        if (response?.success && Array.isArray(response.tracks)) {
            const byKey = new Map(
                response.tracks.map(item => [item.key, item.id])
            );

            unresolved.forEach(item => {
                const key = `${item.provider || "youtube"}:${item.id}`;
                if (byKey.has(key)) {
                    item.saved_id = Number(byKey.get(key));
                }
            });
        }
    } catch (error) {
        console.warn("Could not resolve saved streaming tracks:", error);
    }

    return list;
}

async function ensureSongSaved(song) {
    const existing = savedIdForSong(song);
    if (existing) return existing;

    if (!pythonReady || !window.pywebview?.api?.ensure_saved_track) {
        throw new Error("The library is not ready yet.");
    }

    const response = await window.pywebview.api.ensure_saved_track({
        id: song.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        duration: song.duration,
        provider: song.provider || "youtube",
    });

    if (!response?.success || !response.song?.id) {
        throw new Error(response?.error || "Could not save this song.");
    }

    song.saved_id = Number(response.song.id);
    return song.saved_id;
}

function createTrackLikeButton(song) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "track-like-button";

    const savedId = savedIdForSong(song);
    const liked = savedId ? likedSongIds.has(savedId) : false;

    if (savedId) button.dataset.songId = String(savedId);
    button.dataset.trackKey = trackKey(song);
    button.textContent = liked ? "♥" : "♡";
    button.classList.toggle("is-liked", liked);
    button.title = liked ? "Remove from Liked Songs" : "Add to Liked Songs";
    button.setAttribute("aria-label", button.title);

    button.addEventListener("click", event => {
        event.stopPropagation();
        handleLikeClick(song, button);
    });

    return button;
}

function closeTrackMenu() {
    if (!activeContextMenu) return;
    activeContextMenu.close();
    activeContextMenu = null;
}

function openTrackMenu(song, anchor, context = {}) {
    closeTrackMenu();

    const menu = document.createElement("div");
    menu.className = "track-context-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", `Actions for ${song.title || "song"}`);

    const addItem = (label, handler, className = "") => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = `track-context-menu-item ${className}`.trim();
        item.setAttribute("role", "menuitem");
        item.textContent = label;

        item.addEventListener("click", async event => {
            event.stopPropagation();
            closeTrackMenu();

            try {
                await handler(item);
            } catch (error) {
                console.error("Track menu action failed:", error);
                showToast(error.message || "Could not complete that action.", "error");
            }
        });

        menu.appendChild(item);
        return item;
    };

    const savedId = savedIdForSong(song);
    const liked = savedId ? likedSongIds.has(savedId) : false;

    addItem(
        liked ? "♥  Remove from Liked Songs" : "♡  Add to Liked Songs",
        () => handleLikeClick(song),
        liked ? "is-liked" : ""
    );

    addItem("＋  Add to playlist", () => addSongToPlaylist(song));
    addItem("✦  Create new playlist", () => createNewPlaylist(song));
    addItem("☷  Add to queue", () => addToQueue(song));

    addItem("⏭  Play next", () => {
        const index = playbackQueue.findIndex(
            item => trackKey(item) === trackKey(song)
        );

        if (index >= 0) {
            playbackQueue.splice(index + 1, 0, song);
        } else {
            playbackQueue.unshift(song);
        }

        renderQueue();
        showToast(`Playing ${song.title || "this song"} next`, "success", 1800);
    });

    if (song.provider === "jiosaavn" && !song.path) {
        addItem("↓  Save to your library", item => saveJiosaavnSong(song, item));
    }

    if (context.playlist) {
        addItem(
            "×  Remove from this playlist",
            () => openRemoveSongModal(context.playlist, song),
            "is-danger"
        );
    }

    document.body.appendChild(menu);

    const rect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const left = Math.min(
        Math.max(10, rect.right - menuRect.width),
        window.innerWidth - menuRect.width - 10
    );
    const top = rect.bottom + menuRect.height + 12 < window.innerHeight
        ? rect.bottom + 6
        : Math.max(10, rect.top - menuRect.height - 6);

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const onOutsideClick = event => {
        if (!menu.contains(event.target) && !anchor.contains(event.target)) {
            closeTrackMenu();
        }
    };

    const onEscape = event => {
        if (event.key === "Escape") closeTrackMenu();
    };

    const onScroll = () => closeTrackMenu();

    setTimeout(() => {
        document.addEventListener("click", onOutsideClick);
        document.addEventListener("keydown", onEscape);
        window.addEventListener("resize", onScroll);
        window.addEventListener("scroll", onScroll, true);
    }, 0);

    activeContextMenu = {
        element: menu,
        close: () => {
            document.removeEventListener("click", onOutsideClick);
            document.removeEventListener("keydown", onEscape);
            window.removeEventListener("resize", onScroll);
            window.removeEventListener("scroll", onScroll, true);
            menu.remove();
        },
    };

    anchor.setAttribute("aria-expanded", "true");
}

function createTrackMenuButton(song, context = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "track-menu-button";
    button.textContent = "⋯";
    button.title = "More options";
    button.setAttribute("aria-label", `More options for ${song.title || "song"}`);
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");

    button.addEventListener("click", event => {
        event.stopPropagation();
        openTrackMenu(song, button, context);
    });

    return button;
}

function createSongActions(song, context = {}) {
    const actions = document.createElement("div");
    actions.className = "song-actions";
    actions.append(
        createTrackLikeButton(song),
        createTrackMenuButton(song, context)
    );
    return actions;
}

// ==========================================
// NEONWAVE - LIKED SONGS
// ==========================================

let likedSongIds = new Set();
let likedSongsLoading = null;


// Load saved liked songs from SQLite
async function loadLikedSongIds() {

    if (likedSongsLoading) {
        return likedSongsLoading;
    }

    likedSongsLoading = (async () => {

        try {
            const result = await window.pywebview.api.get_liked_song_ids();

            if (!result.success) {
                throw new Error(result.error || "Could not load liked songs.");
            }

            likedSongIds = new Set(
                result.song_ids.map(Number)
            );

            updateLikeButtons();

        } catch (error) {
            console.error("Liked songs loading error:", error);

        } finally {
            likedSongsLoading = null;
        }

    })();

    return likedSongsLoading;
}


// Update visible heart buttons
function updateLikeButtons() {

    document.querySelectorAll(".track-like-button").forEach(button => {

        const songId = Number(button.dataset.songId);
        const liked = likedSongIds.has(songId);

        button.textContent = liked ? "♥" : "♡";
        button.classList.toggle("is-liked", liked);

        button.title = liked
            ? "Remove from Liked Songs"
            : "Add to Liked Songs";

        button.setAttribute("aria-label", button.title);
    });
}


// Notification
function showLikeToast(message) {

    let container = document.querySelector(".like-toast-container");

    if (!container) {

        container = document.createElement("div");
        container.className = "like-toast-container";

        document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.className = "like-toast";

    const heart = document.createElement("span");
    heart.className = "toast-heart";
    heart.textContent = "♥";

    const text = document.createElement("span");
    text.textContent = message;

    toast.append(heart, text);
    container.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.add("show");
    });

    setTimeout(() => {

        toast.classList.remove("show");

        setTimeout(() => toast.remove(), 300);

    }, 2200);
}


// Add or remove a liked song. Streaming tracks are saved into the existing
// library model first so the same SQLite liked-songs system works everywhere.
async function handleLikeClick(song, button = null) {

    if (!song || !song.id) {
        console.error("Cannot like song: song ID is missing.", song);
        showLikeToast("Unable to like this song");
        return;
    }

    if (button?.disabled) return;

    if (button) button.disabled = true;

    try {

        const songId = await ensureSongSaved(song);

        const result = await window.pywebview.api.toggle_like_song(songId);

        if (!result.success) {
            throw new Error(result.message || "Could not update liked songs.");
        }

        if (button) {
            button.dataset.songId = String(songId);
            button.dataset.trackKey = trackKey(song);
        }

        if (result.liked) {

            likedSongIds.add(songId);

            if (button) {
                button.classList.add("like-sparkle");

                setTimeout(() => {
                    button.classList.remove("like-sparkle");
                }, 650);
            }

            showLikeToast("Added to Liked Songs");

        } else {

            likedSongIds.delete(songId);

            showLikeToast("Removed from Liked Songs");
        }

        updateLikeButtons();

        // Keep the player, Home card and coverflow heart in sync.
        if (currentSong && trackKey(currentSong) === trackKey(song)) {
            updatePlayer(currentSong);
        }

        // Refresh playlist sidebar so its song count updates
        if (typeof loadPlaylists === "function") {
            await loadPlaylists();
        }

        // Refresh the Liked Songs page if it is currently open
        const likedPage = document.getElementById("page-liked");

        if (likedPage && !likedPage.classList.contains("hidden")) {
            await loadLikedSongsPage();
        }

        // Refresh currently open Liked Songs playlist
        if (
            typeof currentPlaylist !== "undefined" &&
            currentPlaylist &&
            currentPlaylist.name === "Liked Songs"
        ) {
            await openPlaylist(currentPlaylist);
        }

    } catch (error) {

        console.error("Like song error:", error);
        showLikeToast("Could not update Liked Songs");

    } finally {

        if (button) button.disabled = false;
    }
}


// ==========================================
// 1. NAVIGATION + SECTION THEMES
// ==========================================



const navButtons = document.querySelectorAll("[data-page]");

const pageSections = {
    home: document.getElementById("page-home"),
    discover: document.getElementById("page-discover"),
    library: document.getElementById("page-library"),
    liked: document.getElementById("page-liked"),
    playlist: document.getElementById("page-playlist")
};

const primaryNav = document.querySelector(".primary-nav");
let navIndicator = null;

// Create one shared sliding navigation indicator
if (primaryNav) {
    primaryNav.style.position = "relative";

    navIndicator = document.createElement("span");
    navIndicator.className = "nav-active-indicator";
    navIndicator.setAttribute("aria-hidden", "true");

    primaryNav.prepend(navIndicator);
}


// Move indicator directly to selected section
function moveNavIndicator(pageName) {

    if (!primaryNav || !navIndicator) return;

    const target = primaryNav.querySelector(
        `.nav-item[data-page="${pageName}"]`
    );

    if (!target) {
        navIndicator.classList.add("is-hidden");
        return;
    }

    navIndicator.classList.remove("is-hidden");

    navIndicator.style.height = `${target.offsetHeight}px`;

    navIndicator.style.transform =
        `translateY(${target.offsetTop}px)`;
}


// Generate a unique colour for each playlist
function setPlaylistTheme(playlist) {

    const name = playlist?.name || "Playlist";

    let hash = 0;

    for (let i = 0; i < name.length; i++) {
        hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    }

    const hue = hash % 360;

    const accent = `hsl(${hue} 72% 66%)`;
    const softAccent = `hsla(${hue}, 72%, 66%, .19)`;
    const glow = `hsla(${hue}, 72%, 60%, .13)`;

    document.documentElement.style.setProperty(
        "--theme-accent", accent
    );

    document.documentElement.style.setProperty(
        "--theme-accent-soft", softAccent
    );

    document.documentElement.style.setProperty(
        "--theme-glow", glow
    );

    document.body.dataset.theme = "playlist";
}


// Change application section
function showPage(pageName, playlist = null) {

    // Switch content immediately
    Object.entries(pageSections).forEach(([name, section]) => {

        if (section) {
            section.classList.toggle(
                "hidden",
                name !== pageName
            );
        }

    });

    document.getElementById("cover-flow")?.classList.add("hidden");


    // Update selected navigation item
    document.querySelectorAll(".nav-item").forEach(button => {

        button.classList.toggle(
            "active",
            button.dataset.page === pageName
        );

    });


    // Apply section theme
    if (["home", "discover", "library", "liked"].includes(pageName)) {

        document.body.dataset.theme = pageName;

        document.documentElement.style.removeProperty("--theme-accent");
        document.documentElement.style.removeProperty("--theme-accent-soft");
        document.documentElement.style.removeProperty("--theme-glow");

        moveNavIndicator(pageName);

    }

    // Playlist theme
    else if (pageName === "playlist" && playlist) {

        setPlaylistTheme(playlist);

        moveNavIndicator(null);

    }

    if (pageName === "home") {
        if (typeof loadHomeContent === "function") {
            loadHomeContent();
        }
    }

    if (pageName === "discover") {
        if (typeof loadJiosaavnDiscovery === "function") {
            loadJiosaavnDiscovery();
        }
        if (typeof loadJiosaavnTrending === "function") {
            loadJiosaavnTrending();
        }
    }

}


// Navigation click events
navButtons.forEach(button => {

    button.addEventListener("click", () => {

        const pageName = button.dataset.page;

        showPage(pageName);

    });

});


// Recalculate indicator position on resize
window.addEventListener("resize", () => {

    const activeButton = document.querySelector(".nav-item.active");

    if (activeButton) {
        moveNavIndicator(activeButton.dataset.page);
    }

});


// Initial theme
requestAnimationFrame(() => {

    document.body.dataset.theme = "home";

    moveNavIndicator("home");

});


// ==========================================
// 2. COVER FLOW
// ==========================================

const coverFlow = document.getElementById("cover-flow");
const homePage = document.getElementById("page-home");

function currentVisiblePage() {
    const entry = Object.entries(pageSections).find(
        ([, section]) => section && !section.classList.contains("hidden")
    );
    return entry ? entry[0] : "home";
}

function openCoverFlow() {
    if (!coverFlow) return;

    coverFlowReturnPage = currentVisiblePage();

    Object.values(pageSections).forEach(section => {
        section?.classList.add("hidden");
    });

    coverFlow.classList.remove("hidden");
    document.body.classList.add("coverflow-open");

    if (currentSong) updateCoverflowTrack(currentSong);
}

function closeCoverFlow() {
    if (!coverFlow) return;

    coverFlow.classList.add("hidden");
    document.body.classList.remove("coverflow-open");

    const returnSection = pageSections[coverFlowReturnPage] || homePage;
    returnSection?.classList.remove("hidden");

    if (coverFlowReturnPage === "home") {
        document.body.dataset.theme = "home";
        moveNavIndicator("home");
    }
}

document.getElementById("open-cover-flow")
    ?.addEventListener("click", openCoverFlow);

document.getElementById("close-cover-flow")
    ?.addEventListener("click", closeCoverFlow);

// Double-clicking anywhere on the bottom player opens the full-screen view.
document.querySelector(".player-bar")?.addEventListener("dblclick", event => {
    if (event.target.closest("button, input, #seek-track")) return;
    openCoverFlow();
});

function coverflowNeighbours(song) {
    const list = playbackQueue.length
        ? [...playbackQueue]
        : (song ? [song] : []);

    if (!list.length) return { previous: null, current: null, next: null };

    let index = list.findIndex(
        item => trackKey(item) === trackKey(song || currentSong)
    );

    if (index < 0) {
        list.unshift(song || currentSong);
        index = 0;
    }

    return {
        previous: list[(index - 1 + list.length) % list.length],
        current: list[index],
        next: list[(index + 1) % list.length],
    };
}

function setFlowArt(imageId, song) {
    const image = document.getElementById(imageId);
    if (!image) return;

    const art = songArtUrl(song);

    if (!art) {
        image.style.display = "none";
        image.removeAttribute("src");
        image.parentElement?.classList.add("is-empty");
        return;
    }

    image.style.display = "block";
    image.onerror = () => {
        image.style.display = "none";
        image.parentElement?.classList.add("is-empty");
    };
    image.onload = () => image.parentElement?.classList.remove("is-empty");
    image.src = art;
    image.alt = song?.title || "";
    image.parentElement?.classList.remove("is-empty");
}

function renderLyricsText(container, lyrics) {
    container.innerHTML = "";

    if (!lyrics) {
        container.textContent = "Lyrics aren't available for this track.";
        return;
    }

    lyrics.split(/\s+/).filter(Boolean).forEach((word, index) => {
        const span = document.createElement("span");
        span.textContent = `${word} `;
        span.style.setProperty("--word", index);
        container.appendChild(span);
    });
}

async function loadCoverflowLyrics(song) {
    const titleNode = document.getElementById("coverflow-lyrics-title");
    const body = document.getElementById("coverflow-lyrics");
    const source = document.getElementById("coverflow-lyrics-source");

    if (!body) return;

    if (!song || song.provider !== "jiosaavn" || !song.id) {
        if (titleNode) titleNode.textContent = "No lyrics here";
        renderLyricsText(body, "");
        if (source) source.textContent = "Play a JioSaavn track for an official excerpt";
        return;
    }

    const cacheKey = String(song.id);

    if (titleNode) titleNode.textContent = song.title || "Lyrics";
    renderLyricsText(body, "");

    const paint = data => {
        if (!data) return;

        if (data.available && data.lyrics) {
            renderLyricsText(body, data.lyrics);
            if (source) source.textContent = "Official JioSaavn lyric excerpt";
        } else {
            renderLyricsText(body, "");
            if (source) source.textContent = "No official lyric excerpt for this song";
        }
    };

    if (lyricCache.has(cacheKey)) {
        paint(lyricCache.get(cacheKey));
        return;
    }

    if (source) source.textContent = "Loading official excerpt…";

    try {
        const response = await window.pywebview.api.get_jiosaavn_lyrics(cacheKey);
        lyricCache.set(cacheKey, response);

        if (currentSong && String(currentSong.id) === cacheKey) {
            paint(response);
        }
    } catch (error) {
        console.warn("Lyrics lookup failed:", error);
        if (source) source.textContent = "Lyrics are unavailable right now";
    }
}

async function updateCoverflowTrack(song) {
    const { previous, current, next } = coverflowNeighbours(song);

    setFlowArt("flow-left-art", previous || current);
    setFlowArt("flow-center-art", current);
    setFlowArt("flow-right-art", next || current);

    const title = document.getElementById("coverflow-title");
    const artist = document.getElementById("coverflow-artist");
    const album = document.getElementById("coverflow-album");
    const art = document.getElementById("coverflow-player-art");
    const play = document.getElementById("coverflow-play");
    const like = document.getElementById("coverflow-like");

    if (title) title.textContent = current?.title || "Nothing playing";
    if (artist) artist.textContent = current?.artist || "Choose a song to begin";
    if (album) album.textContent = current?.album || "Let the record spin.";

    setArtBackground(art, songArtUrl(current), "♪");

    if (play) play.textContent = isPaused ? "▶" : "Ⅱ";

    if (like && current) {
        const savedId = savedIdForSong(current);
        const liked = savedId ? likedSongIds.has(savedId) : false;
        like.textContent = liked ? "♥" : "♡";
        like.classList.toggle("liked", liked);
        like.dataset.trackKey = trackKey(current);
    }

    loadCoverflowLyrics(current);
}

function updateCoverflowProgress(percent, currentTime, totalTime) {
    const progress = document.getElementById("coverflow-progress");
    if (progress) progress.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

document.getElementById("coverflow-prev")
    ?.addEventListener("click", () => previousSong());

document.getElementById("coverflow-next")
    ?.addEventListener("click", () => nextSong());

document.getElementById("coverflow-play")
    ?.addEventListener("click", () => togglePlayback());

document.getElementById("coverflow-like")
    ?.addEventListener("click", event => {
        if (!currentSong) {
            showToast("Play a song first", "info", 1600);
            return;
        }
        handleLikeClick(currentSong, event.currentTarget);
    });


// ==========================================
// 3. HEART / LIKE BUTTONS
// ==========================================

document.getElementById("home-now-like")
    ?.addEventListener("click", event => {
        if (!currentSong) {
            showToast("Play a song first", "info", 1600);
            return;
        }
        handleLikeClick(currentSong, event.currentTarget);
    });

document.getElementById("home-now-play")
    ?.addEventListener("click", () => togglePlayback());


// ==========================================
// 4. PLAYLIST MANAGEMENT
// ==========================================

async function openRenamePlaylistModal(playlist) {

    // Prevent multiple modals
    if (document.querySelector(".rename-playlist-overlay")) return;

    const overlay = document.createElement("div");
    overlay.className = "playlist-modal-overlay rename-playlist-overlay";

    const modal = document.createElement("div");
    modal.className = "playlist-modal";

    // Header
    const header = document.createElement("div");
    header.className = "glass-modal-header";

    const heading = document.createElement("h2");
    heading.textContent = "Rename Playlist";

    const closeButton = document.createElement("button");
    closeButton.className = "glass-modal-close";
    closeButton.textContent = "×";
    closeButton.type = "button";

    header.append(heading, closeButton);

    // Description
    const description = document.createElement("p");
    description.className = "glass-modal-description";
    description.textContent = "Choose a new name for your playlist.";

    // Input
    const input = document.createElement("input");
    input.className = "glass-modal-input";
    input.type = "text";
    input.value = playlist.name;
    input.maxLength = 60;

    // Error message
    const errorMessage = document.createElement("p");
    errorMessage.className = "glass-modal-error";

    // Actions
    const actions = document.createElement("div");
    actions.className = "glass-modal-actions";

    const cancelButton = document.createElement("button");
    cancelButton.className = "glass-modal-button";
    cancelButton.textContent = "Cancel";
    cancelButton.type = "button";

    const saveButton = document.createElement("button");
    saveButton.className = "glass-modal-button primary";
    saveButton.textContent = "Save Changes";
    saveButton.type = "button";

    actions.append(cancelButton, saveButton);

    // Close modal
    let handleEscape;

    function closeModal() {
        overlay.remove();
        document.removeEventListener("keydown", handleEscape);
    }

    closeButton.addEventListener("click", closeModal);
    cancelButton.addEventListener("click", closeModal);

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closeModal();
    });

    handleEscape = (event) => {
        if (event.key === "Escape") closeModal();
    };

    document.addEventListener("keydown", handleEscape);

    // Save renamed playlist
    async function savePlaylistName() {

        const newName = input.value.trim();

        if (!newName) {
            errorMessage.textContent = "Please enter a playlist name.";
            input.focus();
            return;
        }

        if (newName === playlist.name) {
            closeModal();
            return;
        }

        saveButton.disabled = true;
        saveButton.textContent = "Saving...";
        errorMessage.textContent = "";

        try {
            const response = await window.pywebview.api.rename_playlist(
                playlist.id,
                newName
            );

            if (!response.success) {
                throw new Error(
                    response.message || "Could not rename playlist."
                );
            }

            // Update currently open playlist
            if (
                currentPlaylist &&
                currentPlaylist.id === playlist.id
            ) {
                currentPlaylist.name = newName;
            }

            closeModal();

            await loadPlaylists();

            if (
                currentPlaylist &&
                currentPlaylist.id === playlist.id
            ) {
                openPlaylist(currentPlaylist);
            }

        } catch (error) {
            console.error("Rename playlist error:", error);

            errorMessage.textContent = error.message;
            saveButton.disabled = false;
            saveButton.textContent = "Save Changes";
        }
    }

    saveButton.addEventListener("click", savePlaylistName);

    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") savePlaylistName();
    });

    // Assemble modal
    modal.append(
        header,
        description,
        input,
        errorMessage,
        actions
    );

    overlay.append(modal);
    document.body.append(overlay);

    requestAnimationFrame(() => {
        input.focus();
        input.select();
    });
}

async function openDeletePlaylistModal(playlist) {

    // Prevent multiple modals
    if (document.querySelector(".delete-playlist-overlay")) return;

    const overlay = document.createElement("div");
    overlay.className = "playlist-modal-overlay delete-playlist-overlay";

    const modal = document.createElement("div");
    modal.className = "playlist-modal";

    // Header
    const header = document.createElement("div");
    header.className = "glass-modal-header";

    const heading = document.createElement("h2");
    heading.textContent = "Delete Playlist";

    const closeButton = document.createElement("button");
    closeButton.className = "glass-modal-close";
    closeButton.textContent = "×";
    closeButton.type = "button";

    header.append(heading, closeButton);

    // Description
    const description = document.createElement("p");
    description.className = "glass-modal-description";
    description.textContent =
        `Are you sure you want to delete "${playlist.name}"? This action cannot be undone.`;

    // Error message
    const errorMessage = document.createElement("p");
    errorMessage.className = "glass-modal-error";

    // Actions
    const actions = document.createElement("div");
    actions.className = "glass-modal-actions";

    const cancelButton = document.createElement("button");
    cancelButton.className = "glass-modal-button";
    cancelButton.textContent = "Cancel";
    cancelButton.type = "button";

    const deleteButton = document.createElement("button");
    deleteButton.className = "glass-modal-button danger";
    deleteButton.textContent = "Delete Playlist";
    deleteButton.type = "button";

    actions.append(cancelButton, deleteButton);

    // Close modal
    let handleEscape;

    function closeModal() {
        overlay.remove();
        document.removeEventListener("keydown", handleEscape);
    }

    closeButton.addEventListener("click", closeModal);
    cancelButton.addEventListener("click", closeModal);

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closeModal();
    });

    handleEscape = (event) => {
        if (event.key === "Escape") closeModal();
    };

    document.addEventListener("keydown", handleEscape);

    // Delete playlist
    async function confirmDelete() {

        deleteButton.disabled = true;
        deleteButton.textContent = "Deleting...";
        errorMessage.textContent = "";

        try {
            const response = await window.pywebview.api.delete_playlist(
                playlist.id
            );

            if (!response.success) {
                throw new Error(
                    response.message || "Could not delete playlist."
                );
            }

            // Return home if the deleted playlist was open
            if (
                currentPlaylist &&
                currentPlaylist.id === playlist.id
            ) {
                currentPlaylist = null;
                showPage("home");
            }

            closeModal();

            await loadPlaylists();

        } catch (error) {
            console.error("Delete playlist error:", error);

            errorMessage.textContent = error.message;
            deleteButton.disabled = false;
            deleteButton.textContent = "Delete Playlist";
        }
    }

    deleteButton.addEventListener("click", confirmDelete);

    // Assemble modal
    modal.append(
        header,
        description,
        errorMessage,
        actions
    );

    overlay.append(modal);
    document.body.append(overlay);
}

const playlistNav = document.querySelector(".playlist-nav");



async function loadPlaylists() {
    try {
        const result = await window.pywebview.api.get_playlists();

        if (!result.success) {
            console.error("Could not load playlists:", result.error);
            return;
        }

        playlistNav.innerHTML = "";

        // Hide the built-in Liked Songs collection.
        const userPlaylists = result.playlists.filter(
            playlist => playlist.name !== "Liked Songs"
        );

        if (userPlaylists.length === 0) {
            playlistNav.textContent = "No playlists yet";
            return;
        }

        userPlaylists.forEach(playlist => {
            const link = document.createElement("div");
            link.className = "playlist-link";
            link.dataset.playlistId = playlist.id;
            link.style.cursor = "pointer";

            const information = document.createElement("span");
            information.className = "playlist-link-info";

            const dot = document.createElement("span");
            dot.className = "playlist-dot";

            let playlistHash = 0;

            for (let i = 0; i < playlist.name.length; i++) {
                playlistHash =
                    (playlistHash * 31 + playlist.name.charCodeAt(i)) >>> 0;
            }

            const playlistHue = playlistHash % 360;

            link.style.setProperty(
                "--playlist-accent",
                `hsl(${playlistHue} 72% 66%)`
            );

            link.style.setProperty(
                "--playlist-accent-soft",
                `hsla(${playlistHue}, 72%, 66%, .16)`
            );

            const name = document.createElement("span");
            name.className = "playlist-link-name";
            name.textContent = playlist.name;

            information.append(dot, name);

            const renameButton = document.createElement("button");
            renameButton.className = "rename-playlist";
            renameButton.textContent = "✎";
            renameButton.title = "Rename playlist";

            renameButton.addEventListener("click", event => {
                event.stopPropagation();
                openRenamePlaylistModal(playlist);
            });

            const deleteButton = document.createElement("button");
            deleteButton.className = "delete-playlist";
            deleteButton.textContent = "×";
            deleteButton.title = "Delete playlist";

            deleteButton.addEventListener("click", event => {
                event.stopPropagation();
                openDeletePlaylistModal(playlist);
            });

            link.append(information, renameButton, deleteButton);

            link.addEventListener("click", () => {
                showPage("playlist");
                openPlaylist(playlist);
            });

            playlistNav.append(link);
        });

    } catch (error) {
        console.error("Playlist loading error:", error);
    }
}


async function openRemoveSongModal(playlist, song) {

    // Prevent multiple modals
    if (document.querySelector(".remove-song-overlay")) return;

    const overlay = document.createElement("div");
    overlay.className = "playlist-modal-overlay remove-song-overlay";

    const modal = document.createElement("div");
    modal.className = "playlist-modal";

    // Header
    const header = document.createElement("div");
    header.className = "glass-modal-header";

    const heading = document.createElement("h2");
    heading.textContent = "Remove Song";

    const closeButton = document.createElement("button");
    closeButton.className = "glass-modal-close";
    closeButton.textContent = "×";
    closeButton.type = "button";

    header.append(heading, closeButton);

    // Description
    const description = document.createElement("p");
    description.className = "glass-modal-description";
    description.textContent =
        `Remove "${song.title || "Unknown Title"}" from "${playlist.name}"?`;

    // Error message
    const errorMessage = document.createElement("p");
    errorMessage.className = "glass-modal-error";

    // Actions
    const actions = document.createElement("div");
    actions.className = "glass-modal-actions";

    const cancelButton = document.createElement("button");
    cancelButton.className = "glass-modal-button";
    cancelButton.textContent = "Cancel";
    cancelButton.type = "button";

    const removeButton = document.createElement("button");
    removeButton.className = "glass-modal-button danger";
    removeButton.textContent = "Remove Song";
    removeButton.type = "button";

    actions.append(cancelButton, removeButton);

    // Close modal
    let handleEscape;

    function closeModal() {
        overlay.remove();
        document.removeEventListener("keydown", handleEscape);
    }

    closeButton.addEventListener("click", closeModal);
    cancelButton.addEventListener("click", closeModal);

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closeModal();
    });

    handleEscape = (event) => {
        if (event.key === "Escape") closeModal();
    };

    document.addEventListener("keydown", handleEscape);

    // Remove song
    async function confirmRemove() {

        removeButton.disabled = true;
        removeButton.textContent = "Removing...";
        errorMessage.textContent = "";

        try {
            const response = await window.pywebview.api.remove_from_playlist(
                playlist.id,
                song.id
            );

            if (!response.success) {
                throw new Error(
                    response.message || "Could not remove song."
                );
            }

            closeModal();

            await openPlaylist(playlist);

        } catch (error) {
            console.error("Remove song error:", error);

            errorMessage.textContent = error.message;
            removeButton.disabled = false;
            removeButton.textContent = "Remove Song";
        }
    }

    removeButton.addEventListener("click", confirmRemove);

    // Assemble modal
    modal.append(
        header,
        description,
        errorMessage,
        actions
    );

    overlay.append(modal);
    document.body.append(overlay);
}

async function openPlaylist(playlist) {

    currentPlaylist = playlist;

    pushRecentRoutine({
        kind: "playlist",
        id: playlist.id,
        title: playlist.name,
        subtitle: `${playlist.song_count || 0} tracks · Playlist`,
    });

    const title = document.getElementById("playlist-title");
    const description = document.getElementById("playlist-description");
    const songCount = document.getElementById("playlist-song-count");
    const list = document.getElementById("playlist-song-list");

    title.textContent = playlist.name;
    description.textContent = "Your personal music collection.";

    // Apply saved playlist background preset
    const playlistPage = document.getElementById("page-playlist");

    const presetIndex = Number(playlist.background_preset) || 0;

    playlistPage.style.setProperty(
        "--playlist-background",
        PLAYLIST_GRADIENTS[presetIndex]
    );
    console.log("Playlist:", playlist.name);
    console.log("Saved preset:", playlist.background_preset);
    console.log("Selected gradient:", PLAYLIST_GRADIENTS[presetIndex]);
    console.log("Applied background:", getComputedStyle(playlistPage).backgroundImage);

    songCount.textContent = "Loading...";

    list.innerHTML = `
        <div class="empty-state">
            <h2>Loading playlist...</h2>
            <p>Retrieving your saved songs.</p>
        </div>
    `;

    try {

        const result = await window.pywebview.api.get_playlist_songs(
            playlist.id
        );

        if (!result.success) {
            throw new Error(result.error);
        }

        // The opened playlist becomes the active playback queue.
        playbackQueue = [...result.songs];

        songCount.textContent = `${result.count} songs`;

        if (result.songs.length === 0) {
            list.innerHTML = `
                <div class="empty-state">
                    <div class="empty-orb">♫</div>
                    <h2>This playlist is empty.</h2>
                    <p>Add songs from your music library.</p>
                </div>
            `;
            return;
        }

        list.innerHTML = "";

        result.songs.forEach((song, index) => {

            const row = document.createElement("div");
            row.className = "library-track";

            row.innerHTML = `
                <span class="track-number">${index + 1}</span>
                <div class="track-cover">♫</div>
                <div class="track-information">
                    <strong></strong>
                    <span></span>
                </div>
                <span class="track-album"></span>
                <span class="track-duration"></span>
            `;

            row.querySelector(".track-information strong").textContent =
                song.title || "Unknown Title";

            row.querySelector(".track-information span").textContent =
                song.artist || "Unknown Artist";

            row.querySelector(".track-album").textContent =
                song.album || "Unknown Album";

            row.querySelector(".track-duration").textContent =
                song.duration || "--:--";

            // Remove song button
            const removeButton = document.createElement("button");
            removeButton.className = "remove-from-playlist";
            removeButton.textContent = "×";
            removeButton.title = "Remove from playlist";

            removeButton.addEventListener("click", (event) => {
                event.stopPropagation();
                openRemoveSongModal(playlist, song);
            });

            row.append(
                createTrackLikeButton(song),
                removeButton,
                createTrackMenuButton(song, { playlist, page: "playlist" })
            );

            row.addEventListener("click", () => playSong(song));
            list.append(row);

        });

    } catch (error) {
        console.error("Playlist loading error:", error);
        songCount.textContent = "Unable to load";
    }
}


async function createNewPlaylist(song = null) {

    // Prevent multiple modals
    if (document.querySelector(".create-playlist-overlay")) return;

    // Overlay
    const overlay = document.createElement("div");
    overlay.className = "playlist-modal-overlay create-playlist-overlay";

    // Modal
    const modal = document.createElement("div");
    modal.className = "playlist-modal";

    // Header
    const header = document.createElement("div");
    header.className = "glass-modal-header";

    const heading = document.createElement("h2");
    heading.textContent = "Create Playlist";

    const closeButton = document.createElement("button");
    closeButton.className = "glass-modal-close";
    closeButton.textContent = "×";
    closeButton.type = "button";

    header.append(heading, closeButton);

    // Description
    const description = document.createElement("p");
    description.className = "glass-modal-description";
    description.textContent = song
        ? `Create a playlist for “${song.title || "this song"}”.`
        : "Give your new playlist a name.";

    // Input
    const input = document.createElement("input");
    input.className = "glass-modal-input";
    input.type = "text";
    input.placeholder = "Enter playlist name...";
    input.maxLength = 60;

    // Error message
    const errorMessage = document.createElement("p");
    errorMessage.className = "glass-modal-error";

    // Buttons
    const actions = document.createElement("div");
    actions.className = "glass-modal-actions";

    const cancelButton = document.createElement("button");
    cancelButton.className = "glass-modal-button";
    cancelButton.textContent = "Cancel";
    cancelButton.type = "button";

    const createButton = document.createElement("button");
    createButton.className = "glass-modal-button primary";
    createButton.textContent = "Create Playlist";
    createButton.type = "button";

    actions.append(cancelButton, createButton);

    // Close modal
    let handleEscape;

    function closeModal() {
        overlay.remove();
        document.removeEventListener("keydown", handleEscape);
    }

    closeButton.addEventListener("click", closeModal);
    cancelButton.addEventListener("click", closeModal);

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closeModal();
    });

    handleEscape = (event) => {
        if (event.key === "Escape") closeModal();
    };

    document.addEventListener("keydown", handleEscape);

    // Create playlist
    async function submitPlaylist() {

        const name = input.value.trim();

        if (!name) {
            errorMessage.textContent = "Please enter a playlist name.";
            input.focus();
            return;
        }

        createButton.disabled = true;
        createButton.textContent = "Creating...";
        errorMessage.textContent = "";

        try {
            const result = await window.pywebview.api.create_playlist(name);

            if (!result.success) {
                throw new Error(result.message || "Could not create playlist.");
            }

            closeModal();
            await loadPlaylists();

            if (song) {
                await addSongToPlaylist(song);
            } else {
                showToast(`Created “${name}”`, "success", 2000);
            }

        } catch (error) {
            console.error("Playlist creation error:", error);

            errorMessage.textContent = error.message;
            createButton.disabled = false;
            createButton.textContent = "Create Playlist";
        }
    }

    createButton.addEventListener("click", submitPlaylist);

    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submitPlaylist();
    });

    // Assemble modal
    modal.append(
        header,
        description,
        input,
        errorMessage,
        actions
    );

    overlay.append(modal);
    document.body.append(overlay);

    // Focus input
    requestAnimationFrame(() => input.focus());
}



document.getElementById("create-playlist")
    ?.addEventListener("click", () => createNewPlaylist());

document.querySelectorAll(".add-playlist")
    .forEach(button => {
        button.addEventListener("click", () => createNewPlaylist());
    });


// ==========================================
// 5. MUSIC LIBRARY
// ==========================================

let musicFolder = null;

const songList = document.getElementById("library-song-list");
const songCount = document.getElementById("library-count");

let songs = [];
let playbackQueue = [];
let currentSong = null;
let autoPlayEnabled = true;
let shuffleEnabled = false;
let autoAdvanceHandled = false;
let shuffleHistory = [];
let shuffleHistoryIndex = -1;
let currentProvider = "local";
let isPaused = false;
let pythonReady = false;
let currentPlaylist = null;
let playbackState = "stopped";
let repeatMode = "off";
let jiosaavnTrending = [];
let jiosaavnDiscovery = null;
let discoverDetailTracks = [];

// Home / detail navigation state
let detailReturnTo = "discover";
let lastSearchQuery = "";
let lastSearchProvider = "jiosaavn";
let coverFlowReturnPage = "home";
let homeContentLoaded = false;

// Reusable song actions
let activeContextMenu = null;
const lyricCache = new Map();
const RECENT_ROUTINE_KEY = "neonwave.recentRoutine.v1";

// YouTube player
let youtubePlayer = null;
let youtubeAPIReady = false;
let youtubePlayerReady = false;
let pendingYouTubeVideo = null;

// Some YouTube uploads block embedding (IFrame error 150/153). Keep the other
// search results so we can automatically try another version of the same song.
let youtubeAlternatives = [];
let youtubeTriedIds = new Set();
let youtubeHandlingError = false;
let youtubeResolvingFallback = false;

// A stable identity for both local files and streamed tracks.
function trackKey(song) {
    if (!song) return "";
    if (song.path) return `local:${song.path}`;
    return `${song.provider || "online"}:${song.id || song.title}`;
}


// ==========================================
// 6. LIBRARY MESSAGE
// ==========================================

function showLibraryMessage(title, description) {

    songList.innerHTML = "";

    const container = document.createElement("div");
    container.className = "empty-state";

    const heading = document.createElement("h2");
    heading.textContent = title;

    const paragraph = document.createElement("p");
    paragraph.textContent = description;

    container.append(heading, paragraph);

    songList.append(container);

}


// ==========================================
// 7. DISPLAY SONGS
// ==========================================

function displaySongs(songData) {
    songs = Array.isArray(songData) ? songData : [];

    // The library becomes the active playback queue.
    playbackQueue = [...songs];
    currentPlaylist = null;

    songCount.textContent = `${songs.length} songs`;

    renderSongs(songs);
}


async function addSongToPlaylist(song) {
    try {
        const result = await window.pywebview.api.get_playlists();

        if (!result.success) {
            console.error("Could not load playlists:", result.error);
            return;
        }

        const playlists = result.playlists.filter(
            playlist => playlist.name !== "Liked Songs"
        );

        // BACKGROUND OVERLAY
        const overlay = document.createElement("div");
        overlay.className = "playlist-modal-overlay";

        // GLASS POPUP
        const modal = document.createElement("div");
        modal.className = "playlist-modal";

        Object.assign(modal.style, {
            width: "100%",
            maxWidth: "440px",
            maxHeight: "80vh",
            overflowY: "auto",
            padding: "26px",
            color: "#f1f7f5",
            fontFamily: "inherit"
        });

        // HEADER
        const header = document.createElement("div");

        Object.assign(header.style, {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "8px"
        });

        const heading = document.createElement("h2");
        heading.textContent = "Add to playlist";

        Object.assign(heading.style, {
            margin: "0",
            fontSize: "21px",
            fontWeight: "700",
            color: "#72e4d8"
        });

        // CLOSE BUTTON
        const closeButton = document.createElement("button");
        closeButton.textContent = "×";

        Object.assign(closeButton.style, {
            width: "34px",
            height: "34px",
            borderRadius: "50%",
            border: "1px solid rgba(255,255,255,0.2)",
            background: "rgba(255,255,255,0.08)",
            color: "white",
            fontSize: "23px",
            cursor: "pointer"
        });

        // CLOSE MODAL
        let handleEscape;

        const closeModal = () => {
            overlay.remove();
            document.removeEventListener("keydown", handleEscape);
        };

        closeButton.addEventListener("click", closeModal);

        header.append(heading, closeButton);

        // SELECTED SONG INFORMATION
        const subtitle = document.createElement("p");

        subtitle.textContent =
            `Choose a playlist for "${song.title || "Unknown Title"}"`;

        Object.assign(subtitle.style, {
            margin: "0 0 22px",
            color: "rgba(230,245,242,0.7)",
            fontSize: "13px",
            lineHeight: "1.5"
        });

        // PLAYLIST CONTAINER
        const playlistList = document.createElement("div");

        Object.assign(playlistList.style, {
            display: "flex",
            flexDirection: "column",
            gap: "10px"
        });

        // EMPTY PLAYLIST MESSAGE
        if (playlists.length === 0) {
            const emptyMessage = document.createElement("p");

            emptyMessage.textContent =
                "You haven't created any playlists yet.";

            emptyMessage.style.color =
                "rgba(255,255,255,0.65)";

            playlistList.append(emptyMessage);
        }

        // CREATE PLAYLIST CARDS
        playlists.forEach((playlist, index) => {

            const playlistButton = document.createElement("button");
            playlistButton.className = "playlist-option";

            Object.assign(playlistButton.style, {
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: "13px",
                padding: "13px",
                borderRadius: "13px",
                color: "white",
                textAlign: "left",
                cursor: "pointer"
            });

            // PLAYLIST ARTWORK
            const artwork = document.createElement("div");

            Object.assign(artwork.style, {
                width: "44px",
                height: "44px",
                minWidth: "44px",
                borderRadius: "10px",

                background: `linear-gradient(135deg,
                    hsl(${(index * 67 + 170) % 360} 65% 35%),
                    hsl(${(index * 67 + 210) % 360} 65% 60%))`,

                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "19px",
                color: "white"
            });

            artwork.textContent = "♫";

            // PLAYLIST DETAILS
            const details = document.createElement("div");

            Object.assign(details.style, {
                flex: "1",
                minWidth: "0"
            });

            const name = document.createElement("strong");
            name.textContent = playlist.name;

            Object.assign(name.style, {
                display: "block",
                fontSize: "14px"
            });

            const count = document.createElement("span");

            count.textContent = `${playlist.song_count} songs`;

            Object.assign(count.style, {
                display: "block",
                marginTop: "4px",
                fontSize: "12px",
                color: "rgba(255,255,255,0.6)"
            });

            details.append(name, count);

            // ARROW
            const arrow = document.createElement("span");

            arrow.textContent = "›";

            Object.assign(arrow.style, {
                fontSize: "23px",
                color: "#72e4d8"
            });

            playlistButton.append(
                artwork,
                details,
                arrow
            );

            // ADD SONG TO PLAYLIST
            playlistButton.addEventListener("click", async () => {

                playlistButton.disabled = true;
                name.textContent = "Adding...";

                try {
                    const songId = await ensureSongSaved(song);

                    const response =
                        await window.pywebview.api.add_to_playlist(
                            playlist.id,
                            songId
                        );

                    if (!response.success) {
                        throw new Error(
                            response.message || "Could not add song."
                        );
                    }

                    closeModal();

                    // Refresh currently opened playlist
                    if (
                        currentPlaylist &&
                        currentPlaylist.id === playlist.id
                    ) {
                        await openPlaylist(currentPlaylist);
                    }

                    // Refresh sidebar playlist counts
                    await loadPlaylists();

                    // SUCCESS TOAST
                    showToast(`✓ Added to ${playlist.name}`, "success");

                } catch (error) {
                    console.error("Add to playlist error:", error);

                    showToast(error.message || "Could not add song.", "error");

                    name.textContent = playlist.name;
                    playlistButton.disabled = false;
                }
            });

            playlistList.append(playlistButton);
        });

        // ASSEMBLE POPUP
        modal.append(
            header,
            subtitle,
            playlistList
        );

        overlay.append(modal);
        document.body.append(overlay);

        // CLOSE WHEN CLICKING OUTSIDE
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) {
                closeModal();
            }
        });

        // CLOSE WITH ESCAPE
        handleEscape = (event) => {
            if (event.key === "Escape") {
                closeModal();
            }
        };

        document.addEventListener("keydown", handleEscape);

    } catch (error) {
        console.error("Playlist popup error:", error);
    }
}




function renderSongs(songData, targetList = songList) {

    targetList.innerHTML = "";

    if (songData.length === 0) {
        showLibraryMessage(
            "No songs found.",
            "Try another song title, artist, or album."
        );
        return;
    }

    songData.forEach((song, index) => {

        const row = document.createElement("div");
        row.className = "library-track";

        Object.assign(row.style, {
            display: "grid",
            gridTemplateColumns:
                "28px 42px minmax(160px, 1.7fr) minmax(90px, 1fr) 34px 48px 34px",
            alignItems: "center",
            gap: "14px",
            padding: "12px 16px",
            minHeight: "68px",
            boxSizing: "border-box",
            position: "relative"
        });

        // Track number
        const number = document.createElement("span");
        number.className = "track-number";
        number.textContent = index + 1;
        number.style.textAlign = "center";

        // Cover
        const cover = document.createElement("div");
        cover.className = "track-cover";
        cover.textContent = "♫";

        Object.assign(cover.style, {
            width: "42px",
            height: "42px",
            minWidth: "42px"
        });

        // Track information
        const information = document.createElement("div");
        information.className = "track-information";

        Object.assign(information.style, {
            minWidth: "0",
            overflow: "hidden"
        });

        const title = document.createElement("strong");
        title.textContent = song.title || "Unknown Title";

        Object.assign(title.style, {
            display: "block",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis"
        });

        const artist = document.createElement("span");
        artist.textContent = song.artist || "Unknown Artist";

        Object.assign(artist.style, {
            display: "block",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis"
        });

        information.append(title, artist);

        // Album
        const album = document.createElement("span");
        album.className = "track-album";
        album.textContent = song.album || "Unknown Album";

        Object.assign(album.style, {
            minWidth: "0",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis"
        });

        // Like button
        const likeButton = createTrackLikeButton(song);

        // Duration
        const duration = document.createElement("span");
        duration.className = "track-duration";
        duration.textContent = song.duration || "--:--";

        Object.assign(duration.style, {
            textAlign: "right",
            whiteSpace: "nowrap"
        });

        // Three-dot menu
        const menuButton = createTrackMenuButton(song, { page: "library" });

        // Assemble row
        row.append(
            number,
            cover,
            information,
            album,
            likeButton,
            duration,
            menuButton
        );

        // Play song
        row.addEventListener("click", () => {
            playSong(song);
        });

        targetList.append(row);
    });

    // Refresh saved like states from the database
    loadLikedSongIds();
}

document.addEventListener("click", (event) => {

    const likedNavigation = event.target.closest('[data-page="liked"]');

    if (!likedNavigation) return;

    loadLikedSongsPage();
});



// ==========================================
// LIBRARY SEARCH
// ==========================================

const librarySearch = document.getElementById("library-search");

librarySearch?.addEventListener("input", () => {

    const query = librarySearch.value.trim().toLowerCase();

    const filteredSongs = songs.filter(song => {

        const title = (song.title || "").toLowerCase();
        const artist = (song.artist || "").toLowerCase();
        const album = (song.album || "").toLowerCase();

        return (
            title.includes(query) ||
            artist.includes(query) ||
            album.includes(query)
        );
    });

    renderSongs(filteredSongs);
});

// ==========================================
// 9. UPDATE BOTTOM PLAYER + LIVE HOME CARDS
// ==========================================

function songArtUrl(song) {
    return song?.thumbnail_data || song?.thumbnail || "";
}

function setArtBackground(element, url, fallbackText = "♪") {
    if (!element) return;

    if (url) {
        element.style.backgroundImage = `url("${url}")`;
        element.style.backgroundSize = "cover";
        element.style.backgroundPosition = "center";
        element.textContent = "";
    } else {
        element.style.backgroundImage = "";
        element.textContent = fallbackText;
    }
}

function updateTakeoverCard(song) {
    const card = document.getElementById("takeover-card");
    const title = document.getElementById("takeover-title");
    const artist = document.getElementById("takeover-artist");
    const eyebrow = document.getElementById("takeover-eyebrow");
    const kicker = document.getElementById("takeover-kicker");
    const cover = document.getElementById("takeover-cover");

    if (!card) return;

    card.classList.add("has-track", "is-playing");

    if (title) title.textContent = song.title || "Your soundtrack";
    if (artist) {
        const album = song.album ? ` · ${song.album}` : "";
        artist.textContent = `${song.artist || "Unknown Artist"}${album}`;
    }
    if (eyebrow) eyebrow.textContent = "NOW TAKING OVER";
    if (kicker) kicker.textContent = "THE VINYL IS MOVING";

    setArtBackground(cover, songArtUrl(song), "NW");
}

function updateHomeNowCard(song) {
    const title = document.getElementById("home-now-title");
    const artist = document.getElementById("home-now-artist");
    const cover = document.getElementById("home-now-cover");
    const like = document.getElementById("home-now-like");
    const play = document.getElementById("home-now-play");

    if (title) title.textContent = song.title || "Unknown Title";
    if (artist) artist.textContent = song.artist || "Unknown Artist";

    setArtBackground(cover, songArtUrl(song), "♪");

    if (like) {
        const savedId = savedIdForSong(song);
        const liked = savedId ? likedSongIds.has(savedId) : false;
        like.textContent = liked ? "♥" : "♡";
        like.classList.toggle("liked", liked);
        like.dataset.trackKey = trackKey(song);
    }

    if (play) play.textContent = isPaused ? "▶" : "Ⅱ";
}

function syncPlaybackGlyphs() {
    const glyph = isPaused ? "▶" : "Ⅱ";

    ["main-play", "home-now-play", "coverflow-play"].forEach(id => {
        const button = document.getElementById(id);
        if (button) button.textContent = glyph;
    });

    document.getElementById("takeover-card")
        ?.classList.toggle("is-playing", Boolean(currentSong) && !isPaused);
}

function updatePlayer(song) {

    document.getElementById("player-title").textContent =
        song.title || "Unknown Title";

    document.getElementById("player-artist").textContent =
        song.artist || "Unknown Artist";

    const thumb = document.querySelector(".player-thumb");

    if (thumb) {
        if (songArtUrl(song)) {
            thumb.style.backgroundImage = `url("${songArtUrl(song)}")`;
            thumb.style.backgroundSize = "cover";
            thumb.style.backgroundPosition = "center";
            thumb.textContent = "";
        } else {
            thumb.style.backgroundImage = "";
            thumb.textContent = (song.title || "A").charAt(0).toUpperCase();
        }
    }

    const savedId = savedIdForSong(song);
    const liked = savedId ? likedSongIds.has(savedId) : false;

    const likeButton = document.getElementById("player-like-button");

    if (likeButton) {
        likeButton.textContent = liked ? "♥" : "♡";
        likeButton.classList.toggle("liked", liked);
        if (savedId) likeButton.dataset.songId = String(savedId);
        likeButton.dataset.trackKey = trackKey(song);
        likeButton.title = liked
            ? "Remove from Liked Songs"
            : "Add to Liked Songs";
    }

    updateTakeoverCard(song);
    updateHomeNowCard(song);
    updateCoverflowTrack(song);
    syncPlaybackGlyphs();

    renderQueue();
}

// ==========================================
// PLAYBACK TRANSITION CONTROLLER
// ==========================================

async function stopPreviousPlayback(nextProvider) {

    // Switching away from YouTube.
    if (
        currentProvider === "youtube" &&
        nextProvider !== "youtube"
    ) {

        if (youtubePlayerReady && youtubePlayer) {
            youtubePlayer.stopVideo();
        }
        const container = document.getElementById("youtube-player-container");

        if (container) {
            container.style.display = "none";
        }

        const alternateButton = document.getElementById(
            "alternate-version-button"
        );

        if (alternateButton) {
            alternateButton.classList.add("hidden");
        }

        console.log("Stopped YouTube playback.");
    }

    // Switching from VLC to YouTube.
    else if (
        currentProvider !== "youtube" &&
        nextProvider === "youtube"
    ) {

        await window.pywebview.api.stop_song();

        console.log("Stopped VLC playback.");
    }
}


// ==========================================
// 10. PLAY A SONG
// ==========================================

async function playSong(song, recordShuffleHistory = true) {
    console.log("Selected song object:", song);

    if (!pythonReady) {
        console.error("Python backend is not ready yet.");
        return;
    }

    if (!song) {
        console.error("No song was selected.");
        return;
    }

    // Online tracks are streamed through their provider.
    if (!song.path && song.provider) {
        return playOnlineSong(song);
    }

    // Liked/playlisted streaming songs carry a synthetic library path. Send
    // them back to their provider instead of treating that path as a file.
    const synthetic = parseSyntheticPath(song.path);
    if (synthetic) {
        return playOnlineSong({
            ...song,
            id: synthetic.id,
            provider: synthetic.provider,
            path: undefined,
            saved_id: song.id,
        });
    }

    if (!song.path) {
        console.error("Invalid local song:", song);
        return;
    }

    try {
        // Stop YouTube playback before starting local music.
        await stopPreviousPlayback("local");

        const result = await window.pywebview.api.play_song(song.path);

        console.log("Playback response:", result);

        if (!result || !result.success) {
            console.error("Playback failed:", result?.message);
            return;
        }

        currentSong = song;
        currentProvider = "local";
        isPaused = false;
        playbackState = "playing";

        // autoAdvanceHandled is reset only after VLC reports real playback.
        // Resetting it here lets a startup hiccup re-arm auto-advance.

        // Record song in shuffle history.
        if (shuffleEnabled && recordShuffleHistory) {

            // Remove forward history when a new song is selected.
            shuffleHistory = shuffleHistory.slice(
                0,
                shuffleHistoryIndex + 1
            );

            // Avoid recording the same song twice consecutively.
            if (
                shuffleHistory.length === 0 ||
                trackKey(shuffleHistory[shuffleHistory.length - 1]) !== trackKey(song)
            ) {
                shuffleHistory.push(song);
            }

            shuffleHistoryIndex = shuffleHistory.length - 1;
        }
        updatePlayer(song);

        syncPlaybackGlyphs();

        console.log("Now playing:", song.title);

    } catch (error) {
        console.error("Playback error:", error);
    }
}

// ==========================================
// PLAY ONLINE YOUTUBE SONG
// ==========================================

async function playOnlineSong(song) {

    if (!song || !song.id) {
        console.error("Invalid online song:", song);
        return;
    }

    try {

        const provider = song.provider || currentProvider;

        const switchResult = await window.pywebview.api
            .set_music_provider(provider);

        if (!switchResult || !switchResult.success) {
            throw new Error(
                `Could not activate provider: ${provider}`
            );
        }

        const response = await window.pywebview.api
            .get_music_provider_capabilities();

        if (!response || !response.capabilities) {
            throw new Error("Could not retrieve provider capabilities.");
        }

        const capabilities = response.capabilities;

        if (response.provider !== provider) {
            throw new Error(
                `Selected provider mismatch: ${provider}`
            );
        }

        // JioSaavn streams real audio through VLC.
        if (provider === "jiosaavn") {

            await stopPreviousPlayback(provider);

            const result = await window.pywebview.api
                .play_jiosaavn_track(song.id);

            if (!result || !result.success) {
                throw new Error(
                    result?.error ||
                    result?.message ||
                    "Audio playback failed."
                );
            }

            // Keep the queue object identity so next/previous can find it.
            if (result.track) {
                Object.assign(song, result.track);
            }

            currentSong = song;
            currentProvider = provider;
            isPaused = false;
            playbackState = "playing";
            updatePlayer(song);

            syncPlaybackGlyphs();

            if (typeof showToast === "function") {
                showToast(`Playing ${currentSong.title}`, "success", 1800);
            }

            return;
        }

        if (capabilities.embed_playback && provider === "youtube") {
            await stopPreviousPlayback("youtube");

            if (!youtubePlayerReady || !youtubePlayer) {
                throw new Error("YouTube player is not ready.");
            }

            const container = document.getElementById("youtube-player-container");

            if (container) {
                container.style.display = "block";
            }

            // Build the fallback list from the active queue. A fresh play
            // starts from this song; an automatic retry keeps earlier attempts.
            if (!youtubeResolvingFallback) {
                youtubeAlternatives = playbackQueue.filter(
                    item => item && item.provider === "youtube"
                );
                youtubeTriedIds = new Set([song.id]);
            }

            currentSong = song;
            currentProvider = provider;
            isPaused = false;
            playbackState = "playing";

            const alternateButton = document.getElementById(
                "alternate-version-button"
            );

            if (alternateButton) {
                alternateButton.classList.remove("hidden");
            }

            youtubePlayer.loadVideoById(song.id);

            updatePlayer(song);

            syncPlaybackGlyphs();

            console.log("Now playing online:", song.title);

            return;
        }

        if (capabilities.audio_source) {
            await stopPreviousPlayback(provider);
            console.log(
                "Starting authorized provider playback:",
                provider
            );

            const result = await window.pywebview.api
                .play_provider_track(song.id);

            if (!result || !result.success) {
                throw new Error(
                    result?.message ||
                    result?.error ||
                    "Provider playback failed."
                );
            }

            currentSong = song;
            currentProvider = provider;
            isPaused = false;
            playbackState = "playing";

            updatePlayer(song);

            syncPlaybackGlyphs();

            console.log("Now playing online:", song.title);

            return;
        }

        throw new Error(
            `${provider} does not currently support playback in NeonWave.`
        );

    } catch (error) {

        console.error("Online playback error:", error);

    }
}

// Move to the next song
// Move to the next song
function nextSong() {
    if (playbackQueue.length === 0) return;

    // Shuffle navigation
    if (shuffleEnabled) {

        // Move forward through existing listening history.
        if (shuffleHistoryIndex < shuffleHistory.length - 1) {

            shuffleHistoryIndex++;

            playSong(
                shuffleHistory[shuffleHistoryIndex],
                false
            );

            return;
        }

        // Otherwise, choose a new random song.
        if (playbackQueue.length > 1) {

            const availableSongs = playbackQueue.filter(
                song => trackKey(song) !== trackKey(currentSong)
            );

            const nextSongIndex = Math.floor(
                Math.random() * availableSongs.length
            );

            playSong(availableSongs[nextSongIndex]);

        }

        return;
    }

    // Normal queue navigation
    let currentIndex = playbackQueue.indexOf(currentSong);
    let nextIndex = currentIndex + 1;

    if (nextIndex >= playbackQueue.length || currentIndex === -1) {
        nextIndex = 0;
    }

    playSong(playbackQueue[nextIndex]);
}


// Move to the previous song
function previousSong() {
    if (playbackQueue.length === 0) return;

    // Shuffle navigation
    if (shuffleEnabled) {

        if (shuffleHistoryIndex > 0) {

            shuffleHistoryIndex--;

            playSong(
                shuffleHistory[shuffleHistoryIndex],
                false
            );

        }

        return;
    }

    // Normal queue navigation
    let currentIndex = playbackQueue.indexOf(currentSong);
    let previousIndex = currentIndex - 1;

    if (currentIndex === -1 || previousIndex < 0) {
        previousIndex = playbackQueue.length - 1;
    }

    playSong(playbackQueue[previousIndex]);
}


// Connect buttons
document.getElementById("next-button")
    ?.addEventListener("click", nextSong);

document.getElementById("previous-button")
    ?.addEventListener("click", previousSong);

document.getElementById("shuffle-button")
    ?.addEventListener("click", () => {

        shuffleEnabled = !shuffleEnabled;
        if (shuffleEnabled) {

            // Start history with the currently playing song.
            shuffleHistory = currentSong ? [currentSong] : [];
            shuffleHistoryIndex = shuffleHistory.length - 1;

        } else {

            shuffleHistory = [];
            shuffleHistoryIndex = -1;

        }

        const shuffleButton = document.getElementById("shuffle-button");

        shuffleButton.classList.toggle("active", shuffleEnabled);

        if (shuffleEnabled) {
            showToast("⤨ Shuffle Mode On", "shuffle");
        } else {
            showToast("⤨ Shuffle Mode Off", "info");
        }

        console.log("Shuffle:", shuffleEnabled ? "ON" : "OFF");

    });

document.getElementById("repeat-button")
    ?.addEventListener("click", () => {

        const modes = ["off", "all", "one"];
        const labels = {
            off: "Repeat off",
            all: "Repeat all",
            one: "Repeat one"
        };

        repeatMode = modes[(modes.indexOf(repeatMode) + 1) % modes.length];

        const button = document.getElementById("repeat-button");
        button.classList.toggle("active", repeatMode !== "off");
        button.classList.toggle("repeat-one", repeatMode === "one");
        button.title = labels[repeatMode];

        showToast(labels[repeatMode], "info", 1500);
    });


// ==========================================
// 11. PLAY / PAUSE BUTTON
// ==========================================

async function togglePlayback() {

    if (!pythonReady) {
        console.error("Python backend is not ready.");
        return;
    }

    try {

        if (!currentSong) {
            if (songs.length > 0) {
                await playSong(songs[0]);
            } else {
                console.log("No songs available.");
            }

            return;
        }

        // YouTube uses its own embedded player.
        if (currentProvider === "youtube") {

            if (!youtubePlayerReady || !youtubePlayer) {
                console.error("YouTube player is not ready.");
                return;
            }

            if (isPaused) {
                youtubePlayer.playVideo();
                isPaused = false;
                syncPlaybackGlyphs();
            } else {
                youtubePlayer.pauseVideo();
                isPaused = true;
                syncPlaybackGlyphs();
            }

            return;
        }


        // Local and authorized-download playback use VLC.

        // Restart the track if it has finished.
        if (
            playbackState === "ended" ||
            playbackState === "stopped"
        ) {
            await playSong(currentSong);
            return;
        }

        if (isPaused) {
            await window.pywebview.api.resume_song();
            isPaused = false;
            syncPlaybackGlyphs();
        } else {
            await window.pywebview.api.pause_song();
            isPaused = true;
            syncPlaybackGlyphs();
        }

    } catch (error) {
        console.error("Playback control error:", error);
    }
}

document.getElementById("main-play").addEventListener("click", () => {
    togglePlayback();
});


// ==========================================
// 12. FEATURED PLAY BUTTON
// ==========================================

document.getElementById("play-featured").addEventListener("click", () => {

    if (songs.length > 0) {
        playSong(songs[0]);
    } else {
        console.log("No songs available to play.");
    }

});


// ==========================================
// 13. REFRESH MUSIC LIBRARY
// ==========================================

document.getElementById("refresh-library").addEventListener("click", () => {

    refreshMusicLibrary();

});


// ==========================================
// 14. PYTHON CONNECTION
// ==========================================

window.addEventListener("pywebviewready", async function () {

    console.log("NeonWave Python bridge connected!");

    pythonReady = true;

    try {
        const folderResult = await window.pywebview.api.get_music_folder();

        if (folderResult?.success) {
            musicFolder = folderResult.folder;
            const pathLabel = document.getElementById("music-folder-path");
            if (pathLabel) pathLabel.textContent = musicFolder;
        }

        await window.pywebview.api.set_volume(
            Number(document.getElementById("volume-slider")?.value || 70) / 100
        );
    } catch (error) {
        console.error("Startup settings error:", error);
    }

    await loadMusicLibrary();
    await loadPlaylists();
    await loadMusicProviders();
    await loadLikedSongIds();
    await loadHomeContent();

});

playSong

function formatTime(seconds) {
    seconds = Math.floor(Math.max(0, seconds || 0));

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}


async function updateProgress() {

    if (!currentSong || isSeeking) return;

    try {

        let currentTime = 0;
        let totalTime = 0;

        // YouTube progress
        if (currentProvider === "youtube") {

            if (!youtubePlayerReady || !youtubePlayer) return;

            currentTime = youtubePlayer.getCurrentTime();
            totalTime = youtubePlayer.getDuration();

        }

        // VLC progress: local and authorized downloaded audio
        else {

            if (!pythonReady) return;

            const progress = await window.pywebview.api.get_progress();

            currentTime = progress.current_time;
            totalTime = progress.total_time;

            playbackState = progress.playback_state;
            const playButton = document.getElementById("main-play");

            // The backend only reports "ended" after VLC has actually played
            // the track. Re-arm auto-advance on the first real Playing poll,
            // not when play() is requested, so startup hiccups cannot cascade.
            if (playbackState === "playing") {
                autoAdvanceHandled = false;
            }

            // Extra safety: never auto-advance from a bogus end position.
            const reachedEnd = totalTime <= 0 ||
                currentTime >= totalTime - 3;

            if (
                playbackState === "ended" &&
                reachedEnd &&
                autoPlayEnabled &&
                !autoAdvanceHandled
            ) {
                autoAdvanceHandled = true;

                if (repeatMode === "one" && currentSong) {
                    playSong(currentSong);
                    return;
                }

                const currentKey = trackKey(currentSong);
                const currentIndex = playbackQueue.findIndex(
                    item => trackKey(item) === currentKey
                );
                const isLast = currentIndex === -1 ||
                    currentIndex >= playbackQueue.length - 1;

                if (repeatMode === "off" && isLast) {
                    await window.pywebview.api.stop_song();
                    playbackState = "stopped";
                    isPaused = true;
                    syncPlaybackGlyphs();
                    return;
                }

                nextSong();
                return;
            }

            if (playbackState === "paused") {
                isPaused = true;
                playButton.textContent = "▶";
            }
            else if (playbackState === "playing") {
                isPaused = false;
                playButton.textContent = "Ⅱ";
            }
            else if (
                playbackState === "ended" ||
                playbackState === "stopped" ||
                playbackState === "error"
            ) {
                isPaused = true;
                playButton.textContent = "▶";
            }

        }

        currentTime = Math.max(0, currentTime || 0);
        totalTime = Math.max(0, totalTime || 0);

        document.getElementById("current-time").textContent =
            formatTime(currentTime);

        document.getElementById("total-time").textContent =
            formatTime(totalTime);

        const percentage = totalTime > 0
            ? Math.min(100, (currentTime / totalTime) * 100)
            : 0;

        document.getElementById("progress-fill").style.width =
            `${percentage}%`;

        const homeProgress = document.getElementById("home-now-progress");
        if (homeProgress) homeProgress.style.width = `${percentage}%`;

        const homeCurrent = document.getElementById("home-now-current");
        if (homeCurrent) homeCurrent.textContent = formatTime(currentTime);

        const homeTotal = document.getElementById("home-now-total");
        if (homeTotal) homeTotal.textContent = formatTime(totalTime);

        updateCoverflowProgress(percentage);

    } catch (error) {

        console.error("Progress update error:", error);

    }
}
// Update progress every second
setInterval(updateProgress, 1000);


let isSeeking = false;

function getSeekPercentage(event) {
    const track = document.getElementById("seek-track");
    const rect = track.getBoundingClientRect();

    return Math.max(
        0,
        Math.min(1, (event.clientX - rect.left) / rect.width)
    );
}

function updateSeekPreview(event) {
    const percentage = getSeekPercentage(event);

    document.getElementById("progress-fill").style.width =
        `${percentage * 100}%`;
}

async function finishSeeking(event) {

    if (!isSeeking) return;

    isSeeking = false;

    const percentage = getSeekPercentage(event);

    try {

        // YouTube seeking
        if (currentProvider === "youtube") {

            if (!youtubePlayerReady || !youtubePlayer) {
                return;
            }

            const totalTime = youtubePlayer.getDuration();
            const targetTime = percentage * totalTime;

            youtubePlayer.seekTo(targetTime, true);

        }

        // VLC seeking
        else {

            const progress = await window.pywebview.api.get_progress();

            const targetTime = percentage * progress.total_time;

            await window.pywebview.api.seek_song(targetTime);

        }

        await updateProgress();

    } catch (error) {

        console.error("Seek error:", error);

    }
}



const seekTrack = document.getElementById("seek-track");

seekTrack?.addEventListener("pointerdown", (event) => {
    if (!currentSong || !pythonReady) return;

    isSeeking = true;
    seekTrack.setPointerCapture(event.pointerId);
    updateSeekPreview(event);
});

seekTrack?.addEventListener("pointermove", (event) => {
    if (!isSeeking) return;

    updateSeekPreview(event);
});

seekTrack?.addEventListener("pointerup", finishSeeking);

seekTrack?.addEventListener("pointercancel", finishSeeking);


async function loadMusicLibrary() {

    songCount.textContent = "Loading...";

    showLibraryMessage(
        "Loading your music...",
        "Retrieving your saved music library."
    );

    try {
        const result = await window.pywebview.api.get_saved_songs();

        console.log("Database library response:", result);

        if (!result.success) {
            songCount.textContent = "Unable to load";

            showLibraryMessage(
                "Could not load music.",
                result.error || "An unknown error occurred."
            );

            return;
        }

        displaySongs(result.songs);

    } catch (error) {
        console.error("Library loading error:", error);

        songCount.textContent = "Error";

        showLibraryMessage(
            "Something went wrong.",
            error.message
        );
    }
}


async function refreshMusicLibrary() {

    songCount.textContent = "Scanning...";

    showLibraryMessage(
        "Refreshing your library...",
        "Scanning your music folder and updating the database."
    );

    try {
        const result = await window.pywebview.api.scan_music_folder();

        if (!result.success) {
            songCount.textContent = "Refresh failed";

            showLibraryMessage(
                "Could not refresh music.",
                result.error || "An unknown error occurred."
            );

            return;
        }

        await loadMusicLibrary();

        console.log("Library refreshed:", result.count, "songs");

    } catch (error) {
        console.error("Library refresh error:", error);
    }
}

// ==========================================
// NEONWAVE - LIKED SONGS PAGE
// ==========================================

async function loadLikedSongsPage() {

    const likedList = document.getElementById("liked-song-list");
    const count = document.getElementById("liked-song-count");

    if (!likedList) return;

    likedList.innerHTML = `
        <div class="empty-state">
            <div class="empty-orb">♫</div>
            <h2>Loading liked songs...</h2>
            <p>Getting your favourites.</p>
        </div>
    `;

    try {
        // Ensure the saved liked-song IDs are up to date
        await loadLikedSongIds();

        // Find the existing Liked Songs playlist
        const playlistsResult = await window.pywebview.api.get_playlists();

        if (!playlistsResult.success) {
            throw new Error("Could not load playlists.");
        }

        const likedPlaylist = playlistsResult.playlists.find(
            playlist => playlist.name === "Liked Songs"
        );

        if (!likedPlaylist) {
            throw new Error("Liked Songs playlist was not found.");
        }

        // Load its songs
        const result = await window.pywebview.api.get_playlist_songs(
            likedPlaylist.id
        );

        if (!result.success) {
            throw new Error(result.error || "Could not load liked songs.");
        }

        const songs = result.songs || [];

        count.textContent = `${songs.length} songs`;

        if (songs.length === 0) {
            likedList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-orb heart-orb">♡</div>
                    <h2>Your favourites live here.</h2>
                    <p>Use the plus button on a track to add it to this collection.</p>
                </div>
            `;
            return;
        }

        renderSongs(songs, likedList);

    } catch (error) {

        console.error("Liked Songs page error:", error);

        likedList.innerHTML = `
            <div class="empty-state">
                <div class="empty-orb">!</div>
                <h2>Couldn't load your favourites.</h2>
                <p>${error.message}</p>
            </div>
        `;
    }
}

// ==========================================
// NEONWAVE - ONLINE MUSIC SEARCH
// ==========================================

const onlineSearchForm = document.getElementById(
    "online-search-form"
);

const onlineSearchInput = document.getElementById(
    "online-search-input"
);

const onlineSearchProvider = document.getElementById(
    "online-search-provider"
);

const onlineSearchButton = document.getElementById(
    "online-search-button"
);

const onlineSearchStatus = document.getElementById(
    "online-search-status"
);

const onlineSearchResults = document.getElementById(
    "online-search-results"
);

function providerLabel(provider) {
    return provider === "youtube" ? "video" : "audio";
}

function setSearchCompact(compact) {
    const hero = document.querySelector("#page-discover .discover-hero");
    const panel = document.getElementById("online-search-form");

    if (hero) hero.classList.toggle("is-compact", Boolean(compact));
    if (panel) panel.classList.toggle("is-compact", Boolean(compact));
}

document
    .getElementById("search-expand-button")
    ?.addEventListener("click", () => {
        setSearchCompact(false);
        onlineSearchInput?.focus();
    });


async function searchOnlineMusic(query) {

    if (!pythonReady) {
        onlineSearchStatus.textContent =
            "Connecting to NeonWave...";
        return;
    }

    // A search always returns to the main Discover view.
    setDiscoverDetailVisible(false);

    let selectedProvider = onlineSearchProvider.value;

    onlineSearchButton.disabled = true;
    onlineSearchButton.textContent = "Searching...";

    onlineSearchStatus.textContent =
        `Searching ${providerLabel(selectedProvider)} for music...`;

    onlineSearchResults.innerHTML = "";

    try {

        let result = await window.pywebview.api.search_online_music(
            query,
            selectedProvider
        );

        // If the selected source has no real match, try the other one. This
        // matters for Western artists: JioSaavn often only has karaoke
        // versions, while YouTube has the official recording.
        const hasAnyMatch = response => Boolean(
            response &&
            (
                (response.results || []).length ||
                (response.albums || []).length ||
                (response.artists || []).length
            )
        );

        const hasResults = result.success && hasAnyMatch(result);

        if (!hasResults) {
            const alternate =
                selectedProvider === "jiosaavn" ? "youtube" : "jiosaavn";

            const fallback = await window.pywebview.api.search_online_music(
                query,
                alternate
            );

            if (fallback.success && hasAnyMatch(fallback)) {
                result = fallback;
                selectedProvider = alternate;
                onlineSearchProvider.value = alternate;

                showToast(
                    `Showing ${alternate === "youtube" ? "video" : "audio"} results for the original song`,
                    "info",
                    2400
                );
            } else if (result.only_low_quality) {
                throw new Error(result.error);
            }
        }

        if (!result.success) {
            throw new Error(
                result.error || "Online search failed."
            );
        }

        // Capabilities are only used to decide which action buttons to show.
        // A mismatch here must never hide valid search results.
        let capabilities = {};

        try {
            const capabilityResponse =
                await window.pywebview.api.get_music_provider_capabilities();

            if (
                capabilityResponse &&
                capabilityResponse.capabilities &&
                capabilityResponse.provider === selectedProvider
            ) {
                capabilities = capabilityResponse.capabilities;
            } else {
                capabilities = {
                    search: true,
                    audio_source: false,
                    streaming: selectedProvider !== "youtube",
                    embed_playback: selectedProvider === "youtube",
                };
            }
        } catch (capabilityError) {
            console.warn("Capability lookup failed:", capabilityError);
            capabilities = {
                search: true,
                audio_source: false,
                streaming: selectedProvider !== "youtube",
                embed_playback: selectedProvider === "youtube",
            };
        }

        result.results = await decorateOnlineTracks(result.results || []);
        result.albums = result.albums || [];
        result.artists = result.artists || [];

        lastSearchQuery = query;
        lastSearchProvider = selectedProvider;

        onlineSearchResults.innerHTML = "";

        const heading = document.getElementById("results-heading");
        if (heading) heading.textContent = `Results for “${query}”`;

        if (
            result.results.length === 0 &&
            result.albums.length === 0 &&
            result.artists.length === 0
        ) {

            onlineSearchStatus.textContent =
                "No music found. Try a shorter title or artist name.";

            setSearchCompact(true);

            onlineSearchResults.innerHTML = `
                <div class="empty-state">
                    <div class="empty-orb">⌕</div>
                    <h2>No matches found</h2>
                    <p>Try another spelling, a shorter phrase, or an artist name.</p>
                </div>
            `;

            return;
        }

        const counts = result.counts || {
            songs: result.results.length,
            albums: result.albums.length,
            artists: result.artists.length,
        };

        onlineSearchStatus.textContent =
            `${counts.songs} songs · ${counts.albums} albums · ${counts.artists} artists`;

        setSearchCompact(true);

        document.getElementById("results-section")
            ?.scrollIntoView({ behavior: "smooth", block: "start" });

        playbackQueue = [...result.results];
        renderQueue();

        result.results.forEach(song => {

            const card = document.createElement("div");
            card.className = "online-song-card";

            // THUMBNAIL
            const thumbnail = document.createElement("img");
            thumbnail.className = "online-song-thumbnail";
            thumbnail.alt = song.title;
            thumbnail.loading = "lazy";

            thumbnail.onerror = () => {
                console.error(
                    "THUMBNAIL FAILED:",
                    song.thumbnail
                );

                thumbnail.style.display = "none";
            };

            thumbnail.onload = () => {
                console.log(
                    "THUMBNAIL LOADED:",
                    song.title
                );
            };

            thumbnail.src =
                song.thumbnail_data || song.thumbnail || "";

            // SONG INFORMATION
            const information = document.createElement("div");
            information.className = "online-song-information";

            const title = document.createElement("strong");
            title.textContent = song.title;

            const artist = document.createElement("span");
            artist.textContent = song.artist;

            information.append(title, artist);

            card.append(thumbnail, information);

            if (song.duration) {
                const duration = document.createElement("span");
                duration.className = "online-song-duration";
                duration.textContent = formatTime(song.duration);
                card.append(duration);
            }

            // One clean play control per result. No provider labels or extra
            // action clutter — the whole card is still clickable.
            const actions = document.createElement("div");
            actions.className = "online-song-actions";

            const playButton = document.createElement("button");
            playButton.className = "online-play-button";
            playButton.textContent = "▶";
            playButton.title = `Play ${song.title}`;

            playButton.addEventListener("click", (event) => {
                event.stopPropagation();
                playOnlineSong(song);
            });

            actions.append(
                playButton,
                createTrackLikeButton(song),
                createTrackMenuButton(song, { page: "search" })
            );
            card.appendChild(actions);

            card.addEventListener("click", () => playOnlineSong(song));

            onlineSearchResults.appendChild(card);

        });

        const appendResultShelf = (title, items, kind, subtitleFor, onClick) => {
            if (!items.length) return;

            const section = document.createElement("section");
            section.className = "result-group";

            const heading = document.createElement("div");
            heading.className = "result-group-heading";

            const label = document.createElement("h3");
            label.textContent = title;

            const count = document.createElement("span");
            count.textContent = `${items.length} found`;

            heading.append(label, count);

            const grid = document.createElement("div");
            grid.className = `shelf-grid ${kind}-grid`;

            items.forEach(item => {
                grid.append(createShelfCard({
                    ...item,
                    title: item.title || item.name,
                    subtitle: subtitleFor(item),
                }, kind, () => {
                    detailReturnTo = "search";
                    onClick(item);
                }));
            });

            section.append(heading, grid);
            onlineSearchResults.appendChild(section);
        };

        appendResultShelf(
            "Albums",
            result.albums,
            "album",
            item => item.artist || "Album",
            item => openAlbum(item.id, item.title, item)
        );

        appendResultShelf(
            "Artists",
            result.artists,
            "artist",
            item => formatListeners(item.listeners),
            item => openArtist(item.id, item)
        );

    } catch (error) {

        console.error("Online music search error:", error);

        onlineSearchStatus.textContent =
            error.message || "Something went wrong.";

    } finally {

        onlineSearchButton.disabled = false;
        onlineSearchButton.textContent = "Search";

    }
}


async function loadMusicProviders() {

    if (!pythonReady) return;

    if (!onlineSearchProvider) {
        console.error("Provider selector not found in HTML.");
        return;
    }

    try {

        const data = await window.pywebview.api.get_music_providers();

        if (!data || !Array.isArray(data.providers)) {
            throw new Error("Invalid provider data received.");
        }

        onlineSearchProvider.innerHTML = "";

        const providerLabels = {
            jiosaavn: "Audio",
            youtube: "Video (fallback)"
        };

        data.providers.forEach(name => {

            const option = document.createElement("option");

            option.value = name;
            option.textContent =
                providerLabels[name] ||
                name.charAt(0).toUpperCase() + name.slice(1);

            onlineSearchProvider.appendChild(option);

        });

        // Prefer JioSaavn for full-song playback whenever it is available.
        if (data.providers.includes("jiosaavn")) {
            onlineSearchProvider.value = "jiosaavn";
        } else if (data.active && data.providers.includes(data.active)) {
            onlineSearchProvider.value = data.active;
        } else if (data.providers.length > 0) {
            onlineSearchProvider.value = data.providers[0];
        }

        console.log("Music providers loaded:", data.providers);
        console.log("Active provider:", onlineSearchProvider.value);

    } catch (error) {

        console.error("Provider loading failed:", error);

    }
}

// Search when the form is submitted
onlineSearchForm?.addEventListener("submit", event => {

    event.preventDefault();

    const query = onlineSearchInput.value.trim();

    if (!query) {
        onlineSearchStatus.textContent =
            "Please enter a song or artist name.";
        return;
    }

    searchOnlineMusic(query);

});

// Live search: results appear while typing instead of waiting for a submit.
let liveSearchTimer = null;

onlineSearchInput?.addEventListener("input", () => {

    if (!pythonReady) return;

    clearTimeout(liveSearchTimer);

    const query = onlineSearchInput.value.trim();

    if (query.length < 3) {
        onlineSearchStatus.textContent =
            query ? "Keep typing…" : "";
        return;
    }

    liveSearchTimer = setTimeout(() => searchOnlineMusic(query), 650);
});

onlineSearchProvider?.addEventListener("change", () => {

    const query = onlineSearchInput?.value.trim();

    if (query && query.length >= 3) {
        searchOnlineMusic(query);
    }
});


// ==========================================
// 15. VIDKRAKEN ACCOUNT STATUS
// ==========================================

async function loadVidKrakenStatus() {

    const statusElement = document.getElementById("vidkraken-status");
    const planElement = document.getElementById("vidkraken-plan");
    const downloadsElement = document.getElementById("vidkraken-downloads");
    const bandwidthElement = document.getElementById("vidkraken-bandwidth");
    const errorElement = document.getElementById("vidkraken-error");
    const refreshButton = document.getElementById("refresh-vidkraken");

    if (!statusElement || !refreshButton) {
        console.error("VidKraken panel elements were not found.");
        return;
    }

    refreshButton.disabled = true;
    refreshButton.textContent = "↻ Checking...";
    statusElement.textContent = "Checking...";
    errorElement.style.display = "none";
    errorElement.textContent = "";

    try {

        const result = await getVidKrakenStatus();

        if (!result.success) {
            throw new Error(result.error || "Could not retrieve account status.");
        }

        statusElement.textContent = "Connected";


        planElement.textContent =
            result.plan?.id ?? "Unknown";

        const usage = result.usage || {};

        const downloadQuota = usage.download_count || {};
        const bandwidthQuota = usage.bandwidth_mb || {};

        downloadsElement.textContent =
            downloadQuota.unlimited
                ? `${downloadQuota.used ?? 0} used · Unlimited`
                : `${downloadQuota.used ?? "—"} / ${downloadQuota.granted ?? "—"}`;

        bandwidthElement.textContent =
            bandwidthQuota.unlimited
                ? `${bandwidthQuota.used ?? 0} MB used · Unlimited`
                : `${bandwidthQuota.used ?? "—"} / ${bandwidthQuota.granted ?? "—"} MB`;

    } catch (error) {

        console.error("VidKraken panel error:", error);

        statusElement.textContent = "Unavailable";
        planElement.textContent = "—";
        downloadsElement.textContent = "—";
        bandwidthElement.textContent = "—";

        errorElement.textContent =
            error.message || "Could not connect to VidKraken.";

        errorElement.style.display = "block";

    } finally {

        refreshButton.disabled = false;
        refreshButton.textContent = "↻ Refresh status";

    }
}


// Refresh button
document
    .getElementById("refresh-vidkraken")
    ?.addEventListener("click", loadVidKrakenStatus);


// ==========================================
// 16. QUEUE, VOLUME, TRENDING AND SETTINGS
// ==========================================

function renderQueue() {
    const list = document.getElementById("queue-list");

    if (!list) return;

    list.innerHTML = "";

    if (!playbackQueue.length) {
        list.innerHTML = `
            <div class="empty-state">
                <div class="empty-orb">☷</div>
                <h2>Nothing queued</h2>
                <p>Search for a song or open your library to build a queue.</p>
            </div>
        `;
        return;
    }

    playbackQueue.forEach((song, index) => {
        const row = document.createElement("div");
        row.className = "queue-row";
        row.setAttribute("role", "button");
        row.tabIndex = 0;

        if (trackKey(song) === trackKey(currentSong)) {
            row.classList.add("is-current");
        }

        const number = document.createElement("span");
        number.className = "queue-number";
        number.textContent = index + 1;

        const info = document.createElement("span");
        info.className = "queue-info";

        const title = document.createElement("strong");
        title.textContent = song.title || "Unknown Title";

        const artist = document.createElement("small");
        artist.textContent = song.artist || "Unknown Artist";

        info.append(title, artist);
        row.append(number, info, createSongActions(song, { page: "queue" }));

        row.addEventListener("click", () => playSong(song));

        row.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                playSong(song);
            }
        });

        list.append(row);
    });
}

function addToQueue(song) {
    const exists = playbackQueue.some(
        item => trackKey(item) === trackKey(song)
    );

    if (exists) {
        showToast("Already in the queue", "info", 1600);
        return;
    }

    playbackQueue.push(song);
    renderQueue();
    showToast(`Added ${song.title} to the queue`, "success", 1800);
}

async function saveJiosaavnSong(song, button) {
    if (!button || button.disabled) return;

    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Saving...";

    try {
        const result = await window.pywebview.api
            .download_jiosaavn_track(song.id);

        if (!result || !result.success) {
            throw new Error(
                result?.message || "Could not save this song."
            );
        }

        const previousQueue = [...playbackQueue];

        await loadMusicLibrary();

        playbackQueue = previousQueue;
        renderQueue();

        showToast("Saved to your local library", "success", 2200);
    } catch (error) {
        console.error("Save song error:", error);
        showToast(error.message || "Could not save this song.", "error", 2200);
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

function createTrendingCard(song) {
    const card = document.createElement("div");
    card.className = "trending-card";

    const thumbnail = document.createElement("img");
    thumbnail.className = "trending-thumbnail";
    thumbnail.alt = song.title || "";
    thumbnail.loading = "lazy";
    thumbnail.onerror = () => { thumbnail.style.display = "none"; };
    thumbnail.src = song.thumbnail || "";

    const info = document.createElement("div");
    info.className = "trending-info";

    const title = document.createElement("strong");
    title.textContent = song.title || "Unknown Title";

    const artist = document.createElement("span");
    artist.textContent = song.artist || "Unknown Artist";

    info.append(title, artist);

    const duration = document.createElement("span");
    duration.className = "trending-duration";
    duration.textContent = song.duration ? formatTime(song.duration) : "—";

    const play = document.createElement("button");
    play.className = "trending-play";
    play.textContent = "▶";
    play.title = `Play ${song.title}`;
    play.addEventListener("click", () => {
        playbackQueue = [...jiosaavnTrending];
        renderQueue();
        playOnlineSong(song);
    });

    card.append(thumbnail, info, duration, play);

    // Only JioSaavn tracks can be saved as offline audio files.
    if (song.provider === "jiosaavn") {
        const save = document.createElement("button");
        save.className = "trending-save";
        save.textContent = "↓";
        save.title = "Save to your library";
        save.addEventListener("click", () => saveJiosaavnSong(song, save));

        card.append(save);
    }

    card.append(createSongActions(song, { page: "discover" }));

    return card;
}

function renderTrending() {
    const grid = document.getElementById("jiosaavn-trending");

    if (!grid) return;

    grid.innerHTML = "";

    jiosaavnTrending.forEach(song => {
        grid.append(createTrendingCard(song));
    });
}

async function loadJiosaavnTrending(force = false) {
    const grid = document.getElementById("jiosaavn-trending");

    if (!grid || !pythonReady) return;

    if (jiosaavnTrending.length && !force) {
        renderTrending();
        return;
    }

    grid.innerHTML = `<p class="trending-placeholder">Loading popular tracks…</p>`;

    try {
        const result = await window.pywebview.api.get_mainstream_picks();

        if (!result.success) {
            throw new Error(result.error || "Could not load trending songs.");
        }

        jiosaavnTrending = await decorateOnlineTracks(result.results || []);
        renderTrending();
    } catch (error) {
        console.error("Trending songs error:", error);
        grid.innerHTML = `
            <p class="trending-placeholder">
                Could not load mainstream picks. Check your connection and refresh.
            </p>
        `;
    }
}

function formatListeners(value) {
    const count = Number(value || 0);
    if (!count) return "Artist";
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M listeners`;
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K listeners`;
    return `${count} listeners`;
}

function createShelfCard(item, kind, onClick) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `shelf-card ${kind}-card`;

    const image = document.createElement("img");
    image.className = "shelf-card-image";
    image.alt = item.title || item.name || "";
    image.loading = "lazy";
    image.onerror = () => { image.style.display = "none"; };
    image.src = item.thumbnail || "";

    const body = document.createElement("div");
    body.className = "shelf-card-body";

    const title = document.createElement("strong");
    title.textContent = item.title || item.name || "Unknown";

    const subtitle = document.createElement("span");
    subtitle.textContent = item.subtitle || item.artist || "";

    body.append(title, subtitle);
    card.append(image, body);
    card.addEventListener("click", onClick);

    return card;
}

function renderDiscoveryShelves() {
    if (!jiosaavnDiscovery) return;

    const render = (id, items, kind, subtitleFor, onClick) => {
        const grid = document.getElementById(id);
        if (!grid) return;

        grid.innerHTML = "";

        (items || []).forEach(item => {
            grid.append(createShelfCard(
                {
                    ...item,
                    subtitle: subtitleFor(item),
                },
                kind,
                () => onClick(item)
            ));
        });

        if (!(items || []).length) {
            grid.innerHTML = `<p class="shelf-placeholder">Nothing available right now.</p>`;
        }
    };

    render(
        "jiosaavn-genres",
        jiosaavnDiscovery.genres,
        "genre",
        item => item.subtitle || item.title,
        item => openGenre(item)
    );

    render(
        "jiosaavn-albums",
        jiosaavnDiscovery.albums,
        "album",
        item => item.artist || "Album",
        item => {
            detailReturnTo = "discover";
            openAlbum(item.id, item.title, item);
        }
    );

    render(
        "jiosaavn-artists",
        jiosaavnDiscovery.artists,
        "artist",
        item => formatListeners(item.listeners),
        item => {
            detailReturnTo = "discover";
            openArtist(item.id, item);
        }
    );

    render(
        "jiosaavn-charts",
        jiosaavnDiscovery.charts,
        "chart",
        item => item.subtitle || `${item.count || ""} tracks`,
        item => openCollection(item.token, item.title, item)
    );
}

async function loadJiosaavnDiscovery(force = false) {
    if (!pythonReady) return;

    if (jiosaavnDiscovery && !force) {
        renderDiscoveryShelves();
        return;
    }

    const placeholders = document.querySelectorAll(".shelf-placeholder");
    placeholders.forEach(node => {
        node.textContent = "Loading…";
    });

    try {
        const result = await window.pywebview.api
            .get_jiosaavn_discovery(Boolean(force));

        if (!result.success) {
            throw new Error(result.error || "Could not load Discover.");
        }

        jiosaavnDiscovery = result;
        renderDiscoveryShelves();
    } catch (error) {
        console.error("Discovery shelves error:", error);
        placeholders.forEach(node => {
            node.textContent = "Could not load. Try refreshing.";
        });
    }
}

// ==========================================
// HOME CONTENT + RECENT ROUTINE
// ==========================================

function readRecentRoutine() {
    try {
        const value = JSON.parse(localStorage.getItem(RECENT_ROUTINE_KEY) || "[]");
        return Array.isArray(value) ? value : [];
    } catch (error) {
        return [];
    }
}

function pushRecentRoutine(entry) {
    if (!entry?.id) return;

    const items = readRecentRoutine().filter(
        item => !(item.kind === entry.kind && String(item.id) === String(entry.id))
    );

    items.unshift({
        ...entry,
        seen_at: Date.now(),
    });

    try {
        localStorage.setItem(
            RECENT_ROUTINE_KEY,
            JSON.stringify(items.slice(0, 8))
        );
    } catch (error) {
        console.warn("Could not save recent routine:", error);
    }

    renderRecentRoutine();
}

async function restoreRecentRoutine(entry) {
    if (!entry) return;

    if (entry.kind === "playlist") {
        showPage("playlist");

        try {
            const response = await window.pywebview.api.get_playlists();
            const playlist = (response.playlists || []).find(
                item => String(item.id) === String(entry.id)
            );

            if (playlist) {
                await openPlaylist(playlist);
            }
        } catch (error) {
            console.error("Recent playlist error:", error);
        }
        return;
    }

    showPage("discover");
    detailReturnTo = "home";

    if (entry.kind === "album") {
        openAlbum(entry.id, entry.title, entry);
    } else if (entry.kind === "artist") {
        openArtist(entry.id, entry);
    } else if (entry.kind === "genre") {
        openGenre(entry);
    } else if (entry.kind === "collection") {
        openCollection(entry.token, entry.title, entry);
    }
}

function renderRecentRoutine() {
    const container = document.getElementById("home-recent-routine");
    if (!container) return;

    const items = readRecentRoutine().slice(0, 4);
    container.innerHTML = "";

    if (!items.length) {
        container.innerHTML = `
            <p class="routine-empty">Play a playlist or album and it will appear here.</p>
        `;
        return;
    }

    items.forEach(entry => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "routine-item";

        const art = document.createElement("span");
        art.className = "routine-art";

        if (entry.thumbnail) {
            const image = document.createElement("img");
            image.src = entry.thumbnail;
            image.alt = "";
            image.loading = "lazy";
            image.onerror = () => { image.style.display = "none"; };
            art.appendChild(image);
        } else {
            art.textContent = entry.kind === "artist" ? "♬"
                : entry.kind === "album" ? "◉" : "≋";
        }

        const copy = document.createElement("span");
        copy.className = "routine-copy";

        const title = document.createElement("strong");
        title.textContent = entry.title || "Recently played";

        const subtitle = document.createElement("small");
        subtitle.textContent = entry.subtitle || "Jump back in";

        copy.append(title, subtitle);

        const arrow = document.createElement("span");
        arrow.className = "routine-arrow";
        arrow.textContent = "›";

        button.append(art, copy, arrow);
        button.addEventListener("click", () => restoreRecentRoutine(entry));
        container.appendChild(button);
    });
}

function setGridContent(id, nodes) {
    const grid = document.getElementById(id);
    if (!grid) return;

    grid.innerHTML = "";

    if (!nodes.length) {
        grid.innerHTML = `<p class="shelf-placeholder">Nothing available right now.</p>`;
        return;
    }

    nodes.forEach(node => grid.appendChild(node));
}

function createHomeSongCard(song, tracks) {
    const card = document.createElement("div");
    card.className = "home-song-card";

    const art = document.createElement("div");
    art.className = "home-song-art";
    setArtBackground(art, songArtUrl(song), "♪");

    const info = document.createElement("div");
    info.className = "home-song-info";

    const title = document.createElement("strong");
    title.textContent = song.title || "Unknown Title";

    const artist = document.createElement("small");
    artist.textContent = song.artist || "Unknown Artist";

    info.append(title, artist);

    const play = document.createElement("button");
    play.type = "button";
    play.className = "online-play-button";
    play.textContent = "▶";
    play.title = `Play ${song.title}`;
    play.addEventListener("click", event => {
        event.stopPropagation();
        playbackQueue = [...tracks];
        renderQueue();
        playOnlineSong(song);
    });

    card.append(info, play, createSongActions(song, { page: "home" }));
    card.prepend(art);

    card.addEventListener("click", () => {
        playbackQueue = [...tracks];
        renderQueue();
        playOnlineSong(song);
    });

    return card;
}

function createHomePlaylistCard(playlist) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "home-playlist-card";

    const symbol = document.createElement("span");
    symbol.className = "home-playlist-symbol";
    symbol.textContent = playlist.name === "Liked Songs" ? "♡" : "≋";

    const copy = document.createElement("span");
    copy.className = "home-playlist-copy";

    const title = document.createElement("strong");
    title.textContent = playlist.name;

    const subtitle = document.createElement("small");
    subtitle.textContent = `${playlist.song_count || 0} tracks · Playlist`;

    copy.append(title, subtitle);

    const arrow = document.createElement("b");
    arrow.textContent = "→";

    card.append(symbol, copy, arrow);
    card.addEventListener("click", () => {
        showPage("playlist", playlist);
        openPlaylist(playlist);
    });

    return card;
}

async function renderHomeContent() {
    renderRecentRoutine();

    if (!pythonReady) return;

    if (!jiosaavnDiscovery) {
        try {
            const response = await window.pywebview.api.get_jiosaavn_discovery();
            if (response?.success) jiosaavnDiscovery = response;
        } catch (error) {
            console.warn("Home discovery load failed:", error);
        }
    }

    const discovery = jiosaavnDiscovery || {};

    setGridContent(
        "home-artists",
        (discovery.artists || []).slice(0, 6).map(artist => createShelfCard(
            {
                ...artist,
                title: artist.name || artist.title,
                subtitle: formatListeners(artist.listeners),
            },
            "artist",
            () => {
                detailReturnTo = "home";
                showPage("discover");
                openArtist(artist.id, artist);
            }
        ))
    );

    const latestTracks = await decorateOnlineTracks(
        (discovery.trending || []).slice(0, 6)
    );

    setGridContent(
        "home-latest-songs",
        latestTracks.map(song => createHomeSongCard(song, latestTracks))
    );

    const albums = discovery.albums || [];

    const albumCards = items => items.map(album => createShelfCard(
        { ...album, subtitle: album.artist || "Album" },
        "album",
        () => {
            detailReturnTo = "home";
            showPage("discover");
            openAlbum(album.id, album.title, album);
        }
    ));

    setGridContent("home-albums", albumCards(albums.slice(0, 4)));
    setGridContent("home-other-albums", albumCards(albums.slice(4, 8)));

    try {
        const response = await window.pywebview.api.get_playlists();

        setGridContent(
            "home-recent-playlists",
            (response.playlists || [])
                .slice(0, 4)
                .map(createHomePlaylistCard)
        );
    } catch (error) {
        console.error("Home playlists error:", error);
        setGridContent("home-recent-playlists", []);
    }

    homeContentLoaded = true;
}

async function loadHomeContent(force = false) {
    if (homeContentLoaded && !force) {
        renderRecentRoutine();
        return;
    }

    await renderHomeContent();
}

function setDiscoverDetailVisible(visible) {
    const detail = document.getElementById("discover-detail");
    const shelves = document.getElementById("discover-shelves");
    const trending = document.getElementById("trending-section");
    const results = document.getElementById("results-section");

    [shelves, trending, results].forEach(section => {
        if (!section) return;
        section.classList.toggle("hidden", Boolean(visible));
    });

    if (!detail) return;

    detail.classList.toggle("hidden", !visible);

    if (visible) {
        detail.scrollIntoView({ behavior: "smooth", block: "start" });
    }
}

function showDiscoverDetail(title, subtitle, eyebrow) {
    setDiscoverDetailVisible(true);

    const titleNode = document.getElementById("discover-detail-title");
    const subtitleNode = document.getElementById("discover-detail-subtitle");
    const eyebrowNode = document.getElementById("discover-detail-eyebrow");
    const body = document.getElementById("discover-detail-body");

    if (titleNode) titleNode.textContent = title || "Details";
    if (subtitleNode) subtitleNode.textContent = subtitle || "";
    if (eyebrowNode) eyebrowNode.textContent = eyebrow || "BROWSING";
    if (body) body.innerHTML = "";
}

function createDetailTrackRow(song, index, tracks) {
    const row = document.createElement("div");
    row.className = "detail-track-row";
    row.setAttribute("role", "button");
    row.tabIndex = 0;

    const number = document.createElement("span");
    number.className = "detail-track-number";
    number.textContent = String(index + 1).padStart(2, "0");

    const image = document.createElement("img");
    image.className = "detail-track-image";
    image.alt = song.title || "";
    image.loading = "lazy";
    image.onerror = () => { image.style.display = "none"; };
    image.src = song.thumbnail || "";

    const info = document.createElement("span");
    info.className = "detail-track-info";

    const title = document.createElement("strong");
    title.textContent = song.title || "Unknown Title";

    const artist = document.createElement("small");
    artist.textContent = song.artist || "Unknown Artist";

    info.append(title, artist);

    const duration = document.createElement("span");
    duration.className = "detail-track-duration";
    duration.textContent = song.duration ? formatTime(song.duration) : "—";

    const play = document.createElement("span");
    play.className = "detail-track-play";
    play.textContent = "▶";

    row.append(
        number,
        image,
        info,
        duration,
        play,
        createSongActions(song, { page: "detail" })
    );

    row.addEventListener("click", () => {
        playTrackList(tracks, song);
    });

    row.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            playTrackList(tracks, song);
        }
    });

    return row;
}

function renderDetailTracks(tracks) {
    const body = document.getElementById("discover-detail-body");
    if (!body) return;

    body.innerHTML = "";

    if (!(tracks || []).length) {
        body.innerHTML = `
            <div class="empty-state">
                <div class="empty-orb">♪</div>
                <h2>No tracks available</h2>
                <p>Try another collection or artist.</p>
            </div>
        `;
        return;
    }

    const list = document.createElement("div");
    list.className = "detail-track-list";

    tracks.forEach((song, index) => {
        list.append(createDetailTrackRow(song, index, tracks));
    });

    body.append(list);
}

function playTrackList(tracks, song) {
    const list = tracks || [];
    if (!list.length || !song) return;

    discoverDetailTracks = list;
    playbackQueue = [...list];
    renderQueue();
    playOnlineSong(song);
}

function openTrackDetail(title, subtitle, tracks, eyebrow = "COLLECTION") {
    discoverDetailTracks = tracks || [];
    showDiscoverDetail(title, subtitle, eyebrow);
    renderDetailTracks(discoverDetailTracks);
}

async function openGenre(genre) {
    showDiscoverDetail(genre.title, "Loading genre…", "GENRE");

    pushRecentRoutine({
        kind: "genre",
        id: genre.token,
        token: genre.token,
        title: genre.title,
        subtitle: genre.subtitle || "Curated genre",
        thumbnail: genre.thumbnail || "",
    });

    try {
        const result = await window.pywebview.api
            .get_jiosaavn_genre_tracks(genre.token, 1, 50);

        if (!result.success) {
            throw new Error(result.error || "Could not load this genre.");
        }

        openTrackDetail(
            genre.title,
            genre.subtitle || "Curated tracks",
            await decorateOnlineTracks(result.tracks || []),
            "GENRE"
        );
    } catch (error) {
        showDiscoverDetail(genre.title, error.message, "GENRE");
    }
}

async function openAlbum(albumId, title, album = null) {
    showDiscoverDetail(title, "Loading album…", "ALBUM");

    pushRecentRoutine({
        kind: "album",
        id: albumId,
        title,
        subtitle: album?.artist || "Album",
        thumbnail: album?.thumbnail || "",
    });

    try {
        const result = await window.pywebview.api
            .get_jiosaavn_album(albumId, 50);

        if (!result.success) {
            throw new Error(result.error || "Could not load this album.");
        }

        openTrackDetail(
            title,
            (result.album && result.album.artist) || "Album",
            await decorateOnlineTracks(result.tracks || []),
            "ALBUM"
        );
    } catch (error) {
        showDiscoverDetail(title, error.message, "ALBUM");
    }
}

async function openCollection(token, title, collection = null) {
    showDiscoverDetail(title, "Loading collection…", "COLLECTION");

    pushRecentRoutine({
        kind: "collection",
        id: token,
        token,
        title,
        subtitle: collection?.subtitle || "Collection",
        thumbnail: collection?.thumbnail || "",
    });

    try {
        const result = await window.pywebview.api
            .get_jiosaavn_collection_tracks(token, 1, 50);

        if (!result.success) {
            throw new Error(result.error || "Could not load this collection.");
        }

        openTrackDetail(
            title,
            (result.collection && result.collection.subtitle) || "Chart",
            await decorateOnlineTracks(result.tracks || []),
            "COLLECTION"
        );
    } catch (error) {
        showDiscoverDetail(title, error.message, "COLLECTION");
    }
}

function renderArtistSections(result) {
    const body = document.getElementById("discover-detail-body");
    if (!body) return;

    body.innerHTML = "";

    const artist = result.artist || {};

    const banner = document.createElement("div");
    banner.className = "artist-profile-banner";

    const image = document.createElement("img");
    image.className = "artist-profile-image";
    image.alt = artist.name || "";
    image.onerror = () => { image.style.display = "none"; };
    image.src = artist.thumbnail || "";

    const meta = document.createElement("div");
    meta.className = "artist-profile-meta";

    const name = document.createElement("h3");
    name.textContent = artist.name || "Unknown Artist";

    const stats = document.createElement("p");
    stats.textContent = formatListeners(artist.listeners);

    const bio = document.createElement("p");
    bio.className = "artist-profile-bio";
    bio.textContent = result.bio || "Explore this artist's releases below.";

    meta.append(name, stats, bio);
    banner.append(image, meta);
    body.append(banner);

    const makeSection = (headingText, cards) => {
        if (!(cards || []).length) return;

        const section = document.createElement("div");
        section.className = "detail-section";

        const heading = document.createElement("h3");
        heading.textContent = headingText;
        section.append(heading);

        const grid = document.createElement("div");
        grid.className = "shelf-grid album-grid";

        cards.forEach(card => grid.append(card));
        section.append(grid);
        body.append(section);
    };

    const trackSection = document.createElement("div");
    trackSection.className = "detail-section";

    if ((result.songs || []).length) {
        const heading = document.createElement("h3");
        heading.textContent = "Popular";
        trackSection.append(heading);

        const list = document.createElement("div");
        list.className = "detail-track-list";

        result.songs.forEach((song, index) => {
            list.append(createDetailTrackRow(song, index, result.songs));
        });

        trackSection.append(list);
        body.append(trackSection);
    }

    makeSection(
        "Albums",
        (result.albums || []).map(album => createShelfCard(
            { ...album, subtitle: album.artist || "Album" },
            "album",
            () => openAlbum(album.id, album.title)
        ))
    );

    makeSection(
        "Singles",
        (result.singles || []).map(album => createShelfCard(
            { ...album, subtitle: album.artist || "Single" },
            "album",
            () => openAlbum(album.id, album.title)
        ))
    );

    makeSection(
        "Fans also like",
        (result.similar_artists || []).map(similar => createShelfCard(
            {
                ...similar,
                title: similar.name || similar.title,
                subtitle: formatListeners(similar.listeners),
            },
            "artist",
            () => openArtist(similar.id)
        ))
    );
}

async function openArtist(artistId, artistItem = null) {
    showDiscoverDetail("Artist", "Loading profile…", "ARTIST PROFILE");

    pushRecentRoutine({
        kind: "artist",
        id: artistId,
        title: artistItem?.name || artistItem?.title || "Artist",
        subtitle: formatListeners(artistItem?.listeners),
        thumbnail: artistItem?.thumbnail || "",
    });

    try {
        const result = await window.pywebview.api
            .get_jiosaavn_artist(artistId, 0, 20, "overview");

        if (!result.success) {
            throw new Error(result.error || "Could not load this artist.");
        }

        const artist = result.artist || {};
        discoverDetailTracks = result.songs || [];

        showDiscoverDetail(
            artist.name || "Artist",
            formatListeners(artist.listeners),
            "ARTIST PROFILE"
        );
        renderArtistSections(result);
    } catch (error) {
        showDiscoverDetail("Artist", error.message, "ARTIST PROFILE");
    }
}

document
    .getElementById("discover-detail-back")
    ?.addEventListener("click", () => {
        const returnTo = detailReturnTo;
        detailReturnTo = "discover";

        if (returnTo === "search" && lastSearchQuery) {
            if (onlineSearchInput) onlineSearchInput.value = lastSearchQuery;
            searchOnlineMusic(lastSearchQuery);
            return;
        }

        setDiscoverDetailVisible(false);

        if (returnTo === "home") {
            showPage("home");
            renderHomeContent();
        } else {
            renderDiscoveryShelves();
        }
    });

document
    .getElementById("discover-detail-play")
    ?.addEventListener("click", () => {
        if (discoverDetailTracks.length) {
            playTrackList(discoverDetailTracks, discoverDetailTracks[0]);
        }
    });

document
    .getElementById("refresh-trending")
    ?.addEventListener("click", () => {
        loadJiosaavnTrending(true);
        loadJiosaavnDiscovery(true);
    });

document
    .getElementById("alternate-version-button")
    ?.addEventListener("click", () => {
        if (currentProvider !== "youtube") return;

        youtubeTriedIds.add(currentSong?.id);

        tryNextYouTubeVersion();
    });

document
    .getElementById("queue-button")
    ?.addEventListener("click", () => {
        const panel = document.getElementById("queue-panel");
        if (!panel) return;

        panel.classList.toggle("hidden");
        renderQueue();
    });

document
    .getElementById("close-queue")
    ?.addEventListener("click", () => {
        document.getElementById("queue-panel")?.classList.add("hidden");
    });

const volumeSlider = document.getElementById("volume-slider");

volumeSlider?.addEventListener("input", async () => {
    if (!pythonReady) return;

    try {
        await window.pywebview.api.set_volume(
            Number(volumeSlider.value) / 100
        );
    } catch (error) {
        console.error("Volume error:", error);
    }
});

document
    .getElementById("player-like-button")
    ?.addEventListener("click", event => {
        if (!currentSong) {
            showToast("Play a song first", "info", 1600);
            return;
        }

        handleLikeClick(currentSong, event.currentTarget);
    });

document
    .getElementById("top-search-button")
    ?.addEventListener("click", () => {
        showPage("discover");
        setSearchCompact(false);
        onlineSearchInput?.focus();
    });

document
    .getElementById("choose-folder")
    ?.addEventListener("click", async () => {
        if (!pythonReady) return;

        try {
            const result = await window.pywebview.api.choose_music_folder();

            if (result.cancelled) return;

            if (!result.success) {
                throw new Error(result.message || "Could not choose that folder.");
            }

            musicFolder = result.folder;

            const pathLabel = document.getElementById("music-folder-path");
            if (pathLabel) pathLabel.textContent = musicFolder;

            showToast("Music folder updated", "success", 2000);
            await refreshMusicLibrary();
        } catch (error) {
            console.error("Folder selection error:", error);
            showToast(error.message || "Could not change the music folder.", "error");
        }
    });

document.querySelectorAll(".quick-searches button[data-query]").forEach(button => {
    button.addEventListener("click", () => {
        const query = button.dataset.query;

        if (!query || !onlineSearchInput) return;

        onlineSearchInput.value = query;
        searchOnlineMusic(query);
    });
});

document.querySelectorAll(".tile-play[data-query]").forEach(button => {
    button.addEventListener("click", () => {
        const query = button.dataset.query;

        if (!query) return;

        showPage("discover");

        if (onlineSearchInput) {
            onlineSearchInput.value = query;
            searchOnlineMusic(query);
        }
    });
});
