/**
 * Screenshots for the README and the LinkedIn post (LOCAL DEVELOPMENT ONLY).
 *
 *   npm run capture:screenshots                       # every phase
 *   npm run capture:screenshots -- --only chat,gif    # some phases
 *
 * Needs the app running locally (npm run dev + npm run inngest:dev); this script never
 * starts or stops them. It signs in with `npm run dev:session` (token written to a temp file
 * outside the repo, read, then deleted) and uses only PUBLIC repositories. Before every
 * capture the visible text is checked for private repo names, Razorpay ids, emails and
 * tokens; the run stops if anything is found.
 *
 * Phases: static (dashboard, repo-wiki, settings, pricing, mobile dashboard), chat (+ mobile
 * chat), gif (chat-demo.gif), indexing (live re-index, also the dashboard with progress),
 * architecture (Mermaid → PNG), linkedin (linkedin-post/*.png + carousel PDF).
 *
 * Env: SCREENSHOT_USER (default Rajaryan1726), SCREENSHOT_INDEX_REPO (default NLP_PROJECT),
 * SCREENSHOT_CHAT_REPO (default Auto-Git-Wikki), SCREENSHOT_WIKI_REPO (default Advanced-RAG).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'images');
const LINKEDIN = join(ROOT, 'linkedin-post');
const WEB = process.env.SCREENSHOT_WEB_URL ?? 'http://localhost:5173';
const API = process.env.SCREENSHOT_API_URL ?? 'http://localhost:4000';
const USER = process.env.SCREENSHOT_USER ?? 'Rajaryan1726';
const INDEX_REPO = process.env.SCREENSHOT_INDEX_REPO ?? 'NLP_PROJECT';
const CHAT_REPO = process.env.SCREENSHOT_CHAT_REPO ?? 'Auto-Git-Wikki';
const WIKI_REPO = process.env.SCREENSHOT_WIKI_REPO ?? 'Advanced-RAG';
const CHAT_QUESTION =
  'How does the OAuth callback verify the state parameter? Show the relevant code.';
const GIF_QUESTION = 'How are GitHub access tokens stored and refreshed?';

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
type Theme = 'light' | 'dark';
const THEMES: Theme[] = ['light', 'dark'];

const only = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? new Set(process.argv[i + 1]!.split(',')) : null;
})();
const runs = (phase: string) => !only || only.has(phase);

// ---------------------------------------------------------------- session + API

function devSessionToken(): string {
  const file = join(tmpdir(), `autowiki-shot-${process.pid}.txt`);
  try {
    execFileSync('npm', ['run', '-s', 'dev:session', '--', USER, '--out', file], {
      cwd: ROOT,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    return readFileSync(file, 'utf8').trim();
  } finally {
    rmSync(file, { force: true });
  }
}

const TOKEN = devSessionToken();

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Cookie: `aw_session=${TOKEN}`, 'Content-Type': 'application/json', ...init.headers },
  });
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

type RepoRow = {
  id: string;
  name: string;
  fullName: string;
  isPrivate: boolean;
  indexStatus: { state: string; activeJobId: string | null };
};
const { repos } = await api<{ repos: RepoRow[] }>('/api/repos');
const repoByName = (name: string) => {
  const r = repos.find((x) => x.name === name || x.fullName === name);
  if (!r) throw new Error(`Repository ${name} not found`);
  if (r.isPrivate) throw new Error(`${name} is private: use public repositories only`);
  return r;
};
const PRIVATE_NAMES = repos.filter((r) => r.isPrivate).flatMap((r) => [r.name, r.fullName]);

// ---------------------------------------------------------------- browser helpers

const browser: Browser = await chromium.launch();

async function newContext(
  theme: Theme,
  viewport = DESKTOP,
  extra: Parameters<Browser['newContext']>[0] = {},
  signedIn = true,
): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: theme,
    reducedMotion: 'reduce',
    ...extra,
  });
  const host = new URL(WEB).hostname;
  if (signedIn)
    await ctx.addCookies([{ name: 'aw_session', value: TOKEN, domain: host, path: '/' }]);
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('autowiki-theme', t);
      // Users without a plan are sent to /pricing once per session; never in screenshots.
      sessionStorage.setItem('autowiki.pricingShown', '1');
    } catch {
      /* ignore */
    }
  }, theme);
  return ctx;
}

/** Waits for fonts, network idle, no skeletons / spinners, and settled layout. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll('.animate-pulse, [role="status"][aria-label^="Loading"]')
          .length === 0,
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => console.warn('  (a loading placeholder is still visible)'));
  await page.waitForTimeout(400);
}

const FORBIDDEN = [
  /rzp_(test|live)_\w+/i,
  /\bpay_[A-Za-z0-9]{8,}/,
  /\bsub_[A-Za-z0-9]{8,}/,
  /\bplan_[A-Za-z0-9]{8,}/,
  /[\w.+-]+@[\w-]+\.[\w.]+/,
  /aw_session|eyJhbGciOi/,
];

/** Stops the run if the page shows private repos, Razorpay ids, emails or tokens. */
async function assertClean(page: Page, label: string): Promise<void> {
  // Only text that is inside the viewport (what the screenshot shows).
  const text = await page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue;
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (
        r.width &&
        r.height &&
        r.bottom > 0 &&
        r.top < innerHeight &&
        r.right > 0 &&
        r.left < innerWidth
      ) {
        out.push(n.textContent);
      }
    }
    return out.join('\n');
  });
  const hits = [
    ...PRIVATE_NAMES.filter((n) => text.includes(n)).map((n) => `private repo "${n}"`),
    ...FORBIDDEN.filter((re) => re.test(text)).map((re) => `pattern ${re}`),
  ];
  if (hits.length) throw new Error(`${label}: refusing to capture (${hits.join(', ')})`);
}

async function shot(page: Page, name: string, opts: { fullPage?: boolean } = {}): Promise<string> {
  await settle(page);
  await assertClean(page, name);
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, animations: 'disabled', fullPage: opts.fullPage ?? false });
  console.log(`  ✓ ${name}.png`);
  return file;
}

async function showPublicReposOnly(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Public', exact: true }).click();
  await settle(page);
}

// ---------------------------------------------------------------- phases

async function staticShots(): Promise<void> {
  console.log('static');
  const wikiRepo = repoByName(WIKI_REPO);
  // A wiki page with a code block.
  const wiki = await api<{ pages?: { slug: string }[]; wiki?: { pages?: { slug: string }[] } }>(
    `/api/repos/${wikiRepo.id}/wiki`,
  );
  const slugs = (wiki.pages ?? wiki.wiki?.pages ?? []).map((p) => p.slug);
  // The shortest page whose first code block is near the top, so the TOC, the code and the
  // Sources chips fit on one screen.
  let slug = slugs[0];
  let best = Infinity;
  for (const s of slugs) {
    const page = await api<{ page?: { contentMd: string }; contentMd?: string }>(
      `/api/repos/${wikiRepo.id}/wiki/${s}`,
    );
    const md = page.page?.contentMd ?? page.contentMd ?? '';
    const firstCode = md.indexOf('```');
    if (firstCode < 0 || firstCode > 1500) continue;
    if (md.length < best) {
      best = md.length;
      slug = s;
    }
  }
  console.log(`  wiki page: ${slug}`);

  for (const theme of THEMES) {
    const ctx = await newContext(theme);
    const page = await ctx.newPage();

    await page.goto(`${WEB}/`);
    await showPublicReposOnly(page);
    await shot(page, `dashboard-${theme}`);

    await page.goto(`${WEB}/repos/${wikiRepo.id}/wiki/${slug}`);
    await settle(page);
    // Tab bar at the top: the TOC, the page title and the first code block fit below it.
    await page.evaluate(() => {
      const tabs = document.querySelector('[role="tablist"]');
      if (tabs) window.scrollTo({ top: tabs.getBoundingClientRect().top + scrollY - 24 });
    });
    await shot(page, `repo-wiki-${theme}`);

    await page.goto(`${WEB}/settings`);
    await settle(page);
    await page.evaluate(() => {
      const el = document.getElementById('memory');
      if (el) window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - 32 });
    });
    await shot(page, `settings-${theme}`);

    await ctx.close();

    // Pricing as a visitor sees it (public page; no account-specific buttons).
    const vctx = await newContext(theme, DESKTOP, {}, false);
    const v = await vctx.newPage();
    await v.goto(`${WEB}/pricing`);
    await shot(v, `pricing-${theme}`);
    await vctx.close();

    const mctx = await newContext(theme, MOBILE, { isMobile: true, hasTouch: true });
    const m = await mctx.newPage();
    await m.goto(`${WEB}/`);
    await showPublicReposOnly(m);
    await shot(m, `mobile-dashboard-${theme}`);
    await mctx.close();
  }
}

type Thread = { id: string };

async function askInUi(page: Page, question: string): Promise<void> {
  const box = page.getByPlaceholder(/Ask about the code/);
  await box.fill(question);
  await box.press('Enter');
}

async function waitForAnswer(page: Page): Promise<void> {
  // Finished when the Stop button is gone and Sources are shown.
  await page.waitForFunction(
    () =>
      !document.querySelector('button[aria-label="Stop"], button[aria-label="Stop generating"]') &&
      document.body.innerText.includes('Answered by'),
    undefined,
    { timeout: 180_000 },
  );
}

async function chatShots(): Promise<void> {
  console.log('chat');
  const repo = repoByName(CHAT_REPO);
  // Reuse a thread where this question was already answered (re-captures cost nothing).
  const { threads } = await api<{ threads: Thread[] }>(`/api/repos/${repo.id}/threads`);
  let threadId: string | null = null;
  for (const t of threads) {
    const { messages } = await api<{ messages: { role: string; content: string }[] }>(
      `/api/threads/${t.id}/messages`,
    );
    if (
      messages.length === 2 &&
      messages[0]!.content === CHAT_QUESTION &&
      messages[1]!.role === 'assistant'
    ) {
      threadId = t.id;
      break;
    }
  }
  let first = !threadId;
  if (!threadId) {
    const { thread } = await api<{ thread: Thread }>(`/api/repos/${repo.id}/threads`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    threadId = thread.id;
  }
  const url = `${WEB}/chat?repo=${repo.id}&thread=${threadId}`;
  for (const theme of THEMES) {
    const ctx = await newContext(theme);
    const page = await ctx.newPage();
    await page.goto(url);
    await settle(page);
    if (first) {
      await askInUi(page, CHAT_QUESTION);
      await waitForAnswer(page);
      first = false;
      await page.reload();
    }
    await settle(page);
    await scrollAnswerIntoView(page);
    await shot(page, `chat-${theme}`);
    await ctx.close();

    const mctx = await newContext(theme, MOBILE, { isMobile: true, hasTouch: true });
    const m = await mctx.newPage();
    await m.goto(url);
    await settle(m);
    await scrollAnswerIntoView(m);
    await shot(m, `mobile-chat-${theme}`);
    await mctx.close();
  }
}

/** Puts the question at the top of the viewport so the answer, code and sources follow. */
async function scrollAnswerIntoView(page: Page): Promise<void> {
  await page.evaluate((q) => {
    const bubble = [...document.querySelectorAll('p')].find((p) => p.textContent === q);
    // Below the sticky mobile top bar, if there is one.
    const bar = document.querySelector('aside');
    const offset =
      bar && getComputedStyle(bar).position === 'sticky' && innerWidth < 768
        ? bar.getBoundingClientRect().height + 16
        : 24;
    if (bubble) window.scrollTo({ top: bubble.getBoundingClientRect().top + scrollY - offset });
  }, CHAT_QUESTION);
  await page.waitForTimeout(300);
}

async function chatGif(): Promise<void> {
  console.log('gif');
  const repo = repoByName(CHAT_REPO);
  const { thread } = await api<{ thread: Thread }>(`/api/repos/${repo.id}/threads`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const videoDir = join(tmpdir(), `autowiki-video-${process.pid}`);
  const size = { width: 1200, height: 750 };
  const ctx = await newContext('light', size, {
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size },
  });
  const started = Date.now();
  const page = await ctx.newPage();
  await page.goto(`${WEB}/chat?repo=${repo.id}&thread=${thread.id}`);
  await settle(page);
  await assertClean(page, 'chat-demo');
  const sendAt = (Date.now() - started) / 1000;
  await askInUi(page, GIF_QUESTION);
  await waitForAnswer(page);
  // Hold on the finished answer so viewers can read it.
  await page.waitForTimeout(3500);
  const doneAt = (Date.now() - started) / 1000;
  await assertClean(page, 'chat-demo');
  const video = page.video();
  await ctx.close();
  const webm = await video!.path();

  const start = Math.max(0, sendAt - 1);
  const length = doneAt - start;
  // Keep the GIF at ~13 s: speed up longer answers.
  const speed = Math.max(1, length / 13);
  const gif = join(OUT, 'chat-demo.gif');
  for (const fps of [12, 10, 8]) {
    const filter =
      `setpts=PTS/${speed.toFixed(3)},fps=${fps},scale=1200:-1:flags=lanczos,` +
      'split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle';
    const r = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-ss',
        start.toFixed(2),
        '-t',
        length.toFixed(2),
        '-i',
        webm,
        '-vf',
        filter,
        gif,
      ],
      { stdio: 'inherit' },
    );
    if (r.status !== 0) throw new Error('ffmpeg failed');
    const mb = statSync(gif).size / 1e6;
    console.log(
      `  ✓ chat-demo.gif (${mb.toFixed(1)} MB, ${fps} fps, ${(length / speed).toFixed(1)} s)`,
    );
    if (mb < 8) break;
  }
  rmSync(videoDir, { recursive: true, force: true });
}

async function indexingShots(): Promise<void> {
  console.log('indexing');
  const repo = repoByName(INDEX_REPO);
  const res = await fetch(`${API}/api/repos/${repo.id}/index`, {
    method: 'POST',
    headers: { Cookie: `aw_session=${TOKEN}` },
  });
  if (!res.ok) throw new Error(`Re-index refused: ${res.status} ${await res.text()}`);
  const { job } = (await res.json()) as { job: { id: string } };

  const contexts = await Promise.all(THEMES.map((t) => newContext(t)));
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  await Promise.all(pages.map((p) => p.goto(`${WEB}/repos/${repo.id}?tab=history`)));
  const dash = await Promise.all(contexts.map((c) => c.newPage()));

  const captured = new Set<string>();
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const { job: j } = await api<{
      job: { status: string; currentStep: string | null; filesDone: number; filesTotal: number };
    }>(`/api/index-jobs/${job.id}`);
    if (j.status === 'done' || j.status === 'failed') break;
    // Best moment: the wiki step (earlier steps ticked off, pages counting up).
    const want =
      (j.currentStep === 'wiki' && !captured.has('wiki')) ||
      (j.currentStep === 'embed' && !captured.has('embed') && !captured.has('wiki'));
    if (want && j.currentStep) {
      for (const [i, theme] of THEMES.entries()) {
        await pages[i]!.goto(`${WEB}/repos/${repo.id}`);
        await settle(pages[i]!);
        // The wiki panel scrolls its article into view on load: back to the header + steps.
        await pages[i]!.waitForTimeout(800);
        await pages[i]!.evaluate(() => window.scrollTo({ top: 0 }));
        await shot(pages[i]!, `indexing-${theme}`);
        await dash[i]!.goto(`${WEB}/`);
        await showPublicReposOnly(dash[i]!);
        await shot(dash[i]!, `dashboard-indexing-${theme}`);
      }
      captured.add(j.currentStep);
      if (j.currentStep === 'wiki') break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  await Promise.all(contexts.map((c) => c.close()));
  if (captured.size === 0) throw new Error('The index job finished before it could be captured');
}

async function architecture(
  direction: 'LR' | 'TB' = 'LR',
  outFile = join(OUT, 'architecture.png'),
): Promise<void> {
  console.log(`architecture (${direction})`);
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const source = /```mermaid\r?\n([\s\S]*?)```/.exec(readme)?.[1];
  if (!source) throw new Error('No Mermaid block in README.md');
  const diagram = source.replace(/^flowchart \w+/, `flowchart ${direction}`);
  const config = {
    startOnLoad: false,
    theme: 'base',
    fontFamily: '"IBM Plex Sans", sans-serif',
    themeVariables: {
      fontFamily: '"IBM Plex Sans", sans-serif',
      fontSize: '16px',
      background: '#F4ECDD',
      primaryColor: '#FBF7EF',
      primaryTextColor: '#2A1F1C',
      primaryBorderColor: '#722F37',
      secondaryColor: '#E8DCC6',
      tertiaryColor: '#E8DCC6',
      clusterBkg: '#E8DCC6',
      clusterBorder: '#B7A89A',
      lineColor: '#722F37',
      textColor: '#2A1F1C',
      edgeLabelBackground: '#F4ECDD',
    },
    themeCSS:
      '.cluster-label .nodeLabel, .cluster-label span { font-weight: 600; color: #722F37 !important; } .flowchart-link { stroke-width: 1.8px !important; }',
    flowchart: {
      curve: 'basis',
      padding: 18,
      nodeSpacing: 40,
      rankSpacing: 70,
      wrappingWidth: 360,
    },
  };
  // Mermaid (installed with @mermaid-js/mermaid-cli) renders in the page AFTER IBM Plex Sans
  // has loaded, so node sizes are measured with the real font (the mmdc CLI measures before
  // web fonts load and clips the labels).
  const ctx = await browser.newContext({
    viewport: { width: 1800, height: 1200 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.setContent(`<!doctype html><html><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&display=swap">
<style>html,body{margin:0;background:#F4ECDD;font-family:'IBM Plex Sans'}
#wrap{display:inline-block;padding:48px;background:#F4ECDD} #wrap svg{max-width:none!important}</style>
</head><body><span style="font-family:'IBM Plex Sans';font-weight:600">.</span><span style="font-family:'IBM Plex Sans'">.</span><div id="wrap"></div></body></html>`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    await document.fonts.load('16px "IBM Plex Sans"');
    await document.fonts.load('600 16px "IBM Plex Sans"');
    await document.fonts.ready;
  });
  await page.addScriptTag({
    path: join(ROOT, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
  });
  await page.evaluate(
    async ({ code, cfg }) => {
      const m = (
        window as unknown as {
          mermaid: {
            initialize: (c: unknown) => void;
            render: (id: string, c: string) => Promise<{ svg: string }>;
          };
        }
      ).mermaid;
      m.initialize(cfg);
      const { svg } = await m.render('arch', code);
      const wrap = document.getElementById('wrap')!;
      wrap.innerHTML = svg;
      // Natural size from the viewBox (Mermaid sets width: 100%).
      const el = wrap.querySelector('svg')!;
      const vb = el.viewBox.baseVal;
      el.setAttribute('width', String(vb.width));
      el.setAttribute('height', String(vb.height));
      el.style.maxWidth = 'none';
    },
    { code: diagram, cfg: config },
  );
  await page.locator('#wrap').screenshot({ path: outFile });
  await ctx.close();
  console.log(`  ✓ ${outFile.slice(ROOT.length + 1)}`);
}

// ---------------------------------------------------------------- LinkedIn set

/** Crop of a 1440×900 screenshot, in CSS pixels (the slide shows the content area large). */
type Crop = { x: number; y: number; w: number; h: number };
const CONTENT: Crop = { x: 270, y: 0, w: 1170, h: 900 };

const SLIDES: { file: string; title: string; subtitle: string; image: string; crop?: Crop }[] = [
  {
    file: '02-wiki',
    title: 'Auto-generated wiki',
    subtitle: 'Overview, architecture and setup pages, written from your code with source links.',
    image: 'repo-wiki-light.png',
    crop: CONTENT,
  },
  {
    file: '03-chat',
    title: 'Chat with citations',
    subtitle: 'Answers grounded in the indexed code, with [n] citations to the exact lines.',
    image: 'chat-light.png',
    crop: { x: 586, y: 0, w: 854, h: 745 },
  },
  {
    file: '04-indexing',
    title: 'Background indexing pipeline',
    subtitle: 'Tree-sitter chunking, embeddings in Qdrant and wiki generation, step by step.',
    image: 'indexing-light.png',
    crop: CONTENT,
  },
  {
    file: '05-architecture',
    title: 'Architecture',
    subtitle: 'React + Express + Inngest, PostgreSQL and Qdrant, Gemini with OpenAI fallback.',
    image: 'architecture-portrait.png',
  },
  {
    file: '06-pricing',
    title: 'Plans & billing',
    subtitle: 'Monthly plans with Razorpay Subscriptions, quotas and usage meters.',
    image: 'pricing-light.png',
    crop: { x: 210, y: 84, w: 1020, h: 600 },
  },
];

const FRAME_W = 1040;

const SLIDE_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=IBM+Plex+Sans:wght@400;500&display=swap');
* { box-sizing: border-box; margin: 0; }
html, body { background: #F4ECDD; }
.slide { width: 1200px; height: 1500px; padding: 96px 80px 80px; display: flex; flex-direction: column;
  background: #F4ECDD; color: #2A1F1C; font-family: 'IBM Plex Sans', sans-serif; position: relative;
  page-break-after: always; break-after: page; overflow: hidden; }
.brand { display: flex; align-items: center; gap: 14px; font-family: 'Bricolage Grotesque', sans-serif;
  font-weight: 600; font-size: 30px; }
.logo { width: 52px; height: 52px; border-radius: 12px; background: #722F37; color: #FBF7EF;
  display: flex; align-items: center; justify-content: center; font-size: 30px; font-weight: 700; }
h1 { font-family: 'Bricolage Grotesque', sans-serif; font-weight: 700; letter-spacing: -0.02em; }
.title { font-size: 76px; line-height: 1.05; margin-top: 56px; }
.subtitle { font-size: 30px; line-height: 1.4; color: #6B5D52; margin-top: 22px; max-width: 980px; }
.stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 40px 0 24px; }
.frame { position: relative; width: ${FRAME_W}px; border-radius: 22px; overflow: hidden; background: #FBF7EF;
  border: 1px solid #DCCFBB; box-shadow: 0 30px 70px rgba(42,31,28,.18), 0 6px 18px rgba(42,31,28,.08); }
.frame img { position: absolute; display: block; max-width: none; }
.plain { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
.bar { height: 10px; width: 120px; background: #722F37; border-radius: 6px; margin-top: 40px; }
.cover .title { font-size: 128px; margin-top: 72px; }
.cover .subtitle { font-size: 40px; color: #2A1F1C; }
.cover .accent { color: #722F37; }
.footer { position: absolute; left: 80px; bottom: 34px; font-size: 20px; color: #6B5D52; }
`;

function dataUri(file: string): string {
  const path = existsSync(join(OUT, file)) ? join(OUT, file) : join(LINKEDIN, file);
  return `data:image/png;base64,${readFileSync(path).toString('base64')}`;
}

/** A framed, cropped screenshot (rounded corners, soft shadow). */
function framed(image: string, crop: Crop): string {
  const scale = FRAME_W / crop.w;
  return `<div class="frame" style="height:${Math.round(crop.h * scale)}px">
    <img src="${dataUri(image)}" alt="" style="width:${1440 * scale}px;left:${-crop.x * scale}px;top:${-crop.y * scale}px"></div>`;
}

function coverHtml(): string {
  return `<section class="slide cover">
  <div class="brand"><span class="logo">A</span>AutoWiki</div>
  <h1 class="title">Auto<span class="accent">Wiki</span></h1>
  <p class="subtitle">Turn any GitHub repo into a wiki you can chat with.</p>
  <div class="bar"></div>
  <div class="stage">${framed('dashboard-light.png', { x: 270, y: 0, w: 1170, h: 735 })}</div>
</section>`;
}

function slideHtml(s: (typeof SLIDES)[number], n: number): string {
  const body = s.crop
    ? framed(s.image, s.crop)
    : `<img class="plain" src="${dataUri(s.image)}" alt="">`;
  return `<section class="slide">
  <div class="brand"><span class="logo">A</span>AutoWiki</div>
  <h1 class="title">${s.title}</h1>
  <p class="subtitle">${s.subtitle}</p>
  <div class="stage">${body}</div>
  <div class="footer">${n} / ${SLIDES.length + 1}</div>
</section>`;
}

async function linkedin(): Promise<void> {
  console.log('linkedin');
  mkdirSync(LINKEDIN, { recursive: true });
  // A portrait version of the README diagram fits the 1200×1500 slide.
  await architecture('TB', join(LINKEDIN, 'architecture-portrait.png'));
  const slides = [
    { file: '01-cover', html: coverHtml() },
    ...SLIDES.map((s, i) => ({ file: s.file, html: slideHtml(s, i + 2) })),
  ];
  const ctx = await browser.newContext({
    viewport: { width: 1200, height: 1500 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  for (const s of slides) {
    await page.setContent(
      `<!doctype html><html><head><style>${SLIDE_CSS}</style></head><body>${s.html}</body></html>`,
    );
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: join(LINKEDIN, `${s.file}.png`),
      clip: { x: 0, y: 0, width: 1200, height: 1500 },
    });
    console.log(`  ✓ linkedin-post/${s.file}.png`);
  }
  await page.setContent(
    `<!doctype html><html><head><style>${SLIDE_CSS} @page { size: 1200px 1500px; margin: 0; }</style></head><body>${slides.map((s) => s.html).join('')}</body></html>`,
  );
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({
    path: join(LINKEDIN, 'autowiki-carousel.pdf'),
    width: '1200px',
    height: '1500px',
    printBackground: true,
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
  });
  console.log('  ✓ linkedin-post/autowiki-carousel.pdf');
  await ctx.close();
}

// ---------------------------------------------------------------- main

mkdirSync(OUT, { recursive: true });
try {
  if (runs('static')) await staticShots();
  if (runs('chat')) await chatShots();
  if (runs('gif')) await chatGif();
  if (runs('indexing')) await indexingShots();
  if (runs('architecture')) await architecture();
  if (runs('linkedin')) {
    const missing = [
      'dashboard-light.png',
      ...SLIDES.filter((s) => s.crop).map((s) => s.image),
    ].filter((f) => !existsSync(join(OUT, f)));
    if (missing.length) throw new Error(`Capture these first: ${missing.join(', ')}`);
    await linkedin();
  }
} finally {
  await browser.close();
}
