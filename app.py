import requests
from bs4 import BeautifulSoup
from concurrent.futures import ThreadPoolExecutor
import re
import time
import logging
import json
import threading
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
        "https://www.euronews.com/rss?level=theme&name=news",
        "https://feeds.feedburner.com/time/topstories",
        "https://www.cbsnews.com/latest/rss/main",
        "https://feeds.cbsnews.com/cbsnews/story",
    ],
    "uk": [
        "https://feeds.bbci.co.uk/news/uk/rss.xml",
        "https://feeds.skynews.com/feeds/rss/uk.xml",
        "https://www.theguardian.com/uk-news/rss",
        "https://feeds.npr.org/1001/rss.xml",
        "https://rss.dw.com/rdf/rss-en-all",
    ],
    "world": [
        "https://feeds.bbci.co.uk/news/world/rss.xml",
        "https://feeds.skynews.com/feeds/rss/world.xml",
        "https://www.aljazeera.com/xml/rss/all.xml",
        "https://www.theguardian.com/world/rss",
        "https://feeds.npr.org/1004/rss.xml",
        "https://www.france24.com/en/rss",
        "https://rss.dw.com/rdf/rss-en-world",
        "https://www.euronews.com/rss?level=theme&name=news",
        "https://www.cbsnews.com/latest/rss/world",
    ],
    "business": [
        "https://feeds.bbci.co.uk/news/business/rss.xml",
        "https://feeds.skynews.com/feeds/rss/business.xml",
        "https://www.theguardian.com/business/rss",
        "https://feeds.npr.org/1006/rss.xml",
        "https://www.france24.com/en/business-tech/rss",
        "https://www.euronews.com/rss?level=theme&name=business",
        "https://www.cbsnews.com/latest/rss/moneywatch",
    ],
    "technology": [
        "https://feeds.bbci.co.uk/news/technology/rss.xml",
        "https://feeds.skynews.com/feeds/rss/technology.xml",
        "https://www.theguardian.com/uk/technology/rss",
        "https://feeds.npr.org/1019/rss.xml",
        "https://www.france24.com/en/business-tech/rss",
        "https://www.euronews.com/rss?level=theme&name=next",
    ],
    "science": [
        "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",
        "https://www.theguardian.com/science/rss",
        "https://feeds.npr.org/1007/rss.xml",
        "https://www.france24.com/en/tag/science/rss",
        "https://www.euronews.com/rss?level=theme&name=next",
        "https://rss.dw.com/rdf/rss-en-all",
    ],
    "sport": [
        "https://feeds.bbci.co.uk/sport/rss.xml",
        "https://feeds.skynews.com/feeds/rss/sport.xml",
        "https://www.theguardian.com/uk/sport/rss",
        "https://feeds.npr.org/1055/rss.xml",
        "https://www.euronews.com/rss?level=theme&name=sport",
    ],
}


_cache = {}
CACHE_TTL = 300

_article_cache = {}
ARTICLE_CACHE_TTL = 3600


# strips html tags and unescapes entities - used for summaries
def strip_html(raw):
    import html
    text = re.sub(r"<[^>]+>", "", raw).strip()
    return html.unescape(text)


_SESSION = requests.Session()
_SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
})


def upgrade_cbs_image(url):
    """CBS CDN thumbnails have dimensions in the path like /thumbnail/60x34/ or /60x34/.
    Replace with /original/ to get the full-resolution image."""
    if not url:
        return url
    if "cbsnewsstatic.com" not in url and "cbsistatic.com" not in url and "cbsnews.com" not in url:
        return url
    # e.g. .../thumbnail/60x34/file.jpg  →  .../original/file.jpg
    upgraded = re.sub(r'/thumbnail/\d+x\d+/', '/original/', url)
    if upgraded != url:
        return upgraded
    # e.g. .../r/2024/01/01/guid/60x34/file.jpg  →  .../r/2024/01/01/guid/original/file.jpg
    upgraded = re.sub(r'/(\d{2,4}x\d{2,4})/', '/original/', url)
    return upgraded


def scrape_media(url):
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

        # stop streaming as soon as we've seen og:image — it's always
        # in the <head>, so downloading 200KB is just wasted bandwidth
        OG_MARKERS = [b"og:image", b"twitter:image", b"og:video"]
        chunks, size = [], 0
        for chunk in resp.iter_content(chunk_size=8192):
            chunks.append(chunk)
            size += len(chunk)
            buf_so_far = b"".join(chunks)
            if any(m in buf_so_far for m in OG_MARKERS):
                break
            if size >= 204800:
                break
        resp.close()
        html = b"".join(chunks).decode("utf-8", errors="replace")
        soup = BeautifulSoup(html, "html.parser")

        # NOTE: og:video is intentionally skipped — CBS and others use HLS
        # (.m3u8) streams which browsers can't play natively. Images only.

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

        # fallback: try ld+json structured data
        if not result["image"]:
            for script in soup.find_all("script", type="application/ld+json"):
                try:
                    data = json.loads(script.string or "")
                except Exception:
                    continue
                items = data if isinstance(data, list) else [data]
                for item in items:
                    image = item.get("image") if isinstance(item, dict) else None
                    if isinstance(image, dict):
                        image = image.get("url")
                    elif isinstance(image, list) and image:
                        image = image[0].get("url") if isinstance(image[0], dict) else image[0]
                    if image:
                        result["image"] = image
                        result["type"] = "image"
                        break
                if result["image"]:
                    break

        logger.info("Scraped %s → image=%s", url[:80], bool(result["image"]))

    except Exception as exc:
        logger.info("Media scrape failed for %s: %s", url[:80], exc)

    return result


def resolve_article(article):
    if not article.get("_needs_resolve", False):
        return article

    url = article["link"]
    now = time.time()
    hit = _article_cache.get(url)
    if hit and isinstance(hit, tuple):
        cached_at, data = hit
        if now - cached_at < ARTICLE_CACHE_TTL:
            article["link"] = data.get("url") or article["link"]
            if "news.google.com" in article["link"] or "consent.google.com" in article["link"]:
                article["_drop"] = True
            # only replace if the scrape actually found something — don't
            # clobber a working RSS image just because the page scrape failed
            if data["image"] is not None:
                article["image"] = data["image"]
            elif article.get("_rss_thumb"):
                article["image"] = article["_rss_thumb"]
            if data["video"] is not None:
                article["video"] = data["video"]
            if data["type"] is not None:
                article["media_type"] = data["type"]
            return article

    media = scrape_media(url)
    _article_cache[url] = (now, media)
    article["link"] = media.get("url") or article["link"]
    if "news.google.com" in article["link"] or "consent.google.com" in article["link"]:
        article["_drop"] = True
    if media["image"] is not None:
        article["image"] = media["image"]
    elif article.get("_rss_thumb"):
        # scrape found nothing — use the RSS thumbnail as a last resort
        article["image"] = article["_rss_thumb"]
    if media["video"] is not None:
        article["video"] = media["video"]
    if media["type"] is not None:
        article["media_type"] = media["type"]
    return article


def parse_entry(entry):
    raw_title = entry.get("title", "Untitled")
    source = ""
    title = raw_title
    # google news sticks the source at the end after " - "
    if " - " in raw_title:
        *parts, source = raw_title.rsplit(" - ", 1)
        title = " - ".join(parts).strip()
        source = source.strip()
    if not source:
        source = entry.get("feed_source", "")

    link = entry.get("link", "#")
    if link.startswith("http://www.euronews.com/"):
        link = "https://" + link[len("http://"):]

    try:
        dt = parsedate_to_datetime(entry.get("published", ""))
        timestamp = dt.timestamp()
    except Exception:
        timestamp = time.time()

    raw_summary = entry.get("summary", "") or entry.get("description", "")
    summary = strip_html(raw_summary)
    if len(summary) > 220:
        summary = summary[:217] + "…"

    image = video = media_type = None

    for m in getattr(entry, "media_content", []):
        if isinstance(m, dict):
            mtype = m.get("type", "")
            url = m.get("url")
            # skip video/HLS — browsers can't play them natively
            if mtype.startswith("image") and not image:
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

    # stash CBS's RSS thumbnail as a last-resort fallback only —
    # but first try to upgrade it to full resolution. if the upgrade
    # succeeds, use it as the primary image so we skip page scraping
    # entirely (CBS page scraping is unreliable and returns only one image).
    rss_thumb = None
    raw_rss_img = entry.get("_rss_image") if not image else None
    if raw_rss_img:
        upgraded = upgrade_cbs_image(raw_rss_img)
        if upgraded != raw_rss_img:
            # successfully upgraded → use as real image, no scraping needed
            image = upgraded
            media_type = "image"
        else:
            # could not upgrade → keep as low-res fallback only
            rss_thumb = raw_rss_img

    return {
        "title": title,
        "source": source,
        "link": link,
        "timestamp": timestamp,
        "summary": summary,
        "image": image,
        "video": video,
        "media_type": media_type,
        "_rss_thumb": rss_thumb,
        "_needs_resolve": image is None and video is None or "news.google.com" in link,
    }


def get_entry_timestamp(entry):
    try:
        return parsedate_to_datetime(entry.get("published", "")).timestamp()
    except Exception:
        return 0


def get_source_key(article):
    text = f"{article.get('source', '')} {article.get('link', '')}".lower()
    for name in ("bbc", "sky", "aljazeera", "guardian", "npr", "france24", "euronews", "time", "cbsnews", "dw.com", "washingtonpost", "reuters", "ft.com", "c-span"):
        if name in text:
            return name
    return article.get("source", "other") or "other"


# boost certain sources so they don't get buried by recency alone
# bbc gets a penalty because it dominates otherwise
SOURCE_BOOSTS = {
    "aljazeera": 7200,
    "reuters": 5400,
    "guardian": 3600,
    "france24": 900,
    "npr": 2400,
    "euronews": 2200,
    "cbsnews": 1600,
    "time": 1200,
    "dw.com": 1800,
    "washingtonpost": 1800,
    "bbc": -3600,
}

def rank_article(article):
    source = get_source_key(article)
    return article.get("timestamp", 0) + SOURCE_BOOSTS.get(source, 0)


def fetch_single_feed(url, per_feed_limit):
    logger.info("Fetching feed: %s", url)
    try:
        # fetch raw first so we can pull non-standard elements feedparser misses
        resp = _SESSION.get(url, timeout=12)
        resp.raise_for_status()
        raw_xml = resp.text
        feed = feedparser.parse(raw_xml)
    except Exception as exc:
        logger.info("Feed failed %s: %s", url, exc)
        return []

    # CBS puts image URLs inside a non-standard <image> element per item that
    # feedparser completely ignores. use regex on the raw XML — BeautifulSoup's
    # html.parser treats <image> as a void element (like <img>) and returns
    # None for .string, so it can't be used here.
    guid_to_img = {}
    try:
        for item_xml in re.findall(r"<item>(.*?)</item>", raw_xml, re.DOTALL):
            guid_m = re.search(r"<guid[^>]*>([^<]+)</guid>", item_xml)
            img_m  = re.search(r"<image>([^<\s][^<]*)</image>", item_xml)
            if guid_m and img_m:
                img_url = img_m.group(1).strip()
                if img_url.startswith("http"):
                    img_url = upgrade_cbs_image(img_url)
                    guid_to_img[guid_m.group(1).strip()] = img_url
    except Exception:
        pass

    feed_source = feed.feed.get("title", "")
    entries = []
    for e in feed.entries[:per_feed_limit]:
        e["feed_source"] = feed_source
        guid = e.get("id", "")
        if guid and guid in guid_to_img:
            e["_rss_image"] = guid_to_img[guid]
        entries.append(e)
    return entries


def fetch_feed(category, custom_urls=None):
    custom_urls = list(custom_urls or [])
    cache_key = category if not custom_urls else f"{category}::{'|'.join(sorted(custom_urls))}"
    now = time.time()
    if cache_key in _cache:
        cached_at, articles = _cache[cache_key]
        if now - cached_at < CACHE_TTL:
            logger.info("Serving '%s' from cache", cache_key)
            return articles

    urls = list(RSS_FEEDS.get(category, RSS_FEEDS["top"]))
    urls.extend(custom_urls)
    if isinstance(urls, str):
        urls = [urls]

    all_entries = []
    seen_titles = set()
    per_feed_limit = 8 if len(urls) > 3 else 12

    with ThreadPoolExecutor(max_workers=8) as pool:
        feed_results = pool.map(lambda u: fetch_single_feed(u, per_feed_limit), urls)
        for entries in feed_results:
            for e in entries:
                title = e.get("title", "")
                key = title[:60].lower()
                if key not in seen_titles:
                    seen_titles.add(key)
                    all_entries.append(e)

    if not all_entries:
        raise RuntimeError(f"No entries found for '{category}'")

    all_entries.sort(key=get_entry_timestamp, reverse=True)
    articles = [parse_entry(e) for e in all_entries[:60]]
    articles.sort(key=rank_article, reverse=True)

    # cap how many articles any single source can show - bbc and france24 get fewer
    # because they tend to flood the feed otherwise
    counts = {}
    balanced = []
    for a in articles:
        source = get_source_key(a)
        limit = 3 if source in ("bbc", "france24") else 5
        if counts.get(source, 0) >= limit:
            continue
        counts[source] = counts.get(source, 0) + 1
        balanced.append(a)
    articles = balanced[:45]

    for a in articles:
        a.pop("_drop", None)

    _cache[cache_key] = (now, articles)
    return articles


def resolve_media_batch(articles):
    with ThreadPoolExecutor(max_workers=8) as pool:
        resolved = list(pool.map(resolve_article, articles))
    clean = []
    for a in resolved:
        if a.get("_drop"):
            continue
        a.pop("_needs_resolve", None)
        a.pop("_drop", None)
        a.pop("_rss_thumb", None)
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
    custom_param = request.args.get("custom", "").strip()
    custom_urls = []
    if custom_param:
        for u in custom_param.split("|"):
            u = u.strip()
            if u.startswith(("http://", "https://")):
                custom_urls.append(u)
        custom_urls = custom_urls[:20]
    cache_key = category if not custom_urls else f"{category}::{'|'.join(sorted(custom_urls))}"
    try:
        articles = fetch_feed(category, custom_urls)
        # if any article still needs media resolution (cache miss or custom feed),
        # resolve inline so the response already contains images
        if any(a.get("_needs_resolve") for a in articles):
            articles = resolve_media_batch(articles)
            _cache[cache_key] = (time.time(), articles)
        return jsonify({
            "category": category,
            "count": len(articles),
            "articles": articles,
            "cached_until": _cache.get(cache_key, (0,))[0] + CACHE_TTL,
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
        return jsonify({"articles": resolve_media_batch(articles[:45])})
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


# domain-specific referer overrides — a lot of CDNs reject hotlinks unless
# the Referer matches the main editorial domain rather than the image subdomain.
# built this up over time by just seeing what broke and adding fixes.
# keys can be exact hosts OR base domains (e.g. "cbsnews.com" matches
# "assets2.cbsnewsstatic.com" won't — so list the base cdn domain too)
_REFERER_MAP = {
    "cbsnews.com":             "https://www.cbsnews.com/",
    "cbsnewsstatic.com":       "https://www.cbsnews.com/",
    "cbsistatic.com":          "https://www.cbsnews.com/",
    "cnn.com":                 "https://www.cnn.com/",
    "abcnews.go.com":          "https://abcnews.go.com/",
    "abcnewsfe.com":           "https://abcnews.go.com/",
    "nytimes.com":             "https://www.nytimes.com/",
    "politico.com":            "https://www.politico.com/",
    "apnews.com":              "https://apnews.com/",
    "storage.googleapis.com":  None,  # no referer needed for gcs
}

def get_referer(host, scheme):
    """Check exact host first, then fall back to base-domain suffix matching."""
    if host in _REFERER_MAP:
        return _REFERER_MAP[host]
    for base, ref in _REFERER_MAP.items():
        if host.endswith("." + base):
            return ref
    return f"{scheme}://{host}/"

@app.route("/api/proxy")
def image_proxy():
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
        host = parsed.netloc.lower()
        referer = get_referer(host, parsed.scheme)
        extra = {"Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"}
        if referer:
            extra["Referer"] = referer
        r = _SESSION.get(url, timeout=6, stream=True, headers=extra)
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


def _prewarm():
    """Fetch and fully resolve media for all categories at startup so the
    first page load has images ready immediately rather than trickling in."""
    # small delay so the server is fully up before we hammer feeds
    time.sleep(2)
    for cat in RSS_FEEDS:
        try:
            logger.info("Pre-warming category '%s'…", cat)
            articles = fetch_feed(cat)
            resolved = resolve_media_batch(articles)
            # write resolved articles (with images) back into the cache so
            # /api/news serves them directly — no second /api/media round-trip needed
            _cache[cat] = (time.time(), resolved)
            logger.info("Pre-warm done for '%s': %d articles", cat, len(resolved))
        except Exception as exc:
            logger.warning("Pre-warm failed for '%s': %s", cat, exc)


threading.Thread(target=_prewarm, daemon=True).start()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)