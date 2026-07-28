export const REPO = "CatsAndBoats/catseyexi";
export const SCRIPT_BRANCHES = ["base", "mods", "main", "master"];
export const SQL_BRANCHES = ["mods", "base", "main", "master"];

export const RAW = (branch, path) => `https://raw.githubusercontent.com/${REPO}/${branch}/${path}`;
export const API_TREE = (branch) => `https://api.github.com/repos/${REPO}/git/trees/${branch}?recursive=1`;
export const API_CONTENTS = (branch, path) =>
  `https://api.github.com/repos/${REPO}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${branch}`;

function authHeaders() {
  const token = (process.env.GITHUB_TOKEN || "").trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchText(url, { retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, { headers: authHeaders() });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
      return await resp.text();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export async function tryBranches(path, branches) {
  let last;
  for (const branch of branches) {
    try {
      const text = await fetchText(RAW(branch, path));
      return { text, branch };
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`Could not fetch ${path} from any branch (${last})`);
}
