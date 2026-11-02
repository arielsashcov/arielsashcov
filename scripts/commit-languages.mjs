// Renders a "most used languages" card from the lines changed in the user's
// own commits, private repositories included. Reads commit metadata through the
// GitHub API only: nothing is cloned, and only aggregate percentages are written.
//
// Usage: GITHUB_TOKEN=<classic PAT: repo, read:user> GITHUB_USER=<login> node scripts/commit-languages.mjs
// Commit search only indexes default branches, so unmerged work is not counted.
// Logs counts only. Actions logs of a public repository are public, so never
// log repository names or commit messages here.

import { mkdir, writeFile } from "node:fs/promises";

const API = "https://api.github.com";
const TOP_LANGUAGES = 8;
const SEARCH_RESULT_CAP = 1000;
const SEARCH_INTERVAL_MS = 2100; // search API allows 30 requests per minute
const DETAIL_CONCURRENCY = 6;
// A single file change this large is almost always generated or vendored.
const MAX_LINES_PER_FILE = 2000;

// [name, linguist color, extensions and exact file names]
const LANGUAGES = [
  ["JavaScript", "#f1e05a", ".js", ".mjs", ".cjs", ".jsx"],
  ["TypeScript", "#3178c6", ".ts", ".mts", ".cts", ".tsx"],
  ["GraphQL", "#e10098", ".graphql", ".gql"],
  ["Python", "#3572A5", ".py"],
  ["Java", "#b07219", ".java"],
  ["Kotlin", "#A97BFF", ".kt", ".kts"],
  ["C#", "#178600", ".cs"],
  ["C", "#555555", ".c", ".h"],
  ["C++", "#f34b7d", ".cpp", ".cc", ".hpp"],
  ["Go", "#00ADD8", ".go"],
  ["Rust", "#dea584", ".rs"],
  ["PHP", "#4F5D95", ".php"],
  ["Ruby", "#701516", ".rb"],
  ["Swift", "#F05138", ".swift"],
  ["Dart", "#00B4AB", ".dart"],
  ["SQL", "#e38c00", ".sql"],
  ["Shell", "#89e051", ".sh", ".bash", ".zsh"],
  ["PowerShell", "#012456", ".ps1", ".psm1"],
  ["HTML", "#e34c26", ".html", ".htm"],
  ["CSS", "#663399", ".css"],
  ["SCSS", "#c6538c", ".scss"],
  ["Vue", "#41b883", ".vue"],
  ["Handlebars", "#f7931e", ".hbs", ".handlebars"],
  ["HCL", "#844FBA", ".tf", ".hcl"],
  ["Jupyter Notebook", "#DA5B0B", ".ipynb"],
  ["Dockerfile", "#384d54", "Dockerfile"],
  ["Makefile", "#427819", "Makefile"],
];

const IGNORED_PATH =
  /(^|\/)(node_modules|vendor|dist|build|coverage|__snapshots__|tmp|temp|\.?venv|site-packages|__pycache__)\/|\.min\.(js|css)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

const THEMES = {
  light: { bg: "#fffefe", border: "#e4e2e2", title: "#2f80ed", text: "#434d58", muted: "#6a737d" },
  dark: { bg: "#0d1117", border: "#30363d", title: "#58a6ff", text: "#c3d1d9", muted: "#8b949e" },
};

const languageByKey = new Map(
  LANGUAGES.flatMap(([name, color, ...keys]) => keys.map((key) => [key, { name, color }])),
);

export function languageOf(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return languageByKey.get(base) ?? (dot > 0 ? languageByKey.get(base.slice(dot).toLowerCase()) : undefined);
}

export function tallyLanguages(fileChanges) {
  const totals = new Map();
  for (const { filename, additions, deletions } of fileChanges) {
    const lines = additions + deletions;
    const language = languageOf(filename);
    if (!language || IGNORED_PATH.test(filename) || lines > MAX_LINES_PER_FILE) continue;
    const entry = totals.get(language.name) ?? { ...language, lines: 0 };
    entry.lines += lines;
    totals.set(language.name, entry);
  }
  return [...totals.values()].sort((a, b) => b.lines - a.lines);
}

export function topShares(languages, count = TOP_LANGUAGES) {
  const top = languages.slice(0, count);
  const total = top.reduce((sum, { lines }) => sum + lines, 0);
  return top.map(({ name, color, lines }) => ({ name, color, percent: (lines / total) * 100 }));
}

const escapeXml = (text) => text.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderCard(shares, theme) {
  const width = 350;
  const pad = 25;
  const barWidth = width - pad * 2;
  const rows = Math.ceil(shares.length / 2);
  const height = 110 + rows * 24;

  let x = pad;
  const segments = shares.map(({ color, percent }) => {
    const w = (barWidth * percent) / 100;
    const rect = `<rect x="${x.toFixed(2)}" y="72" width="${w.toFixed(2)}" height="8" fill="${color}"/>`;
    x += w;
    return rect;
  });

  const legend = shares.map(({ name, color, percent }, i) => {
    const lx = pad + (i % 2) * (barWidth / 2);
    const ly = 108 + Math.floor(i / 2) * 24;
    return `<g transform="translate(${lx} ${ly})"><circle cx="5" cy="-4" r="5" fill="${color}"/><text x="16" class="lang">${escapeXml(name)} <tspan class="muted">${percent.toFixed(1)}%</tspan></text></g>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title">
<title id="title">Most used languages</title>
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
<g clip-path="url(#bar)">${segments.join("")}</g>
${legend.join("\n")}
</svg>
`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function github(path, token) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (res.ok) return res.json();
    const retryAfter = res.headers.get("retry-after");
    const exhausted = res.headers.get("x-ratelimit-remaining") === "0";
    const limited = res.status === 429 || (res.status === 403 && (exhausted || retryAfter));
    if (!limited || attempt === 5) throw new Error(`GitHub API ${res.status} on ${path.split("?")[0]}`);
    const resetAt = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    await sleep(retryAfter ? Number(retryAfter) * 1000 : Math.max(resetAt - Date.now(), 0) + 1000);
  }
}

const isoDay = (date) => date.toISOString().slice(0, 10);

// The search API returns at most 1000 results per query, so split the date range until each half fits.
async function searchCommits(user, token, from, to) {
  const query = (page) =>
    `/search/commits?q=${encodeURIComponent(`author:${user} merge:false author-date:${isoDay(from)}..${isoDay(to)}`)}&per_page=100&page=${page}`;
  await sleep(SEARCH_INTERVAL_MS);
  const first = await github(query(1), token);
  const spanDays = (to - from) / 86_400_000;
  if (first.total_count > SEARCH_RESULT_CAP && spanDays >= 1) {
    const middle = new Date(from.getTime() + Math.floor(spanDays / 2) * 86_400_000);
    const nextDay = new Date(middle.getTime() + 86_400_000);
    return [...(await searchCommits(user, token, from, middle)), ...(await searchCommits(user, token, nextDay, to))];
  }
  const items = [...first.items];
  for (let page = 2; items.length < Math.min(first.total_count, SEARCH_RESULT_CAP); page++) {
    await sleep(SEARCH_INTERVAL_MS);
    const next = await github(query(page), token);
    if (next.items.length === 0) break;
    items.push(...next.items);
  }
  return items;
}

async function mapConcurrent(items, limit, fn) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const user = process.env.GITHUB_USER;
  const outDir = process.env.OUT_DIR ?? "profile";
  if (!token || !user) throw new Error("GITHUB_TOKEN and GITHUB_USER are required");

  const { created_at: createdAt } = await github(`/users/${user}`, token);
  const found = await searchCommits(user, token, new Date(createdAt), new Date());
  const unique = [...new Map(found.map((item) => [item.sha, item])).values()];
  console.log(`Found ${unique.length} commits`);

  const details = await mapConcurrent(unique, DETAIL_CONCURRENCY, (item) =>
    github(`/repos/${item.repository.full_name}/commits/${item.sha}`, token),
  );
  const shares = topShares(tallyLanguages(details.flatMap((commit) => commit.files ?? [])));
  console.log(shares.map(({ name, percent }) => `${name} ${percent.toFixed(1)}%`).join(", "));

  await mkdir(outDir, { recursive: true });
  await Promise.all(
    Object.entries(THEMES).map(([name, theme]) => writeFile(`${outDir}/languages-${name}.svg`, renderCard(shares, theme))),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
