/* =============================================================
   Newswire — app.js
   Handles: data fetching, rendering, category switching,
            search, live clock, staggered card reveals.
   ============================================================= */

(function () {
  "use strict";

  /* ----------------------------------------------------------
     Global image-error handler — called via onerror="imgError(this)"
     Replaces the broken <img> (or its parent wrapper) with a
     placeholder div so we never get a broken-image icon.
  ---------------------------------------------------------- */
  window.imgError = function (img) {
    const placeholder = document.createElement("div");
    placeholder.className = "img-placeholder";
    placeholder.innerHTML = placeholderSvg();
    img.replaceWith(placeholder);
  };

  /* Route all images/videos through the server proxy.
     This lets our server fetch with proper browser-like headers so
     hotlink-blocking news site CDNs don't 403 the browser directly. */
  function proxyImg(url) {
    if (!url) return null;
    return `/api/proxy?url=${encodeURIComponent(url)}`;
  }


  const state = {
    currentCategory: "top",
    articles: [],
    isLoading: false,
    searchQuery: "",
    lastFetched: null,
  };


  const articleCache = {};


  const els = {
    contentArea: document.getElementById("content-area"),
    navButtons:  document.querySelectorAll(".nav-item button"),
    searchToggle: document.getElementById("btn-search"),
    searchOverlay: document.getElementById("search-overlay"),
    searchInput:  document.getElementById("search-input"),
    refreshBtn:   document.getElementById("btn-refresh"),
    liveDate:     document.getElementById("live-date"),
    searchClose:  document.getElementById("btn-search-close"),
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
    const imageHtml = article.image
      ? `<img src="${escapeHtml(proxyImg(article.image))}" alt="" loading="eager" referrerpolicy="no-referrer" onerror="imgError(this)"/>`
      : `<div class="img-placeholder">${placeholderSvg()}</div>`;

    return `
      <article class="hero">
        <div class="hero-image">${imageHtml}</div>
        <div class="hero-body">
          <div>
            <p class="hero-category-label">— ${escapeHtml(formatCategoryLabel(state.currentCategory))}</p>
            <h2 class="hero-title">
              <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener">
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
            <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener" class="read-link">
              Read
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </a>
          </div>
        </div>
      </article>`;
  }
  function renderMedia(article) {
  if (article.video) {
    return `
      <video
        class="article-media"
        src="${escapeHtml(proxyImg(article.video))}"
        autoplay muted loop playsinline preload="metadata"
        onerror="imgError(this)"
      ></video>`;
  }
  if (article.image) {
    return `
      <img
        class="article-media"
        src="${escapeHtml(proxyImg(article.image))}"
        alt="" loading="lazy"
        onerror="imgError(this)"
      />`;
  }
  return `<div class="article-media placeholder"></div>`;
}
  function renderCard(article, index) {
    const imageHtml = article.image
      ? `<img src="${escapeHtml(proxyImg(article.image))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="imgError(this)"/>`
      : `<div class="img-placeholder">${placeholderSvg()}</div>`;

    return `
      <article class="card" style="animation-delay:${index * 55}ms">
        <div class="card-image">${imageHtml}</div>
        <div class="card-body">
          ${article.source ? `<p class="card-source">${escapeHtml(article.source)}</p>` : ""}
          <h3 class="card-title">
            <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener">
              ${escapeHtml(article.title)}
            </a>
          </h3>
          ${article.summary ? `<p class="card-summary">${escapeHtml(article.summary)}</p>` : ""}
          <div class="card-footer">
            <span class="card-time">${timeAgo(article.timestamp)}</span>
            <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener" class="card-arrow" aria-label="Read article">
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
    const gridItems = rest.map((a, i) => renderCard(a, i)).join("");

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
      </div>`;
  }

  function renderLoading() {
    return `<div class="loading-state">
      <div class="loading-spinner"></div>
      <p class="loading-text">Fetching latest stories…</p>
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


  async function fetchArticles(category) {
    if (articleCache[category]) {
      const { articles, fetchedAt } = articleCache[category];
      const age = Date.now() - fetchedAt;
      if (age < 5 * 60 * 1000) {
       
        return articles;
      }
    }

    const response = await fetch(`/api/news?category=${category}`);
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

    if (force && articleCache[category]) {
      delete articleCache[category];
    }

    try {
      const articles = await fetchArticles(category);
      state.articles = articles;
      state.lastFetched = Date.now();
      els.contentArea.innerHTML = renderContent(articles);
      revealCards();
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
    };
    if (els.liveDate) {
      els.liveDate.textContent = now.toLocaleString("en-GB", opts);
    }
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


    els.searchToggle.addEventListener("click", openSearch);
    els.searchClose && els.searchClose.addEventListener("click", closeSearch);

    els.searchOverlay.addEventListener("click", (e) => {
      if (e.target === els.searchOverlay) closeSearch();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeSearch();
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
    setInterval(updateClock, 30000);

    bindEvents();
    startAutoRefresh();
    loadCategory("top");
  }


  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
<<<<<<< HEAD
})();
=======
})();

/* =========================================================
   THEME TOGGLE — dark → light → blue, with a circular
   reveal that expands from the button.
   ========================================================= */
(function () {
  const THEMES = ['dark', 'light', 'blue'];
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

/* =========================================================
   IMAGE LIGHTBOX — click any article image to enlarge.
   ========================================================= */
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

/* =========================================================
   WAVE CANVAS — smooth orange ripple sine wave (light theme).
   Uses requestAnimationFrame + canvas for a real wave shape.
   ========================================================= */
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
      // Three layered sine waves, each filled down to bottom
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

      // Soft glow overlay at the bottom center
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
>>>>>>> master
