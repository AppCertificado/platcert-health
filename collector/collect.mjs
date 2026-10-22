import { readFile, writeFile } from "node:fs/promises"
import { buildReport } from "./report.mjs"

const TIMEOUT_MS = 10_000
const PROBE_TOKEN = "healthcheck-invalid-probe"

function secretsFromEnv() {
  const url = process.env.SUPABASE_HTTP_URL || ""
  const host = url ? safeHost(url) : ""
  return [url, host, process.env.GITHUB_TOKEN_PLATCERT, process.env.VERCEL_TOKEN].filter((item) => item && item.length >= 6)
}

function safeHost(url) {
  try {
    return new URL(url).host
  } catch {
    return ""
  }
}

async function probe(url, { headers, readBody = false, limit = 65536 } = {}) {
  const started = performance.now()
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const response_ms = Math.round(performance.now() - started)
    let text = ""
    if (readBody) {
      text = await response.text()
      if (text.length > limit) text = text.slice(0, limit)
    } else {
      await response.body?.cancel()
    }
    return { http_status: response.status, response_ms, text }
  } catch (error) {
    const response_ms = Math.round(performance.now() - started)
    const name = error?.name || ""
    const timedOut = name === "TimeoutError" || name === "AbortError"
    return { error: timedOut ? "timeout" : "network", response_ms }
  }
}

function jsonSlice(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function loadPrevious(target) {
  const remote = process.env.PREVIOUS_STATUS_URL
  if (remote) {
    try {
      const response = await fetch(remote, { signal: AbortSignal.timeout(8000), cache: "no-store" })
      if (response.ok) {
        const data = await response.json()
        if (data?.schema === 1) return data
      } else {
        await response.body?.cancel()
      }
    } catch {
      // A página ainda pode não existir. O arquivo local, se houver, cobre a comparação.
    }
  }
  try {
    const data = JSON.parse(await readFile(target, "utf8"))
    return data?.schema === 1 ? data : null
  } catch {
    return null
  }
}

async function github(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "platcert-health",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel()
    return { auth_error: true }
  }
  if (!response.ok) {
    await response.body?.cancel()
    return { collector_error: true }
  }
  return { data: await response.json() }
}

async function readGithub(repo, token) {
  if (!token) return { auth_error: true }
  const listed = await github(`/repos/${repo}/commits?per_page=20`, token)
  if (listed.auth_error || listed.collector_error) return listed
  const commits = []
  for (const commit of listed.data) {
    if (!commit?.sha) continue
    const status = await github(`/repos/${repo}/commits/${commit.sha}/status`, token)
    if (status.auth_error) return { auth_error: true }
    const vercel = status.collector_error
      ? null
      : (status.data?.statuses || []).find((item) => item?.context === "Vercel") || null
    commits.push({
      sha: commit.sha,
      date: commit.commit?.committer?.date || null,
      vercel: vercel
        ? {
            state: typeof vercel.state === "string" ? vercel.state : null,
            description: typeof vercel.description === "string" ? vercel.description.slice(0, 180) : "",
            updated_at: vercel.updated_at || null,
          }
        : null,
    })
  }
  return { commits }
}

async function main() {
  const target = process.argv[2] || "docs/status.json"
  const appUrl = (process.env.APP_URL || "https://appplatcert.vercel.app").replace(/\/$/, "")
  const repo = process.env.PLATCERT_REPO || "AppCertificado/platcert"
  const secrets = secretsFromEnv()
  const supabaseUrl = process.env.SUPABASE_HTTP_URL || ""

  const [root, login, health, agents, edge, githubResult, previous] = await Promise.all([
    probe(`${appUrl}/`),
    probe(`${appUrl}/entrar`, { readBody: true }),
    probe(`${appUrl}/api/health`, { readBody: true, limit: 4096 }),
    probe(`${appUrl}/api/agents`, {
      readBody: true,
      limit: 4096,
      headers: { Authorization: `Bearer ${PROBE_TOKEN}` },
    }),
    supabaseUrl ? probe(supabaseUrl) : Promise.resolve(null),
    readGithub(repo, process.env.GITHUB_TOKEN_PLATCERT || ""),
    loadPrevious(target),
  ])

  const healthJson = jsonSlice(health.text || "")
  const agentJson = jsonSlice(agents.text || "")
  delete health.text
  delete agents.text
  const identified = typeof login.text === "string" && login.text.includes("Platcert")
  delete login.text

  const now = new Date().toISOString()
  const report = buildReport({
    now,
    collector: process.env.GITHUB_ACTIONS ? "github-actions" : "local",
    previous,
    secrets,
    probes: {
      frontend: {
        root,
        login: { ...login, identified },
      },
      backend: {
        ...health,
        body_status: typeof healthJson?.status === "string" ? healthJson.status : null,
        contract_version: typeof healthJson?.contract_version === "string" ? healthJson.contract_version.slice(0, 20) : null,
      },
      supabase: {
        configured: Boolean(supabaseUrl),
        ...(edge || {}),
      },
      postgres: {
        ...agents,
        error_code: typeof agentJson?.error === "string" && /^[a-z_]{1,40}$/.test(agentJson.error) ? agentJson.error : null,
      },
    },
    github: githubResult,
  })

  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`)
}

main().catch((error) => {
  const message = error?.message === "Relatório contém dado sensível."
    ? "Relatório contém dado sensível."
    : "A coleta falhou antes de publicar."
  console.error(message)
  process.exit(1)
})
