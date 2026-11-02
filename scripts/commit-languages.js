const { mkdir, writeFile } = require("node:fs/promises");

const { GITHUB_TOKEN, GITHUB_USER, OUT_DIR = "profile" } = process.env;

const API = "https://api.github.com";
const DAY = 24 * 60 * 60 * 1000;
const SEARCH_LIMIT = 1000;
const SEARCH_DELAY_MS = 2100;
const MAX_LINES_PER_FILE = 2000;
const TOP = 8;

const LANGUAGES = {
  JavaScript: ["#f1e05a", ".js", ".mjs", ".cjs", ".jsx"],
  TypeScript: ["#3178c6", ".ts", ".mts", ".cts", ".tsx"],
  GraphQL: ["#e10098", ".graphql", ".gql"],
  Python: ["#3572A5", ".py"],
  Java: ["#b07219", ".java"],
  Kotlin: ["#A97BFF", ".kt", ".kts"],
  "C#": ["#178600", ".cs"],
  C: ["#555555", ".c", ".h"],
  "C++": ["#f34b7d", ".cpp", ".cc", ".hpp"],
  Go: ["#00ADD8", ".go"],
  Rust: ["#dea584", ".rs"],
  PHP: ["#4F5D95", ".php"],
  Ruby: ["#701516", ".rb"],
  Swift: ["#F05138", ".swift"],
  Dart: ["#00B4AB", ".dart"],
  SQL: ["#e38c00", ".sql"],
  Shell: ["#89e051", ".sh", ".bash", ".zsh"],
  PowerShell: ["#012456", ".ps1", ".psm1"],
  HTML: ["#e34c26", ".html", ".htm"],
  CSS: ["#663399", ".css"],
  SCSS: ["#c6538c", ".scss"],
  Vue: ["#41b883", ".vue"],
  Handlebars: ["#f7931e", ".hbs", ".handlebars"],
  HCL: ["#844FBA", ".tf", ".hcl"],
  "Jupyter Notebook": ["#DA5B0B", ".ipynb"],
  Dockerfile: ["#384d54", "Dockerfile"],
  Makefile: ["#427819", "Makefile"],
};

const IGNORED =
  /(^|\/)(node_modules|vendor|dist|build|coverage|__snapshots__|tmp|temp|\.?venv|site-packages|__pycache__)\/|\.min\.(js|css)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

const THEMES = {
  light: { bg: "#fffefe", border: "#e4e2e2", title: "#2f80ed", text: "#434d58", muted: "#6a737d" },
  dark: { bg: "#0d1117", border: "#30363d", title: "#58a6ff", text: "#c3d1d9", muted: "#8b949e" },
};

const languageByFile = new Map();
for (const [name, [color, ...patterns]] of Object.entries(LANGUAGES)) {
  for (const pattern of patterns) languageByFile.set(pattern, { name, color });
}

function languageOf(path) {
  const file = path.split("/").pop();
  const dot = file.lastIndexOf(".");
  return languageByFile.get(file) || (dot > 0 ? languageByFile.get(file.slice(dot).toLowerCase()) : undefined);
}

function tallyLanguages(files) {
  const totals = {};
  for (const { filename, additions, deletions } of files) {
    const language = languageOf(filename);
    const lines = additions + deletions;
    if (!language || IGNORED.test(filename) || lines > MAX_LINES_PER_FILE) continue;
    totals[language.name] ??= { ...language, lines: 0 };
    totals[language.name].lines += lines;
  }
  return Object.values(totals).sort((a, b) => b.lines - a.lines);
}

function topShares(languages) {
  const top = languages.slice(0, TOP);
  const total = top.reduce((sum, { lines }) => sum + lines, 0);
  return top.map(({ name, color, lines }) => ({ name, color, percent: (lines / total) * 100 }));
}

function renderCard(shares, theme) {
  const width = 350;
  const pad = 25;
  const barWidth = width - pad * 2;
  const height = 110 + Math.ceil(shares.length / 2) * 24;

  let x = pad;
  const bar = shares
    .map(({ color, percent }) => {
      const w = (barWidth * percent) / 100;
      const rect = `<rect x="${x.toFixed(2)}" y="72" width="${w.toFixed(2)}" height="8" fill="${color}"/>`;
      x += w;
      return rect;
    })
    .join("");

  const legend = shares
    .map(({ name, color, percent }, i) => {
      const lx = pad + (i % 2) * (barWidth / 2);
      const ly = 108 + Math.floor(i / 2) * 24;
      return `<g transform="translate(${lx} ${ly})"><circle cx="5" cy="-4" r="5" fill="${color}"/><text x="16" class="lang">${name} <tspan class="muted">${percent.toFixed(1)}%</tspan></text></g>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<title>Most used languages</title>
<style>
text{font-family:'Segoe UI',Ubuntu,Sans-Serif}
.title{font-size:18px;font-weight:600;fill:${theme.title}}
.sub{font-size:12px;fill:${theme.muted}}
.lang{font-size:13px;fill:${theme.text}}
.muted{fill:${theme.muted}}
</style>
<rect x="0.5" y="0.5" rx="4.5" width="${width - 1}" height="${height - 1}" fill="${theme.bg}" stroke="${theme.border}"/>
<text x="${pad}" y="35" class="title">Most used languages</text>
<text x="${pad}" y="56" class="sub">Lines changed in my commits, private repos included</text>
<clipPath id="bar"><rect x="${pad}" y="72" width="${barWidth}" height="8" rx="4"/></clipPath>
<g clip-path="url(#bar)">${bar}</g>
${legend}
</svg>
`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function github(path) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API + path, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    });
    if (res.ok) return res.json();

    const retryAfter = res.headers.get("retry-after");
    const exhausted = res.headers.get("x-ratelimit-remaining") === "0";
    const rateLimited = res.status === 429 || (res.status === 403 && (retryAfter || exhausted));
    if (!rateLimited || attempt === 5) throw new Error(`GitHub API ${res.status} on ${path.split("?")[0]}`);

    const resetAt = res.headers.get("x-ratelimit-reset") * 1000;
    await sleep(retryAfter ? retryAfter * 1000 : Math.max(resetAt - Date.now(), 0) + 1000);
  }
}

const isoDate = (date) => date.toISOString().slice(0, 10);

async function searchCommits(from, to) {
  const query = encodeURIComponent(`author:${GITHUB_USER} merge:false author-date:${isoDate(from)}..${isoDate(to)}`);
  const fetchPage = async (page) => {
    await sleep(SEARCH_DELAY_MS);
    return github(`/search/commits?q=${query}&per_page=100&page=${page}`);
  };

  const first = await fetchPage(1);
  const days = Math.floor((to - from) / DAY);
  if (first.total_count > SEARCH_LIMIT && days > 0) {
    const middle = new Date(from.getTime() + Math.floor(days / 2) * DAY);
    const before = await searchCommits(from, middle);
    const after = await searchCommits(new Date(middle.getTime() + DAY), to);
    return [...before, ...after];
  }

  const items = first.items;
  for (let page = 2; items.length < Math.min(first.total_count, SEARCH_LIMIT); page++) {
    const { items: more } = await fetchPage(page);
    if (more.length === 0) break;
    items.push(...more);
  }
  return items;
}

async function mapConcurrent(items, fn, concurrency = 6) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function main() {
  if (!GITHUB_TOKEN || !GITHUB_USER) throw new Error("GITHUB_TOKEN and GITHUB_USER are required");

  const user = await github(`/users/${GITHUB_USER}`);
  const found = await searchCommits(new Date(user.created_at), new Date());
  const commits = [...new Map(found.map((commit) => [commit.sha, commit])).values()];
  console.log(`Found ${commits.length} commits`);

  const details = await mapConcurrent(commits, (commit) =>
    github(`/repos/${commit.repository.full_name}/commits/${commit.sha}`),
  );
  const shares = topShares(tallyLanguages(details.flatMap((commit) => commit.files || [])));
  console.log(shares.map(({ name, percent }) => `${name} ${percent.toFixed(1)}%`).join(", "));

  await mkdir(OUT_DIR, { recursive: true });
  for (const [name, theme] of Object.entries(THEMES)) {
    await writeFile(`${OUT_DIR}/languages-${name}.svg`, renderCard(shares, theme));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
