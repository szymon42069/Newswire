# Newswire

A live news dashboard I put together over a few evenings and weeks throughout my breaks. It pulls headlines from Google News RSS feeds across several categories, serves them through a small Flask API, and displays everything in a dark editorial UI with smooth transitions between sections.

I built this mostly to have a cleaner alternative to opening a dozen news tabs in the morning rather than going through the clunky and over-packed UI that Google News has — and partly because I wanted a project that actually ran live on hardware I already owned (my phone). 

---

## What it does

- Web scrapes headlines from Google News across seven categories: Top, Country of coice, World, Business, Technology, Science, and Sport (You get to pick which categories you would like, but can change them at any time)
- Caches each feed for 5 minutes so it's not crashing the RSS endpoints on every page load
- A small JSON API (`/api/news?category=<name>`) that the frontend replies
- Renders articles with a featured hero card + responsive grid layout
- Smooth animated transitions when you switch categories
- Real-time search that filters the current feed client-side
- Auto-refreshes every 5 minutes if the tab is open

## Stack

- **Backend:** Python + Flask
- **Parsing:** feedparser (handles RSS edge cases cleanly)
- **Frontend:** Vanilla HTML / CSS / JS — no frameworks, no build step
- **Fonts:** Fraunces + Lora via Google Fonts

## Running it locally

```bash
git clone https://github.com/szymon42069/briefing.git
cd briefing

pip install -r requirements.txt
python app.py
```

Then open `http://localhost:5000`.

## Running it from a phone (Android / Termux)

This is the fun part. I usually run it of my phone as a local server on my home Wi-Fi. I will try to add the ability to not have to port-forward your router to allow it to run on any network.

1. Install [Termux](https://f-droid.org/packages/com.termux/) from F-Droid (not the Play Store version, it's outdated, and YOU CANT DOWNLOAD PKG'S)
2. Clone the repo inside of Termux, or just copy the files across by downloading the source
3. Run the setup script:

```bash
bash setup_termux.sh
```

4. Start the server:

```bash
python app.py
```

5. Find out what your phone's local IP address (Settings → Wi-Fi → tap your network → IP address), then visit `http://<phone-ip>:5000` from any browser thats on the same Wi-Fi network.

It works surprisingly alright. My phone sits on charge on my desk and the server just runs in the background within Termux.

## Project structure

```
briefing/
├── app.py              # Flask backend, RSS fetching, caching
├── requirements.txt
├── setup_termux.sh     # One-shot setup for Termux/Android
├── templates/
│   └── index.html      # Main page template
└── static/
    ├── style.css        # All styling — dark editorial design
    └── app.js          # Frontend logic, rendering, transitions
```

## API

The backend exposes two endpoints:

| Endpoint | Description |
|---|---|
| `GET /api/news?category=<name>` | Returns up to 30 articles for the given category |
| `GET /api/status` | Returns server status and which categories are currently cached |

Valid categories: `top`, `uk`, `world`, `business`, `technology`, `science`, `sport`

Example response:

```json
{
  "category": "technology",
  "count": 28,
  "articles": [
    {
      "title": "Article headline here",
      "source": "The Guardian",
      "link": "https://...",
      "timestamp": 1714000000,
      "summary": "Short summary text...",
      "image": "https://... or null"
    }
  ]
}
```

## A few things I ran into

**Images:** Google News RSS doesn't always include thumbnail URLs — some feeds have `media:content` elements, some have `media:thumbnail`, and some have neither. I check for both and fall back to a SVG if nothing's available. So i will have to try and to implement a way to allow for images to be seen/viewed

**Phone battery:** Termux keeps the server alive pretty reliably if you disable battery optimisation for the app (Android → Settings → Battery → Termux → Unrestricted). I'm gonna try to as well try to improve the battery optimisation.

## Potential improvements

- Add support for the Financial Times RSS feeds, they have topic-specific ones for subscribers, so you will have to provide your login details or token. Don't you worry though because this will be stored locally.
- Persist a read/unread state in localStorage
- Add a dark/light theme toggle
- Package it as a small systemd service so it starts automatically for Linux users (like me hehe)

- Im also planning to add a source button too, that you can select sources you like to hear from and don't.
- Maybe even possibly turning it into a apk or ipa for phones that will be available to download from the App Store/Google/Play Store.
- Also, im planning to add these websites too and add a specific filter onto them, so that you can select what source you want such as...
- Al Jazeera English (AJE)
- The Financial Times (For Economics)
- Reuters
- The Guardian
- C-SPAN (Politics)



## Licence

MIT — do whatever you like with it.
