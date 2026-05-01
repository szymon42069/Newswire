

(function () {
  "use strict";

  
  window.imgError = function (img) {
    // If this was a proxied URL, try loading the image directly first
    const src = img.src || img.currentSrc || "";
    if (src.includes("/api/proxy") && !img.dataset.triedDirect) {
      try {
        const directUrl = new URL(src).searchParams.get("url");
        if (directUrl) {
          img.dataset.triedDirect = "1";
          img.referrerPolicy = "no-referrer";
          img.crossOrigin = "anonymous";
          img.src = directUrl;
          return;
        }
      } catch (_) {}
    }
    // Final fallback: show placeholder
    const placeholder = document.createElement("div");
    placeholder.className = "img-placeholder";
    placeholder.innerHTML = placeholderSvg();
    img.replaceWith(placeholder);
  };

  
  function proxyImg(url) {
    if (!url) return null;
    return `/api/proxy?url=${encodeURIComponent(url)}`;
  }

  function proxyThumb(url) {
    if (!url) return null;
    return `/api/proxy?thumb=1&url=${encodeURIComponent(url)}`;
  }


  const state = {
    currentCategory: "top",
    articles: [],
    isLoading: false,
    searchQuery: "",
    lastFetched: null,
    mediaLoading: false,
    mediaProgress: 0,
    mediaToken: 0,
    skipImages: false,
    visibleCount: 18,
  };


  const articleCache = {};
  const READ_KEY = "newswire-read-links";
  const CUSTOM_SOURCES_KEY = "newswire-custom-sources";

  function getReadSet() {
    try { return new Set(JSON.parse(localStorage.getItem(READ_KEY) || "[]")); }
    catch (_) { return new Set(); }
  }

  function articleId(article) {
    return article.link || article.title;
  }

  function isRead(article) {
    return getReadSet().has(articleId(article));
  }

  function markRead(id) {
    if (!id) return;
    const read = getReadSet();
    read.add(id);
    try { localStorage.setItem(READ_KEY, JSON.stringify([...read])); } catch (_) {}
  }


  function getCustomSources() {
    try { return JSON.parse(localStorage.getItem(CUSTOM_SOURCES_KEY) || "[]"); }
    catch (_) { return []; }
  }
  function setCustomSources(list) {
    try { localStorage.setItem(CUSTOM_SOURCES_KEY, JSON.stringify(list)); } catch (_) {}
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
    }[c]));
  }
  function prettyHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch (_) { return url; }
  }
  function renderCustomSources() {
    if (!els.sourcesList) return;
    els.sourcesList.querySelectorAll("li.is-custom").forEach(el => el.remove());
    const list = getCustomSources();
    list.forEach((src, i) => {
      const li = document.createElement("li");
      li.className = "is-custom";
      li.innerHTML =
        `<span class="source-name">${escapeHtml(src.name)}</span>` +
        `<span class="source-url">${escapeHtml(prettyHost(src.url))}</span>` +
        `<button class="source-remove" data-index="${i}" aria-label="Remove ${escapeHtml(src.name)}">&times;</button>`;
      els.sourcesList.appendChild(li);
    });
    els.sourcesList.querySelectorAll(".source-remove").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = +btn.dataset.index;
        const cur = getCustomSources();
        cur.splice(idx, 1);
        setCustomSources(cur);
        renderCustomSources();
        Object.keys(articleCache).forEach(k => delete articleCache[k]);
        loadCategory(state.currentCategory, true);
      });
    });
  }
  function setAddSourceMsg(text, kind) {
    if (!els.addSourceMsg) return;
    els.addSourceMsg.textContent = text || "";
    els.addSourceMsg.className = "add-source-msg" + (kind ? " is-" + kind : "");
  }
  function handleAddSource(e) {
    e.preventDefault();
    const name = (els.addSourceName.value || "").trim();
    const url  = (els.addSourceUrl.value  || "").trim();
    setAddSourceMsg("");
    if (!name || !url) { setAddSourceMsg("Both name and URL are required.", "error"); return; }
    let parsed;
    try { parsed = new URL(url); } catch (_) {
      setAddSourceMsg("Please enter a valid URL.", "error"); return;
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      setAddSourceMsg("URL must start with http:// or https://", "error"); return;
    }
    const list = getCustomSources();
    if (list.some(s => s.url === url)) {
      setAddSourceMsg("That source is already added.", "error"); return;
    }
    list.push({ name, url });
    setCustomSources(list);
    els.addSourceName.value = "";
    els.addSourceUrl.value  = "";
    setAddSourceMsg("Added — fetching now…", "ok");
    renderCustomSources();
    Object.keys(articleCache).forEach(k => delete articleCache[k]);
    loadCategory(state.currentCategory, true).then(() => {
      setAddSourceMsg("Added.", "ok");
      setTimeout(() => setAddSourceMsg(""), 2200);
    });
  }


  const els = {
    contentArea: document.getElementById("content-area"),
    navButtons:  document.querySelectorAll(".nav-item button"),
    searchToggle: document.getElementById("btn-search"),
    searchOverlay: document.getElementById("search-overlay"),
    searchInput:  document.getElementById("search-input"),
    refreshBtn:     document.getElementById("btn-refresh"),
    liveDate:       document.getElementById("live-date"),
    searchClose:    document.getElementById("btn-search-close"),
    sourcesBtn:     document.getElementById("btn-sources"),
    sourcesOverlay: document.getElementById("sources-overlay"),
    sourcesClose:   document.getElementById("sources-close"),
    sourcesList:    document.getElementById("sources-list"),
    addSourceForm:  document.getElementById("add-source-form"),
    addSourceName:  document.getElementById("add-source-name"),
    addSourceUrl:   document.getElementById("add-source-url"),
    addSourceMsg:   document.getElementById("add-source-msg"),
  };



  function timeAgo(timestamp) {
    const now = Date.now() / 1000;
    const diff = now - timestamp;

    if (diff < 60)          return "just now";
    if (diff < 3600)        return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400)       return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 7)   return `${Math.floor(diff / 86400)}d ago`;

    const d = new Date(timestamp * 1000);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  function formatCategoryLabel(cat) {
    const map = {
      top: "Top Stories",
      world: "World",
      business: "Business",
      technology: "Technology",
      science: "Science",
      sport: "Sport",
      uk: "United Kingdom",
    };
    return map[cat] || cat;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function placeholderSvg() {
    return `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" style="opacity:.12">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <path d="M3 9l4-4 4 4 4-6 4 6"/>
      <circle cx="8.5" cy="13.5" r="1.5"/>
    </svg>`;
  }



  function renderHero(article) {
    const id = articleId(article);
    const mediaHtml = renderMedia(article, true);

    return `
      <article class="hero">
        <div class="hero-image">${mediaHtml}</div>
        <div class="hero-body">
          <div>
            <p class="hero-category-label">— ${escapeHtml(formatCategoryLabel(state.currentCategory))}</p>
            <h2 class="hero-title">
              <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener" data-read-id="${escapeHtml(id)}">
                ${escapeHtml(article.title)}
              </a>
            </h2>
            ${article.summary ? `<p class="hero-summary">${escapeHtml(article.summary)}</p>` : ""}
          </div>
          <div class="hero-meta">
            <div style="display:flex;align-items:center;gap:10px;">
              ${article.source ? `<span class="source-tag">${escapeHtml(article.source)}</span>` : ""}
              <span class="time-tag">${timeAgo(article.timestamp)}</span>
            </div>
            <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener" class="read-link" data-read-id="${escapeHtml(id)}">
              ${isRead(article) ? "Read again" : "Read"}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </a>
          </div>
        </div>
      </article>`;
  }
  function renderMedia(article, eager = false) {
  if (article.video) {
    return `
      <video
        class="article-media"
        src="${escapeHtml(proxyImg(article.video))}"
        autoplay muted loop playsinline preload="${eager ? "auto" : "metadata"}"
        poster="${article.image ? escapeHtml(proxyImg(article.image)) : ""}"
        onerror="imgError(this)"
      ></video>`;
  }
  if (article.image) {
    const full = escapeHtml(proxyImg(article.image));
    return `
      <img
        class="article-media progressive-img"
        src="${escapeHtml(proxyThumb(article.image))}"
        data-full-src="${full}"
        alt="" loading="${eager ? "eager" : "lazy"}" referrerpolicy="no-referrer"
        onerror="imgError(this)"
      />`;
  }
  return `<div class="article-media placeholder media-loading">${placeholderSvg()}</div>`;
}
  function renderCard(article, index) {
    const id = articleId(article);
    const mediaHtml = renderMedia(article);

    return `
      <article class="card${isRead(article) ? " is-read" : ""}" style="animation-delay:${index * 55}ms">
        <div class="card-image">${mediaHtml}</div>
        <div class="card-body">
          ${article.source ? `<p class="card-source">${escapeHtml(article.source)}</p>` : ""}
          <h3 class="card-title">
            <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener" data-read-id="${escapeHtml(id)}">
              ${escapeHtml(article.title)}
            </a>
          </h3>
          ${article.summary ? `<p class="card-summary">${escapeHtml(article.summary)}</p>` : ""}
          <div class="card-footer">
            <span class="card-time">${timeAgo(article.timestamp)}</span>
            <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener" class="card-arrow" aria-label="Read article" data-read-id="${escapeHtml(id)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </a>
          </div>
        </div>
      </article>`;
  }

  function renderContent(articles) {
    if (!articles || articles.length === 0) {
      return `<div class="error-state"><h3>Nothing found.</h3><p>Try refreshing or switching categories.</p></div>`;
    }

    
    let filtered = articles;
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      filtered = articles.filter(
        (a) =>
          a.title.toLowerCase().includes(q) ||
          (a.summary && a.summary.toLowerCase().includes(q)) ||
          (a.source && a.source.toLowerCase().includes(q))
      );
    }

    if (filtered.length === 0) {
      return `<div class="article-grid"><p class="no-results">No articles matching "${escapeHtml(state.searchQuery)}"</p></div>`;
    }

    const [hero, ...rest] = filtered;
    const visibleRest = rest.slice(0, Math.max(0, state.visibleCount - 1));
    const gridItems = visibleRest.map((a, i) => renderCard(a, i)).join("");
    const more = filtered.length > state.visibleCount
      ? `<button class="see-more" id="see-more" type="button">See more</button>`
      : "";

    return `
      <div class="content-panel entering">
        ${renderHero(hero)}
        <div class="section-header">
          <span class="section-title">Latest stories</span>
          <span class="section-count">${filtered.length} articles</span>
        </div>
        <div class="article-grid">
          ${gridItems || '<p class="no-results">Only one article today.</p>'}
        </div>
        ${more}
      </div>`;
  }

  function renderLoading() {
    return `<div class="loading-state">
      <div class="loading-spinner"></div>
      <p class="loading-text">Fetching latest stories…</p>
      <button class="media-skip loading-skip" id="media-skip" type="button">Skip images</button>
    </div>`;
  }

  function renderMediaProgress() {
    if (!state.mediaLoading) return "";
    return `<div class="media-progress" aria-label="Loading media">
      <button class="media-skip" id="media-skip" type="button">Skip images</button>
      <span style="width:${state.mediaProgress}%"></span>
    </div>`;
  }

  function renderError(msg) {
    return `<div class="error-state">
      <h3>Couldn't load stories.</h3>
      <p>${escapeHtml(msg || "Unknown error — check your connection.")}</p>
    </div>`;
  }

  
  function revealCards() {
    const cards = els.contentArea.querySelectorAll(".card");
    cards.forEach((card, i) => {
      setTimeout(() => card.classList.add("revealed"), i * 55);
    });
  }

  function upgradeImages() {
    els.contentArea.querySelectorAll("img.progressive-img[data-full-src]").forEach((img) => {
      const full = img.dataset.fullSrc;
      const hi = new Image();
      hi.onload = () => {
        img.src = full;
        img.classList.add("is-full");
        img.removeAttribute("data-full-src");
      };
      hi.onerror = () => {
        // Proxy failed — try direct URL
        if (full.includes("/api/proxy")) {
          try {
            const directUrl = new URL(full, location.href).searchParams.get("url");
            if (directUrl) {
              const hi2 = new Image();
              hi2.referrerPolicy = "no-referrer";
              hi2.crossOrigin = "anonymous";
              hi2.onload = () => {
                img.src = directUrl;
                img.classList.add("is-full");
                img.removeAttribute("data-full-src");
              };
              hi2.src = directUrl;
              return;
            }
          } catch (_) {}
        }
        // Both failed — let onerror on the img element handle it
        img.src = full;
      };
      hi.src = full;
    });
  }


  async function fetchArticles(category) {
    if (articleCache[category]) {
      const { articles, fetchedAt } = articleCache[category];
      const age = Date.now() - fetchedAt;
      if (age < 5 * 60 * 1000) {
       
        return articles;
      }
    }

    const customs = getCustomSources();
    const customParam = customs.length
      ? `&custom=${encodeURIComponent(customs.map(s => s.url).join("|"))}`
      : "";
    const response = await fetch(`/api/news?category=${category}${customParam}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    const data = await response.json();
    articleCache[category] = { articles: data.articles, fetchedAt: Date.now() };
    return data.articles;
  }


  async function loadCategory(category, force = false) {
    if (state.isLoading) return;
    state.isLoading = true;
    state.currentCategory = category;

    
    const existing = els.contentArea.querySelector(".content-panel");
    if (existing) {
      existing.classList.remove("entering");
      existing.classList.add("leaving");
      await new Promise((r) => setTimeout(r, 200));
    }

    els.contentArea.innerHTML = renderLoading();
    document.getElementById("media-skip")?.addEventListener("click", () => {
      state.skipImages = true;
      const btn = document.getElementById("media-skip");
      if (btn) btn.textContent = "Images will load later";
    });

    if (force && articleCache[category]) {
      delete articleCache[category];
    }

    try {
      const articles = await fetchArticles(category);
      state.articles = articles;
      state.lastFetched = Date.now();
      state.visibleCount = 18;
      els.contentArea.innerHTML = renderContent(articles);
      revealCards();
      upgradeImages();
      resolveMedia(category, articles);
    } catch (err) {
      console.error("Fetch error:", err);
      els.contentArea.innerHTML = renderError(err.message);
    } finally {
      state.isLoading = false;
      updateNavActive(category);
    }
  }


  function updateNavActive(category) {
    els.navButtons.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.category === category);
    });
  }

 
  function updateClock() {
    const now = new Date();
    const opts = {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    };
    if (els.liveDate) {
      els.liveDate.textContent = now.toLocaleString("en-GB", opts);
    }
  }


  function openSources() {
    renderCustomSources();
    setAddSourceMsg("");
    els.sourcesOverlay.classList.add("open");
    els.sourcesOverlay.setAttribute("aria-hidden", "false");
  }
  function closeSources() {
    els.sourcesOverlay.classList.remove("open");
    els.sourcesOverlay.setAttribute("aria-hidden", "true");
  }

  function openSearch() {
    els.searchOverlay.classList.add("open");
    setTimeout(() => els.searchInput.focus(), 50);
  }

  function closeSearch() {
    els.searchOverlay.classList.remove("open");
    if (!state.searchQuery) return;
    state.searchQuery = "";
    els.searchInput.value = "";
    els.contentArea.innerHTML = renderContent(state.articles);
    revealCards();
  }


  function bindEvents() {
    els.navButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const cat = btn.dataset.category;
        if (cat === state.currentCategory && !state.isLoading) return;
        loadCategory(cat);
      });
    });


    els.sourcesBtn    && els.sourcesBtn.addEventListener("click", openSources);
    els.sourcesClose  && els.sourcesClose.addEventListener("click", closeSources);
    els.sourcesOverlay && els.sourcesOverlay.addEventListener("click", e => {
      if (e.target === els.sourcesOverlay) closeSources();
    });
    els.addSourceForm && els.addSourceForm.addEventListener("submit", handleAddSource);

    els.searchToggle.addEventListener("click", openSearch);
    els.searchClose && els.searchClose.addEventListener("click", closeSearch);

    els.searchOverlay.addEventListener("click", (e) => {
      if (e.target === els.searchOverlay) closeSearch();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeSearch(); closeSources(); }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        openSearch();
      }
    });


    els.searchInput.addEventListener("input", (e) => {
      state.searchQuery = e.target.value.trim();
      els.contentArea.innerHTML = renderContent(state.articles);
      revealCards();
    });


    els.refreshBtn.addEventListener("click", () => {
      if (state.isLoading) return;
      els.refreshBtn.classList.add("spinning");
      loadCategory(state.currentCategory, true).then(() => {
        els.refreshBtn.classList.remove("spinning");
      });
    });

    els.contentArea.addEventListener("click", (e) => {
      const more = e.target.closest("#see-more");
      if (more) {
        state.visibleCount += 9;
        els.contentArea.innerHTML = renderContent(state.articles);
        revealCards();
        upgradeImages();
        return;
      }
      const link = e.target.closest("[data-read-id]");
      if (!link) return;
      markRead(link.dataset.readId);
      link.closest(".card")?.classList.add("is-read");
    });
  }

  async function resolveMedia(category, articles) {
    const token = ++state.mediaToken;
    state.mediaLoading = true;
    state.mediaProgress = 15;
    try {
      const response = await fetch("/api/media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ articles }),
      });
      state.mediaProgress = 70;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (token !== state.mediaToken) return;
      if (category !== state.currentCategory) return;
      state.articles = data.articles;
      articleCache[category] = { articles: data.articles, fetchedAt: Date.now() };
      state.mediaProgress = 100;
      els.contentArea.innerHTML = renderContent(data.articles);
      revealCards();
      upgradeImages();
    } catch (err) {
      console.warn("Media load failed:", err);
    } finally {
      state.mediaLoading = false;
    }
  }



  function startAutoRefresh() {
    setInterval(() => {
      if (!document.hidden) {
        if (articleCache[state.currentCategory]) {
          delete articleCache[state.currentCategory];
        }
        loadCategory(state.currentCategory);
      }
    }, 5 * 60 * 1000);
  }


  function init() {
    updateClock();
    setInterval(updateClock, 1000);

    bindEvents();
    startAutoRefresh();
    loadCategory("top");
  }


  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();


(function () {
  const THEMES = ['dark', 'light', 'blue', 'newspaper'];
  const KEY = 'newswire-theme';
  const root = document.documentElement;
  const btn = document.getElementById('btn-theme');
  if (!btn) return;

  function setIcon(name) {
    btn.querySelectorAll('svg').forEach(s => s.classList.remove('active'));
    const icon = btn.querySelector('[data-theme-icon="' + name + '"]');
    if (icon) icon.classList.add('active');
  }
  function applyTheme(name) {
    if (name === 'dark') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', name);
    setIcon(name);
    try { localStorage.setItem(KEY, name); } catch (_) {}
  }
  let saved = 'dark';
  try { saved = localStorage.getItem(KEY) || 'dark'; } catch (_) {}
  applyTheme(saved);

  btn.addEventListener('click', () => {
    let current = 'dark';
    try { current = localStorage.getItem(KEY) || 'dark'; } catch (_) {}
    const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];

    const r = btn.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const endR = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y)
    );

    if (!document.startViewTransition) { applyTheme(next); return; }
    const t = document.startViewTransition(() => applyTheme(next));
    t.ready.then(() => {
      document.documentElement.animate({
        clipPath: [
          'circle(0px at ' + x + 'px ' + y + 'px)',
          'circle(' + endR + 'px at ' + x + 'px ' + y + 'px)'
        ]
      }, {
        duration: 600,
        easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
        pseudoElement: '::view-transition-new(root)'
      });
    }).catch(() => {});
  });
})();


(function () {
  const lb      = document.getElementById('lightbox');
  const lbImg   = document.getElementById('lightbox-img');
  const lbClose = document.getElementById('lightbox-close');
  if (!lb || !lbImg || !lbClose) return;

  function open(src) {
    lbImg.src = src;
    lb.classList.add('open');
    lb.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }
  function close() {
    lb.classList.remove('open');
    lb.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    setTimeout(() => { if (!lb.classList.contains('open')) lbImg.src = ''; }, 300);
  }
  document.addEventListener('click', (e) => {
    const img = e.target.closest('.hero-image img, .card-image img, img.article-media');
    if (!img) return;
    e.preventDefault();
    e.stopPropagation();
    open(img.currentSrc || img.src);
  });
  lb.addEventListener('click', (e) => {
    if (e.target === lb || e.target.closest('#lightbox-close')) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lb.classList.contains('open')) close();
  });
})();


(function () {
  const field = document.getElementById('block-field');
  if (!field) return;

  const canvas = document.createElement('canvas');
  field.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let t = 0, raf;

  function resize() {
    canvas.width  = field.offsetWidth  || window.innerWidth;
    canvas.height = field.offsetHeight || 320;
  }
  resize();
  window.addEventListener('resize', resize);

  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const theme = document.documentElement.getAttribute('data-theme');
    if (theme === 'light') {
      const layers = [
        { amp: 28, freq: 0.016, speed: 1.0, yBase: H * 0.52, colors: ['rgba(255,160,60,0.85)', 'rgba(184,81,0,0.9)'] },
        { amp: 18, freq: 0.024, speed: 1.4, yBase: H * 0.65, colors: ['rgba(255,200,100,0.6)', 'rgba(220,110,0,0.7)'] },
        { amp: 12, freq: 0.010, speed: 0.7, yBase: H * 0.42, colors: ['rgba(255,136,38,0.4)', 'rgba(255,180,80,0.5)'] },
      ];

      layers.forEach(layer => {
        ctx.beginPath();
        for (let x = 0; x <= W; x += 3) {
          const y = layer.yBase
            + Math.sin(x * layer.freq + t * layer.speed) * layer.amp
            + Math.sin(x * layer.freq * 1.6 - t * layer.speed * 0.8) * layer.amp * 0.35;
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.lineTo(W, H);
        ctx.lineTo(0, H);
        ctx.closePath();

        const grad = ctx.createLinearGradient(0, layer.yBase - layer.amp, 0, H);
        grad.addColorStop(0, layer.colors[0]);
        grad.addColorStop(1, layer.colors[1]);
        ctx.fillStyle = grad;
        ctx.fill();
      });
      const glow = ctx.createRadialGradient(W/2, H, 0, W/2, H, W * 0.55);
      glow.addColorStop(0, 'rgba(255,140,40,0.18)');
      glow.addColorStop(1, 'transparent');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);
    }

    t += 0.022;
    raf = requestAnimationFrame(draw);
  }

  draw();
})();


// ─── NEWSPAPER DARK: TORN COLLAGE BACKGROUND (inspired by image 1) ────
(function () {
  'use strict';

  let canvas = null, ctx = null, raf = null;
  const clips = [];
  let W = 0, H = 0;

  function isNewspaper() {
    return document.documentElement.getAttribute('data-theme') === 'newspaper';
  }

  // Jagged torn edge path — more segments & rougher for image-1 feel
  function tornPath(w, h, rough) {
    const pts = [], S = 28;
    const rnd = (scale) => (Math.random() - 0.5) * scale;
    // Top edge — very rough (torn from above)
    for (let i = 0; i <= S; i++) {
      const bias = (i > S * 0.3 && i < S * 0.7) ? rough * 1.6 : rough;
      pts.push([w * i / S + rnd(rough * 0.4), rnd(bias)]);
    }
    // Right edge
    for (let i = 1; i <= S; i++) pts.push([w + rnd(rough * 0.7), h * i / S + rnd(rough * 0.4)]);
    // Bottom edge — sometimes cleanly cut (newspaper bottom)
    for (let i = 1; i <= S; i++) pts.push([w - w * i / S + rnd(rough * 0.3), h + rnd(rough * 0.5)]);
    // Left edge
    for (let i = 1; i <= S; i++) pts.push([rnd(rough * 0.7), h - h * i / S + rnd(rough * 0.4)]);
    return pts;
  }

  // Paper tone palette — aged newsprint variants
  const PAPER_TONES = [
    { base: '#f0e8d4', ink: '#1a1510', line: '#2e2618', rule: '#5a5040' }, // warm cream
    { base: '#e8e2d2', ink: '#151210', line: '#28221a', rule: '#504838' }, // cool gray
    { base: '#f2e6c8', ink: '#1c1612', line: '#302818', rule: '#604e36' }, // yellowed
    { base: '#e4dece', ink: '#100e0c', line: '#242018', rule: '#484038' }, // gray
  ];

  function makeClip() {
    // Some clips are big feature pages, some are small torn scraps
    const isBig    = Math.random() > 0.55;
    const isScrap  = Math.random() > 0.82;
    const w = isScrap ? 70  + Math.random() * 100
            : isBig   ? 220 + Math.random() * 200
            :            140 + Math.random() * 180;
    const h = isScrap ? 80  + Math.random() * 120
            : isBig   ? 260 + Math.random() * 220
            :            170 + Math.random() * 220;

    const rough  = 8 + Math.random() * 16;
    const cols   = isScrap ? 1 : 1 + Math.floor(Math.random() * 3);
    const tone   = PAPER_TONES[Math.floor(Math.random() * PAPER_TONES.length)];

    // Photo placement — allow large "portrait" style (like image 1 with the woman's face)
    const hasPhoto   = !isScrap && Math.random() > 0.35;
    const isPortrait = hasPhoto && Math.random() > 0.55; // big photo fills most of page
    const photoX     = isPortrait ? w * 0.05 : w * 0.05 + Math.random() * w * 0.25;
    const photoY     = isPortrait ? h * 0.30 : h * 0.22 + Math.random() * h * 0.12;
    const photoW     = isPortrait ? w * 0.90 : w * 0.38 + Math.random() * w * 0.28;
    const photoH     = isPortrait ? h * 0.60 : h * 0.20 + Math.random() * h * 0.14;

    return {
      x: Math.random() * (W + 500) - 250,
      y: Math.random() * (H + 500) - 250,
      w, h,
      angle:     (Math.random() - 0.5) * 0.72,    // steeper rotation like image 1
      va:        (Math.random() - 0.5) * 0.000018, // imperceptibly slow rotation drift
      vx:        (Math.random() - 0.5) * 0.018,   // very slow drift
      vy:        (Math.random() - 0.5) * 0.012,   // very slow drift
      alpha:     0.14 + Math.random() * 0.20,      // more visible — like image 1
      pts:       tornPath(w, h, rough),
      cols, tone, hasPhoto, isPortrait,
      photoX, photoY, photoW, photoH,
      isScrap,
    };
  }

  function drawClip(c) {
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.angle);

    // ── Drop shadow (deeper, darker — image 1 has dramatic shadows)
    ctx.save();
    ctx.shadowColor    = 'rgba(0,0,0,0.70)';
    ctx.shadowBlur     = 24;
    ctx.shadowOffsetX  = 6;
    ctx.shadowOffsetY  = 10;
    ctx.globalAlpha    = c.alpha;
    ctx.beginPath();
    c.pts.forEach(([px, py], i) => i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py));
    ctx.closePath();
    ctx.fillStyle = c.tone.base;
    ctx.fill();
    ctx.restore();

    // ── Clip to torn-paper shape
    ctx.beginPath();
    c.pts.forEach(([px, py], i) => i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py));
    ctx.closePath();
    ctx.save();
    ctx.clip();
    ctx.globalAlpha = c.alpha;

    // Paper base
    ctx.fillStyle = c.tone.base;
    ctx.fillRect(-8, -8, c.w + 16, c.h + 16);

    // Subtle aging gradient
    const aged = ctx.createLinearGradient(0, 0, c.w * 0.7, c.h);
    aged.addColorStop(0, 'rgba(160,120,50,0.04)');
    aged.addColorStop(0.5, 'rgba(100,80,30,0.0)');
    aged.addColorStop(1, 'rgba(80,60,20,0.10)');
    ctx.fillStyle = aged;
    ctx.fillRect(0, 0, c.w, c.h);

    const pad = c.isScrap ? 6 : 10;
    const { ink, line, rule } = c.tone;

    if (!c.isScrap) {
      // ── Masthead/header bar
      ctx.fillStyle = ink;
      ctx.globalAlpha = c.alpha * 0.95;
      ctx.fillRect(pad, pad, c.w - pad * 2, 11);
      ctx.fillStyle = rule;
      ctx.fillRect(pad, pad + 15, c.w - pad * 2, 1.2);

      // ── Headline (bold block)
      ctx.fillStyle = ink;
      ctx.globalAlpha = c.alpha;
      const hlW = (c.w - pad * 2) * (0.55 + Math.random() * 0.40);
      ctx.fillRect(pad, pad + 20, hlW, 9);
      const hl2W = (c.w - pad * 2) * (0.35 + Math.random() * 0.35);
      if (hl2W > 30) ctx.fillRect(pad, pad + 33, hl2W, 6);
    }

    // ── Photo area (B&W style like image 1)
    if (c.hasPhoto) {
      // Photo background — dark gray like B&W photo
      const photoGrad = ctx.createLinearGradient(c.photoX, c.photoY, c.photoX + c.photoW, c.photoY + c.photoH);
      photoGrad.addColorStop(0, '#a09080');
      photoGrad.addColorStop(0.4, '#c8baa8');
      photoGrad.addColorStop(1, '#786860');
      ctx.fillStyle = photoGrad;
      ctx.globalAlpha = c.alpha * 0.85;
      ctx.fillRect(c.photoX, c.photoY, c.photoW, c.photoH);

      // Simulate a face/portrait (like image 1 with the woman)
      if (c.isPortrait) {
        const cx = c.photoX + c.photoW * 0.5;
        const cy = c.photoY + c.photoH * 0.38;
        const rx = c.photoW * 0.28;
        const ry = c.photoH * 0.30;
        // Hair / head
        ctx.beginPath();
        ctx.ellipse(cx, cy - ry * 0.15, rx * 1.1, ry * 0.55, 0, 0, Math.PI * 2);
        ctx.fillStyle = '#302820';
        ctx.globalAlpha = c.alpha * 0.6;
        ctx.fill();
        // Face oval
        ctx.beginPath();
        ctx.ellipse(cx, cy + ry * 0.15, rx * 0.80, ry * 0.70, 0, 0, Math.PI * 2);
        ctx.fillStyle = '#d4c4b0';
        ctx.globalAlpha = c.alpha * 0.55;
        ctx.fill();
        // Shoulders silhouette
        ctx.beginPath();
        ctx.ellipse(cx, c.photoY + c.photoH * 0.88, rx * 1.5, ry * 0.55, 0, 0, Math.PI);
        ctx.fillStyle = '#282018';
        ctx.globalAlpha = c.alpha * 0.65;
        ctx.fill();
      } else {
        // Abstract photo lines (landscape/building style)
        ctx.globalAlpha = c.alpha * 0.55;
        const photoMid = c.photoY + c.photoH * 0.55;
        ctx.fillStyle = '#202018';
        ctx.fillRect(c.photoX, photoMid, c.photoW, c.photoH * 0.45);
        ctx.fillStyle = '#787060';
        ctx.fillRect(c.photoX, c.photoY, c.photoW, c.photoH * 0.55);
        for (let si = 0; si < 3; si++) {
          const sx = c.photoX + c.photoW * (0.1 + si * 0.28);
          ctx.fillStyle = '#404030';
          ctx.fillRect(sx, photoMid - c.photoH * 0.25, c.photoW * 0.08, c.photoH * 0.28);
        }
      }
      ctx.globalAlpha = c.alpha;
    }

    // ── Text column lines
    const textTop = c.isScrap ? pad + 4 : pad + (c.hasPhoto && !c.isPortrait ? 46 : 48);
    const colGap  = 5;
    const totalW  = c.w - pad * 2;
    const colW    = (totalW - (c.cols - 1) * colGap) / c.cols;

    for (let col = 0; col < c.cols; col++) {
      const cx  = pad + col * (colW + colGap);
      let startY = textTop;

      // Avoid drawing text over photo
      if (c.hasPhoto && !c.isPortrait && col === 0) {
        const photoBottom = c.photoY + c.photoH + 4;
        if (startY < photoBottom) startY = photoBottom;
      }
      if (c.isPortrait) startY = Math.max(startY, c.photoY + c.photoH + 6);

      for (let ly = startY; ly < c.h - pad - 2; ly += 7) {
        const isLast = ly + 7 >= c.h - pad - 2;
        const lw = isLast
          ? colW * (0.2 + Math.random() * 0.55)
          : colW * (Math.random() > 0.09 ? 1 : 0.55 + Math.random() * 0.38);
        ctx.fillStyle = line;
        ctx.globalAlpha = c.alpha * 0.82;
        ctx.fillRect(cx, ly, lw, 2.5);
      }
    }

    // ── Column rule dividers
    for (let col = 1; col < c.cols; col++) {
      const rx2 = pad + col * (colW + colGap) - colGap * 0.5;
      ctx.fillStyle = rule;
      ctx.globalAlpha = c.alpha * 0.4;
      ctx.fillRect(rx2, textTop, 0.8, c.h - textTop - pad - 2);
    }

    // ── Horizontal article divider
    if (!c.isScrap) {
      const divY = c.h * (0.48 + Math.random() * 0.12);
      ctx.fillStyle = rule;
      ctx.globalAlpha = c.alpha * 0.55;
      ctx.fillRect(pad, divY, c.w - pad * 2, 0.9);
    }

    ctx.restore(); // end clip
    ctx.restore(); // end translate+rotate
  }

  function frame() {
    if (!isNewspaper()) { raf = null; return; }
    ctx.clearRect(0, 0, W, H);

    clips.forEach(c => {
      // Ultra-slow drift + imperceptible rotation
      c.x     += c.vx;
      c.y     += c.vy;
      c.angle += c.va;
      // Wrap around viewport with generous margin
      const margin = Math.max(c.w, c.h) + 80;
      if (c.x >  W + margin) c.x = -margin;
      if (c.x < -margin)     c.x =  W + margin;
      if (c.y >  H + margin) c.y = -margin;
      if (c.y < -margin)     c.y =  H + margin;
      drawClip(c);
    });

    raf = requestAnimationFrame(frame);
  }

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    if (canvas) { canvas.width = W; canvas.height = H; }
  }

  function init() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.style.cssText =
      'position:fixed;inset:0;width:100%;height:100%;z-index:1;pointer-events:none;';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
    // 50 clips total: mix of big, medium, scraps
    for (let i = 0; i < 50; i++) clips.push(makeClip());
  }

  function start() {
    if (raf) return;
    init();
    canvas.style.display = 'block';
    frame();
  }

  function stop() {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    if (canvas) canvas.style.display = 'none';
  }

  new MutationObserver(() => isNewspaper() ? start() : stop())
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  if (isNewspaper()) start();
})();


// ─── VIDEO CHOICE MODAL ───────────────────────────────────────
(function () {
  'use strict';

  // Build modal DOM
  const overlay = document.createElement('div');
  overlay.className = 'vmx-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML =
    '<div class="vmx-box">' +
      '<button class="vmx-close" id="vmx-close" aria-label="Close">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
      '</button>' +
      '<p class="vmx-eyebrow">Story media</p>' +
      '<p class="vmx-headline">How would you like to open this?</p>' +
      '<button class="vmx-btn vmx-play" id="vmx-play">' +
        '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' +
        'Play video here' +
      '</button>' +
      '<button class="vmx-btn vmx-link" id="vmx-link">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
        'Go to article website' +
      '</button>' +
    '</div>';
  document.body.appendChild(overlay);

  let pendingVideo = null, pendingHref = null;

  function openModal(video, href) {
    pendingVideo = video;
    pendingHref  = href;
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  // Intercept video clicks (use capture so it fires before other handlers)
  document.addEventListener('click', function (e) {
    const video = e.target.closest('video.article-media, .hero-image video, .card-image video');
    if (!video) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const article = video.closest('article');
    const href = article ? (article.querySelector('a[href]') || {}).href : null;
    openModal(video, href || null);
  }, true);

  document.getElementById('vmx-play').addEventListener('click', function () {
    if (pendingVideo) {
      pendingVideo.muted   = false;
      pendingVideo.controls = true;
      pendingVideo.loop    = false;
      pendingVideo.play().catch(function () {
        pendingVideo.muted = true;
        pendingVideo.play().catch(function () {});
      });
    }
    closeModal();
  });

  document.getElementById('vmx-link').addEventListener('click', function () {
    if (pendingHref) window.open(pendingHref, '_blank', 'noopener noreferrer');
    closeModal();
  });

  document.getElementById('vmx-close').addEventListener('click', closeModal);

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeModal();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeModal();
  });
})();
