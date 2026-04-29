import requests
from bs4 import BeautifulSoup
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse, parse_qs
import base64

import re
import time
import logging
from email.utils import parsedate_to_datetime
from flask import Flask, jsonify, render_template, request, Response

import feedparser

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)



RSS_FEEDS = {
    "top":        "https://news.google.com/rss?hl=en-GB&gl=GB&ceid=GB:en",
    "uk":         "https://news.google.com/rss/headlines/section/geo/GB?hl=en-GB&gl=GB&ceid=GB:en",
    "world":      "https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-GB&gl=GB&ceid=GB:en",
    "business":   "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-GB&gl=GB&ceid=GB:en",
    "technology": "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-GB&gl=GB&ceid=GB:en",
    "science":    "https://news.google.com/rss/headlines/section/topic/SCIENCE?hl=en-GB&gl=GB&ceid=GB:en",
    "sport":      "https://news.google.com/rss/headlines/section/topic/SPORTS?hl=en-GB&gl=GB&ceid=GB:en",
}



_cache: dict = {}
CACHE_TTL = 300  # 5 minutes

_article_cache: dict = {}
ARTICLE_CACHE_TTL = 3600  # 1 hour


def _strip_html(raw: str) -> str:
    import html
    text = re.sub(r"<[^>]+>", "", raw).strip()
    return html.unescape(text)


# ---------------------------------------------------------------------------
# HTTP session with browser headers + Google consent cookies.
# The SOCS / CONSENT cookies are what was causing every redirect to dead-end
# at consent.google.com instead of continuing to the real article page.
# ---------------------------------------------------------------------------
_SESSION = requests.Session()
_SESSION.headers.update({
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "DNT": "1",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
})
_SESSION.cookies.set(
    "SOCS",
    "CAISHAgCEhJnd3NfMjAyMzA4MDktMF9SQzQaAmVuIAEaBgiA_LSnBg",
    domain=".google.com",
)
_SESSION.cookies.set("CONSENT", "YES+cb", domain=".google.com")


# ---------------------------------------------------------------------------
# URL + media resolution
# ---------------------------------------------------------------------------

def _follow_to_real_url(google_url: str) -> str:
    try:
        if "/rss/articles/" in google_url:
            article_id = google_url.split("/rss/articles/")[-1]
        elif "/articles/" in google_url:
            article_id = google_url.split("/articles/")[-1]
        else:
            return google_url

        article_id = article_id.split("?")[0]
        article_id += "=" * ((4 - len(article_id) % 4) % 4)
        decoded = base64.urlsafe_b64decode(article_id)

        match = re.search(rb"https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+", decoded)
        if match:
            url = match.group(0).decode("utf-8", errors="replace")
            url = re.sub(r"[^\x21-\x7E].*$", "", url)
            if "news.google.com" not in url:
                return url
    except Exception as exc:
        logger.debug("URL decode failed for %s: %s", google_url, exc)

    return google_url


def _scrape_media(url: str) -> dict:
    """Fetch a page and extract og:image / og:video meta tags."""
    result = {"image": None, "video": None, "type": None}
    try:
        resp = _SESSION.get(
            url, timeout=8, allow_redirects=True, stream=True,
            headers={"Referer": "https://www.google.com/"},
        )
        if resp.status_code != 200:
            logger.info("Media scrape %d for %s", resp.status_code, url[:80])
            resp.close()
            return result

        # og:image is always in <head> — read only the first 50 KB
        chunks, size = [], 0
        for chunk in resp.iter_content(chunk_size=8192):
            chunks.append(chunk)
            size += len(chunk)
            if size >= 51200:
                break
        resp.close()
        html = b"".join(chunks).decode("utf-8", errors="replace")
        soup = BeautifulSoup(html, "html.parser")

        for attrs in [
            {"property": "og:video"},
            {"property": "og:video:url"},
            {"property": "og:video:secure_url"},
        ]:
            tag = soup.find("meta", attrs)
            if tag and tag.get("content"):
                result["video"] = tag["content"]
                result["type"] = "video"
                break

        for attrs in [
            {"property": "og:image"},
            {"property": "og:image:url"},
            {"name": "twitter:image"},
            {"name": "twitter:image:src"},
            {"itemprop": "image"},
        ]:
            tag = soup.find("meta", attrs)
            if tag and tag.get("content"):
                result["image"] = tag["content"]
                if not result["type"]:
                    result["type"] = "image"
                break

        if not result["image"]:
            link_tag = soup.find("link", rel="image_src")
            if link_tag and link_tag.get("href"):
                result["image"] = link_tag["href"]
                if not result["type"]:
                    result["type"] = "image"

        logger.info("Scraped %s → image=%s", url[:80], bool(result["image"]))

    except Exception as exc:
        logger.info("Media scrape failed for %s: %s", url[:80], exc)

    return result


def _resolve_article(article: dict) -> dict:
    """
    Two-step resolution for every article:
      1. Unwind the Google News redirect → real publisher URL (updates article['link']).
      2. Scrape og:image / og:video from the real page if the RSS had none.
    Results are cached keyed by the original Google URL.
    """
    original_url = article["link"]
    needs_media = article.get("_needs_resolve", False)

    now = time.time()
    hit = _article_cache.get(original_url)
    if hit and isinstance(hit, tuple) and len(hit) == 2:
        cached_at, data = hit
        if now - cached_at < ARTICLE_CACHE_TTL:
            article["link"] = data["real_url"]
            if needs_media:
                article["image"] = data["image"]
                article["video"] = data["video"]
                article["media_type"] = data["type"]
            return article

    real_url = _follow_to_real_url(original_url)

    media = {"image": None, "video": None, "type": None}
    if needs_media and real_url != original_url:
        media = _scrape_media(real_url)

    data = {
        "real_url": real_url,
        "image": media["image"],
        "video": media["video"],
        "type": media["type"],
    }
    _article_cache[original_url] = (now, data)

    article["link"] = real_url
    if needs_media:
        article["image"] = media["image"]
        article["video"] = media["video"]
        article["media_type"] = media["type"]

    logger.info(
        "Resolved %-48s → %-48s  image=%s",
        original_url[:48],
        real_url[:48],
        bool(media["image"]),
    )
    return article


# ---------------------------------------------------------------------------
# Feed parsing
# ---------------------------------------------------------------------------

def _parse_entry(entry) -> dict:
    raw_title = entry.get("title", "Untitled")
    source = ""
    title = raw_title
    if " - " in raw_title:
        *parts, source = raw_title.rsplit(" - ", 1)
        title = " - ".join(parts).strip()
        source = source.strip()

    link = entry.get("link", "#")

    try:
        dt = parsedate_to_datetime(entry.get("published", ""))
        timestamp = dt.timestamp()
    except Exception:
        timestamp = time.time()

    raw_summary = entry.get("summary", "") or entry.get("description", "")
    summary = _strip_html(raw_summary)
    if len(summary) > 220:
        summary = summary[:217] + "…"

    image = video = media_type = None

    for m in getattr(entry, "media_content", []):
        if isinstance(m, dict):
            mtype = m.get("type", "")
            url = m.get("url")
            if mtype.startswith("video") and not video:
                video, media_type = url, "video"
            elif mtype.startswith("image") and not image:
                image, media_type = url, "image"

    if not image:
        thumbs = getattr(entry, "media_thumbnail", [])
        if thumbs:
            image = thumbs[0].get("url")
            media_type = "image"

    if not image and raw_summary:
        img_tag = BeautifulSoup(raw_summary, "html.parser").find("img")
        if img_tag and img_tag.get("src"):
            image = img_tag["src"]
            media_type = "image"

    return {
        "title": title,
        "source": source,
        "link": link,
        "timestamp": timestamp,
        "summary": summary,
        "image": image,
        "video": video,
        "media_type": media_type,
        "_needs_resolve": image is None and video is None,
    }


def fetch_feed(category: str) -> list:
    now = time.time()
    if category in _cache:
        cached_at, articles = _cache[category]
        if now - cached_at < CACHE_TTL:
            logger.info("Serving '%s' from cache", category)
            return articles

    url = RSS_FEEDS.get(category, RSS_FEEDS["top"])
    logger.info("Fetching feed: %s", url)
    feed = feedparser.parse(url)

    if feed.bozo and not feed.entries:
        raise RuntimeError(f"Failed to parse feed for '{category}'")

    articles = [_parse_entry(e) for e in feed.entries[:30]]

    # Resolve ALL articles in parallel:
    #  • Every article: Google redirect → real publisher URL
    #  • Articles missing media: scrape og:image / og:video from real page
    with ThreadPoolExecutor(max_workers=12) as pool:
        articles = list(pool.map(_resolve_article, articles))

    for a in articles:
        a.pop("_needs_resolve", None)

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
    if category not in RSS_FEEDS:
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


@app.route("/api/proxy")
def image_proxy():
    """
    Proxy images/videos through the server so hotlink-blocking news sites
    don't 403 the browser.  The server request carries browser-like headers
    and the right Referer so most CDNs let it through.
    Usage: /api/proxy?url=https://...
    """
    url = request.args.get("url", "").strip()
    if not url or not url.startswith(("http://", "https://")):
        return "", 400

    now = time.time()
    cache_key = f"proxy:{url}"
    hit = _article_cache.get(cache_key)
    if hit and isinstance(hit, tuple) and len(hit) == 3:
        cached_at, content_type, data = hit
        if now - cached_at < ARTICLE_CACHE_TTL:
            return Response(data, content_type=content_type)

    try:
        parsed = requests.utils.urlparse(url)
        referer = f"{parsed.scheme}://{parsed.netloc}/"
        r = _SESSION.get(url, timeout=6, stream=True, headers={"Referer": referer})
        if r.status_code != 200:
            return "", r.status_code
        content_type = r.headers.get("Content-Type", "image/jpeg")
        data = r.content
        _article_cache[cache_key] = (now, content_type, data)
        return Response(data, content_type=content_type)
    except Exception as exc:
        logger.debug("Image proxy failed for %s: %s", url, exc)
        return "", 502


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)