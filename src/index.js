import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

try { process.loadEnvFile(); } catch { /* .env is optional; env vars may come from the shell or Docker */ }

// ─── Queue ────────────────────────────────────────────────────────────────────

class SearchQueue {
  #queue = [];
  #running = false;
  #nextAllowedAt = 0;
  #delayMin;
  #delayMax;

  constructor(delayMin, delayMax) {
    this.#delayMin = delayMin;
    this.#delayMax = delayMax;
  }

  static #delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  static #randomMs(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  enqueue(fn) {
    return new Promise((resolve, reject) => {
      const depth = this.#queue.length;
      console.log(`[queue] enqueued${depth > 0 ? `, ${depth + 1} waiting` : ''}`);
      this.#queue.push({ fn, resolve, reject });
      if (!this.#running) this.#drain();
    });
  }

  async #drain() {
    this.#running = true;
    while (this.#queue.length > 0) {
      const wait = this.#nextAllowedAt - Date.now();
      if (wait > 0) {
        console.log(`[queue] rate-limit delay: ${(wait / 1000).toFixed(1)}s`);
        await SearchQueue.#delay(wait);
      }

      const task = this.#queue.shift();
      try {
        task.resolve(await task.fn());
      } catch (e) {
        task.reject(e);
      }
      this.#nextAllowedAt = Date.now() + SearchQueue.#randomMs(this.#delayMin, this.#delayMax);
    }
    this.#running = false;
  }
}

// ─── Server pool ──────────────────────────────────────────────────────────────

function createServerPool(urls, delayMin, delayMax) {
  const servers = urls.map((url) => ({ url, queue: new SearchQueue(delayMin, delayMax) }));
  let rrIndex = 0;

  return {
    servers,
    nextIndex() {
      const index = rrIndex;
      rrIndex = (rrIndex + 1) % servers.length;
      return index;
    },
  };
}

// ─── SearXNG client ───────────────────────────────────────────────────────────

function formatResults(data, pageno) {
  const out = { pageno };

  if (data.answers?.length) {
    out.answers = data.answers.map(({ answer, url }) => ({ answer, url }));
  }

  if (data.infoboxes?.length) {
    out.knowledge_panels = data.infoboxes.map(({ infobox, content, urls, attributes }) => ({
      infobox,
      content,
      urls: urls?.map(({ title, url }) => ({ title, url })),
      attributes: attributes?.map(({ label, value }) => ({ label, value })),
    }));
  }

  out.results = data.results.map(({ title, url, content, publishedDate, engines, score }) => ({
    title,
    url,
    content,
    ...(publishedDate && { publishedDate }),
    found_by_engines: engines,
    relevance_score: score,
  }));

  if (data.suggestions?.length) {
    out.suggestions = data.suggestions;
  }

  return out;
}

async function fetchSearch(serverUrl, query, pageno) {
  const url = new URL('/search', serverUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('pageno', String(pageno));
  const abort = new AbortController();
  const timer = setTimeout(() => {
    console.warn(`[searxng] (${serverUrl}) timeout: "${query}"`);
    abort.abort();
  }, 10_000);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: abort.signal });
    if (!res.ok) throw new Error(`SearXNG ${res.status}: ${res.statusText}`);
    const data = formatResults(await res.json(), pageno);
    console.log(
      `[searxng] (${serverUrl}) "${query}" ${data.results.length} results @ page ${pageno} in ${Date.now() - t0}ms`,
    );
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithFallback(pool, query, pageno) {
  const startIndex = pool.nextIndex();

  for (let i = 0; i < pool.servers.length; i++) {
    const server = pool.servers[(startIndex + i) % pool.servers.length];
    const tryNext = i + 1 < pool.servers.length ? ', trying next' : '';
    try {
      const result = await server.queue.enqueue(() => fetchSearch(server.url, query, pageno));
      if (result.results?.length > 0) return result;
      console.warn(`[searxng] (${server.url}) "${query}" returned 0 results${tryNext}`);
    } catch (err) {
      console.error(`[searxng] (${server.url}) error: ${err.message}${tryNext}`);
    }
  }

  throw new Error('All SearXNG servers failed or returned empty results');
}

// ─── Output schema ────────────────────────────────────────────────────────────

const SearchOutputSchema = z.object({
  pageno: z.number(),
  answers: z
    .array(z.object({ answer: z.string(), url: z.string().optional() }))
    .optional(),
  knowledge_panels: z
    .array(
      z.object({
        infobox: z.string(),
        content: z.string().optional(),
        urls: z.array(z.object({ title: z.string(), url: z.string() })).optional(),
        attributes: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
      }),
    )
    .optional(),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      content: z.string().optional(),
      publishedDate: z.string().optional(),
      found_by_engines: z.array(z.string()),
      relevance_score: z.number().optional(),
    }),
  ),
  suggestions: z.array(z.string()).optional(),
});

// ─── MCP server ───────────────────────────────────────────────────────────────

function createServer(pool) {
  const server = new McpServer({
    name: 'searxng-mcp',
    version: '1.0.0',
    instructions:
      'Use the search tool to find up-to-date information on the web. ' +
      'Prefer concise queries. Use pageno to paginate through results when the first page is insufficient.',
  });

  server.registerTool(
    'search',
    {
      title: 'Web Search',
      description:
        'Search the web via SearXNG. Returns results with title, url, content snippet, ' +
        'relevance score, and which engines found it. May also include direct answers, ' +
        'knowledge panels, and query suggestions. Use pageno to fetch additional pages.',
      inputSchema: {
        query: z.string().describe('Search query'),
        pageno: z.number().int().min(1).default(1).describe('Page number (default: 1)'),
      },
      outputSchema: SearchOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ query, pageno }) => {
      try {
        const result = await fetchWithFallback(pool, query, pageno);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    },
  );

  return server;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const envResult = z
  .object({
    PORT: z.coerce.number().default(3000),
    SEARXNG_URLS: z.string({ required_error: 'SEARXNG_URLS must be set' }).transform((s) =>
      s.split(',').map((u) => u.trim()).filter(Boolean),
    ),
    QUEUE_DELAY_MIN: z.coerce.number().default(5000),
    QUEUE_DELAY_MAX: z.coerce.number().default(9000),
    ALLOWED_HOSTS: z.string().default('0.0.0.0')
      .transform((s) =>
        s === '0.0.0.0'
          ? undefined
          : s.split(',').map((h) => h.trim()).filter(Boolean),
      ),
  })
  .safeParse(process.env);

if (!envResult.success) {
  console.error('Configuration error:');
  for (const issue of envResult.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const { PORT, SEARXNG_URLS, QUEUE_DELAY_MIN, QUEUE_DELAY_MAX, ALLOWED_HOSTS } = envResult.data;

const pool = createServerPool(SEARXNG_URLS, QUEUE_DELAY_MIN, QUEUE_DELAY_MAX);

const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: ALLOWED_HOSTS });

app.post('/mcp', async (req, res) => {
  const method = req.body?.method ?? '?';
  const tool = method === 'tools/call' ? `(${req.body?.params?.name ?? '?'})` : '';
  console.log(`[mcp] ${method}${tool} from ${req.headers['x-forwarded-for'] ?? req.ip}`);
  const server = createServer(pool);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

for (const verb of ['get', 'delete']) {
  app[verb]('/mcp', (_req, res) => res.status(405).end());
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const httpServer = app.listen(PORT, () => {
  console.log(`searxng-mcp on :${PORT} → ${pool.servers.map((s) => s.url).join(', ')}`);
});

const shutdown = () => httpServer.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
