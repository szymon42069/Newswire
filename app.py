import re
import time
import logging
from email.utils import parsedate_to_datetime
from flask import Flask, jsonify, render_template, request

# feedparser handles all the RSS heavy lifting
import feedparser

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Feed configuration
# Google News RSS feeds for each category (UK-locale)
# ---------------------------------------------------------------------------
FEEDS = {
    "top": "https://news.google.com/rss?hl=en-GB&gl=GB&ceid=GB:en",
    "world": (
        "https://news.google.com/rss/topics/"
        "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx1YlY4U0FtVm5HZ0pIUWlnQVAB"
        "?hl=en-GB&gl=GB&ceid=GB:en"
    ),
    "business": (
        "https://news.google.com/rss/topics/"
        "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6Y0dGblNBbVZuR2dKSFFpZ0FQAQ"
        "?hl=en-GB&gl=GB&ceid=GB:en"
    ),
    "technology": (
        "https://news.google.com/rss/topics/"
        "CAAqJggKIiBDQkFTRWdvSUwyMHZNR1F3TkRZU0FtVm5HZ0pIUWlnQVAB"
        "?hl=en-GB&gl=GB&ceid=GB:en"
    ),
    "science": (
        "https://news.google.com/rss/topics/"
        "CAAqJggKIiBDQkFTRWdvSUwyMHZNR1ptTlhZU0FtVm5HZ0pIUWlnQVAB"
        "?hl=en-GB&gl=GB&ceid=GB:en"
    ),
    "sport": (
        "https://news.google.com/rss/topics/"
        "CAAqJggKIiBDQkFTRWdvSUwyMHZNR1YxY1hNU0FtVm5HZ0pIUWlnQVAB"
        "?hl=en-GB&gl=GB&ceid=GB:en"
    ),
    "uk": "https://news.google.com/rss/headlines/section/geo/GB?hl=en-GB&gl=GB&ceid=GB:en",
}

# Simple in-memory cache so we're not hammering Google's RSS on every request
_cache: dict = {}
CACHE_TTL = 300  # seconds — 5 minutes feels right


def _strip_html(raw: str) -> str:
    """Very light HTML stripper. feedparser summaries sometimes have tags."""
    return re.sub(r"<[^>]+>", "", raw).strip()


def _parse_entry(entry) -> dict:
    """Turn a feedparser entry into a clean dict."""
    raw_title = entry.get("title", "Untitled")

    # Google News appends "- Source Name" to every headline
    source = ""
    title = raw_title
    if " - " in raw_title:
        *parts, source = raw_title.rsplit(" - ", 1)
        title = " - ".join(parts).strip()
        source = source.strip()

    link = entry.get("link", "#")

    # Published timestamp — fall back to now if parsing fails
    try:
        dt = parsedate_to_datetime(entry.get("published", ""))
        timestamp = dt.timestamp()
    except Exception:
        timestamp = time.time()

    # Summary / description — strip any HTML tags
    raw_summary = entry.get("summary", "") or entry.get("description", "")
    summary = _strip_html(raw_summary)
    if len(summary) > 220:
        summary = summary[:217] + "…"

    # Pull thumbnail if available (not always present in Google News feeds)
    image = None
    media = getattr(entry, "media_content", [])
    for m in media:
        if isinstance(m, dict) and m.get("type", "").startswith("image"):
            image = m.get("url")
            break
    if not image:
        thumbs = getattr(entry, "media_thumbnail", [])
        if thumbs:
            image = thumbs[0].get("url")

    return {
        "title": title,
        "source": source,
        "link": link,
        "timestamp": timestamp,
        "summary": summary,
        "image": image,
    }


def fetch_feed(category: str) -> list:
    """Fetch and cache articles for a given category."""
    now = time.time()

    if category in _cache:
        cached_at, articles = _cache[category]
        if now - cached_at < CACHE_TTL:
            logger.info("Serving '%s' from cache", category)
            return articles

    url = FEEDS.get(category, FEEDS["top"])
    logger.info("Fetching feed: %s", url)

    feed = feedparser.parse(url)

    if feed.bozo and not feed.entries:
        # bozo flag means malformed feed; if we have entries anyway, continue
        raise RuntimeError(f"Failed to parse feed for '{category}'")

    articles = [_parse_entry(e) for e in feed.entries[:30]]
    _cache[category] = (now, articles)
    return articles


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/news")
def api_news():
    category = request.args.get("category", "top").lower()

    if category not in FEEDS:
        return jsonify({"error": f"Unknown category '{category}'"}), 400

    try:
        articles = fetch_feed(category)
        return jsonify({
            "category": category,
            "count": len(articles),
            "articles": articles,
            "cached_until": _cache.get(category, (0,))[0] + CACHE_TTL,
        })
    except Exception as exc:
        logger.error("Error fetching '%s': %s", category, exc)
        return jsonify({"error": str(exc)}), 500


@app.route("/api/status")
def api_status():
    return jsonify({
        "status": "ok",
        "cached_categories": list(_cache.keys()),
        "uptime": time.time(),
    })


if __name__ == "__main__":
    # 0.0.0.0 makes the server reachable from other devices on the same network
    # which is what we need when hosting from a phone
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
