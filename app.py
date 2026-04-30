import requests
from bs4 import BeautifulSoup
from concurrent.futures import ThreadPoolExecutor
import re
import time
import logging
from email.utils import parsedate_to_datetime
from flask import Flask, jsonify, render_template, request, Response

import feedparser
try:
    from PIL import Image
except Exception:
    Image = None
from io import BytesIO

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)



RSS_FEEDS = {
    "top": [
        "https://feeds.bbci.co.uk/news/rss.xml",
        "https://feeds.skynews.com/feeds/rss/home.xml",
        "https://www.aljazeera.com/xml/rss/all.xml",
        "https://www.theguardian.com/world/rss",
        "https://feeds.npr.org/1001/rss.xml",
        "https://www.france24.com/en/rss",
        "https://rss.dw.com/rdf/rss-en-all",
        "https://feeds.washingtonpost.com/rss/world",
        "https://news.google.com/rss/topstories?hl=en-GB&gl=GB&ceid=GB:en",
        "https://news.google.com/rss/search?q=site:reuters.com&hl=en-GB&gl=GB&ceid=GB:en",
        "https://news.google.com/rss/search?q=site:ft.com&hl=en-GB&gl=GB&ceid=GB:en",
        "https://news.google.com/rss/search?q=site:c-span.org&hl=en-GB&gl=GB&ceid=GB:en",
    ],
    "uk": [
        "https://feeds.bbci.co.uk/news/uk/rss.xml",
        "https://feeds.skynews.com/feeds/rss/uk.xml",
        "https://www.theguardian.com/uk-news/rss",
        "https://feeds.npr.org/1001/rss.xml",
        "https://news.google.com/rss/headlines/section/topic/NATION?hl=en-GB&gl=GB&ceid=GB:en",
        "https://news.google.com/rss/search?q=site:reuters.com+UK&hl=en-GB&gl=GB&ceid=GB:en",
    ],
    "world": [
        "https://feeds.bbci.co.uk/news/world/rss.xml",
        "https://feeds.skynews.com/feeds/rss/world.xml",
        "https://www.aljazeera.com/xml/rss/all.xml",
        "https://www.theguardian.com/world/rss",
        "https://feeds.npr.org/1004/rss.xml",
        "https://www.france24.com/en/rss",
        "https://rss.dw.com/rdf/rss-en-world",
        "https://feeds.washingtonpost.com/rss/world",
        "https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-GB&gl=GB&ceid=GB:en",
        "https://news.google.com/rss/search?q=site:reuters.com/world&hl=en-GB&gl=GB&ceid=GB:en",
    ],
    "business": [
        "https://feeds.bbci.co.uk/news/business/rss.xml",
        "https://feeds.skynews.com/feeds/rss/business.xml",
        "https://www.theguardian.com/business/rss",
        "https://feeds.npr.org/1006/rss.xml",
        "https://www.france24.com/en/business-tech/rss",
        "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-GB&gl=GB&ceid=GB:en",
        "https://news.google.com/rss/search?q=site:reuters.com/business&hl=en-GB&gl=GB&ceid=GB:en",
        "https://news.google.com/rss/search?q=site:ft.com&hl=en-GB&gl=GB&ceid=GB:en",
    ],
    "technology": [
        "https://feeds.bbci.co.uk/news/technology/rss.xml",
        "https://feeds.skynews.com/feeds/rss/technology.xml",
        "https://www.theguardian.com/uk/technology/rss",
        "https://feeds.npr.org/1019/rss.xml",
        "https://www.france24.com/en/business-tech/rss",
        "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-GB&gl=GB&ceid=GB:en",
        "https://news.google.com/rss/search?q=site:reuters.com/technology&hl=en-GB&gl=GB&ceid=GB:en",
    ],
    "science": [
        "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",
        "https://www.theguardian.com/science/rss",
        "https://feeds.npr.org/1007/rss.xml",
        "https://www.france24.com/en/tag/science/rss",
        "https://news.google.com/rss/headlines/section/topic/SCIENCE?hl=en-GB&gl=GB&ceid=GB:en",
    ],
    "sport": [
        "https://feeds.bbci.co.uk/sport/rss.xml",
        "https://feeds.skynews.com/feeds/rss/sport.xml",
        "https://www.theguardian.com/uk/sport/rss",
        "https://feeds.npr.org/1055/rss.xml",
        "https://news.google.com/rss/headlines/section/topic/SPORTS?hl=en-GB&gl=GB&ceid=GB:en",
    ],
}



_cache: dict = {}
CACHE_TTL = 300  # 5 minutes

_article_cache: dict = {}
ARTICLE_CACHE_TTL = 3600  # 1 hour


def _strip_html(raw: str) -> str:
    import html
    text = re.sub(r"<[^>]+>", "", raw).strip()
    return html.unescape(text)


_SESSION = requests.Session()
_SESSION.headers.update({
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
})


def _scrape_media(url: str) -> dict:
    """Fetch a page and extract og:image / og:video meta tags."""
    result = {"image": None, "video": None, "type": None, "url": url}
    try:
        resp = _SESSION.get(
            url, timeout=8, allow_redirects=True, stream=True,
            headers={"Referer": "https://www.google.com/"},
        )
        if resp.status_code != 200:
            logger.info("Media scrape %d for %s", resp.status_code, url[:80])
            resp.close()
            return result
        result["url"] = resp.url

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
    """Scrape og:image / og:video from the article page if the RSS had none."""
    if not article.get("_needs_resolve", False):
        return article

    url = article["link"]
    now = time.time()
    hit = _article_cache.get(url)
    if hit and isinstance(hit, tuple):
        cached_at, data = hit
        if now - cached_at < ARTICLE_CACHE_TTL:
            article["image"] = data["image"]
            article["video"] = data["video"]
            article["media_type"] = data["type"]
            return article

    media = _scrape_media(url)
    _article_cache[url] = (now, media)
    article["link"] = media.get("url") or article["link"]
    if "news.google.com" in article["link"] or "consent.google.com" in article["link"]:
        article["_drop"] = True
    article["image"] = media["image"]
    article["video"] = media["video"]
    article["media_type"] = media["type"]
    return article



def _parse_entry(entry) -> dict:
    raw_title = entry.get("title", "Untitled")
    source = ""
    title = raw_title
    if " - " in raw_title:
        *parts, source = raw_title.rsplit(" - ", 1)
        title = " - ".join(parts).strip()
        source = source.strip()
    if not source:
        source = entry.get("feed_source", "")

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
        "_needs_resolve": image is None and video is None or "news.google.com" in link,
    }


def _entry_timestamp(entry) -> float:
    try:
        return parsedate_to_datetime(entry.get("published", "")).timestamp()
    except Exception:
        return 0


def _source_key(article: dict) -> str:
    text = f"{article.get('source', '')} {article.get('link', '')}".lower()
    for name in ("bbc", "sky", "aljazeera", "guardian", "npr", "france24", "dw.com", "washingtonpost", "reuters", "ft.com", "c-span"):
        if name in text:
            return name
    return article.get("source", "other") or "other"


def _rank_article(article: dict) -> float:
    source = _source_key(article)
    boosts = {
        "aljazeera": 7200,
        "reuters": 5400,
        "guardian": 3600,
        "france24": 3000,
        "npr": 2400,
        "dw.com": 1800,
        "washingtonpost": 1800,
        "bbc": -3600,
    }
    return article.get("timestamp", 0) + boosts.get(source, 0)


def _fetch_entries_from_url(url: str, per_feed_limit: int) -> list:
    logger.info("Fetching feed: %s", url)
    try:
        feed = feedparser.parse(url)
    except Exception as exc:
        logger.info("Feed failed %s: %s", url, exc)
        return []
    feed_source = feed.feed.get("title", "")
    entries = []
    for e in feed.entries[:per_feed_limit]:
        e["feed_source"] = feed_source
        entries.append(e)
    return entries


def fetch_feed(category: str) -> list:
    now = time.time()
    if category in _cache:
        cached_at, articles = _cache[category]
        if now - cached_at < CACHE_TTL:
            logger.info("Serving '%s' from cache", category)
            return articles

    urls = RSS_FEEDS.get(category, RSS_FEEDS["top"])
    if isinstance(urls, str):
        urls = [urls]

    all_entries = []
    seen_titles = set()
    per_feed_limit = 8 if len(urls) > 3 else 12
    with ThreadPoolExecutor(max_workers=8) as pool:
        feed_results = pool.map(lambda u: _fetch_entries_from_url(u, per_feed_limit), urls)
        for entries in feed_results:
            for e in entries:
                title = e.get("title", "")
                key = title[:60].lower()
                if key not in seen_titles:
                    seen_titles.add(key)
                    all_entries.append(e)

    if not all_entries:
        raise RuntimeError(f"No entries found for '{category}'")

    all_entries.sort(key=_entry_timestamp, reverse=True)
    articles = [_parse_entry(e) for e in all_entries[:60]]
    articles.sort(key=_rank_article, reverse=True)
    counts = {}
    balanced = []
    for a in articles:
        source = _source_key(a)
        limit = 4 if source == "bbc" else 6
        if counts.get(source, 0) >= limit:
            continue
        counts[source] = counts.get(source, 0) + 1
        balanced.append(a)
    articles = balanced[:30]

    for a in articles:
        a.pop("_drop", None)

    _cache[category] = (now, articles)
    return articles


def resolve_media_batch(articles: list) -> list:
    with ThreadPoolExecutor(max_workers=8) as pool:
        resolved = list(pool.map(_resolve_article, articles))
    clean = []
    for a in resolved:
        if a.get("_drop"):
            continue
        a.pop("_needs_resolve", None)
        a.pop("_drop", None)
        clean.append(a)
    return clean




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


@app.route("/api/media", methods=["POST"])
def api_media():
    payload = request.get_json(silent=True) or {}
    articles = payload.get("articles", [])
    if not isinstance(articles, list):
        return jsonify({"error": "articles must be a list"}), 400
    try:
        return jsonify({"articles": resolve_media_batch(articles[:30])})
    except Exception as exc:
        logger.error("Error resolving media: %s", exc)
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
    thumb = request.args.get("thumb") == "1"
    if not url or not url.startswith(("http://", "https://")):
        return "", 400

    now = time.time()
    cache_key = f"proxy:{'thumb:' if thumb else ''}{url}"
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
        if thumb and Image and content_type.startswith("image/"):
            try:
                img = Image.open(BytesIO(data))
                img.thumbnail((480, 270))
                out = BytesIO()
                img.convert("RGB").save(out, format="JPEG", quality=55, optimize=True)
                data = out.getvalue()
                content_type = "image/jpeg"
            except Exception as exc:
                logger.debug("Thumbnail failed for %s: %s", url, exc)
        _article_cache[cache_key] = (now, content_type, data)
        return Response(data, content_type=content_type)
    except Exception as exc:
        logger.debug("Image proxy failed for %s: %s", url, exc)
        return "", 502


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
