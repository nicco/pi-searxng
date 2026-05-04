# pi-searxng

Pi agent extension exposing [SearXNG](https://searxng.org) private web search as a tool.
Uses the official SearXNG REST API endpoint `/search?format=json` for structured output.

## Install

```bash
pi install https://github.com/nicco/pi-searxng
```

## Self-Hosting SearXNG

Recommended: copy the example configs into `~/.searxng-config/` and adjust.
The provided presets deliberately **disable ban-prone engines** (Google, Bing,
Yahoo) so your IP stays safe during automated/LLM-powered search bursts.

```bash
mkdir -p ~/.searxng-config
cd $_

cp /path/to/pi-searxng/example-docker-compose.yml  docker-compose.yml
cp /path/to/pi-searxng/example-settings.yml          settings.yml
cp /path/to/pi-searxng/example-limiter.toml          limiter.toml
cp /path/to/pi-searxng/example-env.docker            .env
```

Then fill in whichever API keys you have in `.env` (most work without keys):

### 🔑 API Key reference

| Env var                 | Service                        | Quota (with key)             | How to obtain                                          |
| ----------------------- | ------------------------------ | ---------------------------- | ------------------------------------------------------ |
| `GITHUB_TOKEN`          | GitHub repo wiki search        | **5,000 req/hr** (was 60)    | GitHub → Settings → Developer → Personal Access Tokens |
| `BRAVE_API_KEY`         | Brave Search (general+media)   | **2,000 mo** (free)          | <https://brave.com/search/api/>                        |
| `JINA_API_KEY`          | Jina Reader (page extraction)  | **15,000 credits/mo** (free) | <https://jina.ai/reader/>                              |
| _(skip)_                | DuckDuckGo, Wikipedia, SO      | **unlimited** (open)         | None needed                                            |
| `GOOGLE_API_KEY`        | Google Custom Search (premium) | **~$5/1k queries** (paid)    | Google Cloud Console                                   |
| `GOOGLE_CSE_ID`         | Google Custom Search ID        | pair of above                | Programmable Search Engine dashboard                   |
| `BING_SUBSCRIPTION_KEY` | Azure Cognitive Search         | **~$7/1k queries** (paid)    | Azure Portal → Create Resource                         |

> 💡 Most users only need `GITHUB_TOKEN` (free, instant, massive quota boost).

### Built-in engine summary (pre-selected defaults)

| Engine        | Categories                        | Notes                                     |
| ------------- | --------------------------------- | ----------------------------------------- |
| wikipedia     | general                           | Open API, zero restrictions               |
| wikidata      | general                           | Structured data, zero restrictions        |
| github        | general                           | Code/wiki search, boosted by GITHUB_TOKEN |
| stackexchange | general                           | Includes Stack Overflow                   |
| duckduckgo    | general, images, videos, news, it | Liberal, no signup required               |

Engines like Google, Bing, Brave-news, etc. are **disabled by default**. Uncomment
them in `settings.yml` and supply their respective `_KEY` or `_TOKEN` in `.env` to
activate.

## Configuration

The extension connects to SearXNG over HTTP at port **80** (the default after moving SearXNG onto port 80).

Override with `~/.pi/searxng.json`:

```json
{
  "baseUrl": "http://localhost:8080"
}
```

Layered lookup: env variable `SEARXNG_URL` → `~/.pi/searxng.json` → fallback `http://localhost:8080`.

## Tool

Registers one tool: `searxng_web_search(query, cats, eng, num_results, ...)`

### Parameters

| Param           | Type    | Default      | Description                                                                                             |
| --------------- | ------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| `query`         | string  | _(required)_ | Search query string                                                                                     |
| `cats`          | string  | `"general"`  | SearXNG category: general, images, videos, news, it, science, music, files, map. Comma-sep for multiple |
| `eng`           | string  | _(empty)_    | Filter engines: github, wikipedia, stackoverflow, duckduckgo                                            |
| `num_results`   | number  | `8`          | Max results returned (≤ 50)                                                                             |
| `language`      | string  | _(none)_     | BCP-47 locale code: en, de, fr, es, zh, ja, etc.                                                        |
| `pageno`        | number  | `1`          | Pagination offset                                                                                       |
| `time_range`    | string  | _(none)_     | Recency: day, week, month, year                                                                         |
| `safe_search`   | number  | _(none)_     | Level: 0(off), 1(moderate), 2(strict)                                                                   |
| `onion_version` | boolean | `false`      | Tor route (onion-enabled instances only)                                                                |

Aliases accepted for flexibility: `query` ↔ `q`, `cats` ↔ `category`, `eng` ↔ `engine`, etc.

### Usage Examples

```
# Basic search
searxng_web_search(query="what are Rust lifetime rules", cats="it")

# News / fresh info
searxng_web_search(query="bitcoin price today", cats="news", time_range="day")

# Images & Videos
searxng_web_search(query="funny cat photos", cats="images")
searxng_web_search(query="kubernetes deployment tutorial", cats="videos")

# Restricted to specific engines
searxng_web_search(query="React useEffect cleanup", eng="stackoverflow,wikipedia")
```

## SearXNG Data Model (verified from upstream)

Studied [`searx/result_types/_base.py`](https://github.com/searxng/searxng) to build accurate result parsing. Each result via `as_dict()` carries:

| Field       | Available on    | Description                                     |
| ----------- | --------------- | ----------------------------------------------- |
| `title`     | all             | Link title                                      |
| `url`       | all             | Destination URL                                 |
| `content`   | general/news/it | Snippet/excerpt text (stripped HTML)            |
| `engine`    | all             | Engine name (google, wikipedia, stackoverflow…) |
| `category`  | all             | general, images, videos, news, science, etc.    |
| `template`  | all             | Rendering template (default.html, images.html…) |
| `img_src`   | images/videos   | Primary image URL                               |
| `thumbnail` | images          | Thumbnail URL                                 |
| `views`     | youtube et al.  | View count (e.g. "1.2M")                        |
| `pubdate`   | articles/videos | Published date                                  |
| `source`    | some results    | Source attribution                              |
| `authors`   | articles        | Author list                                     |

---

## Troubleshooting

- **"SearXNG unreachable"** — is your instance running?
  `curl http://localhost:8080/search?format=json&q=test`
- **Bad base URL** — check `~/.pi/searxng.json` or `SEARXNG_URL` env var.
- **Empty results?** — try narrowing categories or increasing `num_results`. Many SearXNG instances return only a handful of results.
