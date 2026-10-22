import { STALE_MS } from "../docs/logic.js"

export const EXPECTED_CONTRACT = "1.0"

const STATE_RANK = { indisponivel: 3, degradado: 2, desconhecido: 1, operacional: 0 }

export function sanitize(value, secrets = []) {
  let text = String(value ?? "")
  const needles = secrets.filter((item) => typeof item === "string" && item.length >= 6)
  for (const secret of needles.sort((a, b) => b.length - a.length)) text = text.split(secret).join("[omitido]")
  text = text
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[omitido]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[omitido]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{6,}/gi, "Bearer [omitido]")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[omitido]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[omitido]")
    .replace(/\b(?:10|127|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2,3}\b/g, "[omitido]")
    .replace(/[a-z0-9]{16,}\.supabase\.co/gi, "[omitido]")
  return text.replace(/\s+/g, " ").trim().slice(0, 220)
}

export function assertPublic(report, secrets = []) {
  const raw = JSON.stringify(report)
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 6 && raw.includes(secret)) {
      throw new Error("Relatório contém dado sensível.")
    }
  }
  const blocked = [
    /gh[pousr]_[A-Za-z0-9_]+/,
    /github_pat_[A-Za-z0-9_]+/,
    /postgres(?:ql)?:\/\//i,
    /Bearer\s+[A-Za-z0-9._~+/-]{6,}/i,
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
    /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2,3}\b/,
    /[a-z0-9]{16,}\.supabase\.co/i,
  ]
  for (const pattern of blocked) {
    if (pattern.test(raw)) throw new Error("Relatório contém dado sensível.")
  }
}

function component(fields) {
  return {
    failure_class: null,
    http_status: null,
    response_ms: null,
    last_seen: null,
    heartbeat: null,
    ...fields,
  }
}

function httpFailure(error) {
  if (!error) return null
  if (error === "timeout") return "Tempo esgotado ao contatar o componente."
  if (error === "network") return "Erro de conectividade."
  return "Falha da coleta ao executar a sonda."
}

export function classifyFrontend(probe, now) {
  const rootError = httpFailure(probe.root?.error)
  const loginError = httpFailure(probe.login?.error)
  if (probe.root?.error === "collector" && probe.login?.error === "collector") {
    return component({
      id: "frontend",
      name: "Frontend",
      area: "producao",
      scope: "producao",
      state: "desconhecido",
      failure_class: "coleta",
      checked_at: now,
      detail: "Falha da coleta. O estado do frontend não foi confirmado.",
    })
  }
  if (probe.root?.error === "timeout" || probe.root?.error === "network") {
    return component({
      id: "frontend",
      name: "Frontend",
      area: "producao",
      scope: "producao",
      state: "indisponivel",
      failure_class: "componente",
      checked_at: now,
      response_ms: probe.root.response_ms ?? null,
      detail: rootError,
    })
  }
  const rootStatus = probe.root?.http_status
  const addressOk = rootStatus === 200 || rootStatus === 301 || rootStatus === 302 || rootStatus === 307 || rootStatus === 308
  const loginOk = probe.login?.http_status === 200 && probe.login?.identified === true
  if (!addressOk) {
    return component({
      id: "frontend",
      name: "Frontend",
      area: "producao",
      scope: "producao",
      state: rootStatus >= 500 ? "indisponivel" : "degradado",
      failure_class: "componente",
      checked_at: now,
      http_status: rootStatus ?? null,
      response_ms: probe.root?.response_ms ?? null,
      detail: `O endereço público respondeu ${rootStatus ?? "sem código"}.`,
    })
  }
  if (probe.login?.error === "timeout" || probe.login?.error === "network" || !loginOk) {
    return component({
      id: "frontend",
      name: "Frontend",
      area: "producao",
      scope: "producao",
      state: probe.login?.http_status >= 500 || probe.login?.error ? "indisponivel" : "degradado",
      failure_class: "componente",
      checked_at: now,
      http_status: probe.login?.http_status ?? rootStatus,
      response_ms: probe.login?.response_ms ?? probe.root?.response_ms ?? null,
      detail: probe.login?.error
        ? `O endereço público respondeu ${rootStatus}. ${loginError}`
        : `O endereço público respondeu ${rootStatus}. A página de login respondeu ${probe.login?.http_status ?? "sem código"}.`,
    })
  }
  const slow = (probe.root.response_ms ?? 0) > 8000 || (probe.login.response_ms ?? 0) > 8000
  return component({
    id: "frontend",
    name: "Frontend",
    area: "producao",
    scope: "producao",
    state: slow ? "degradado" : "operacional",
    failure_class: slow ? "componente" : null,
    checked_at: now,
    http_status: probe.login.http_status,
    response_ms: probe.login.response_ms,
    detail: slow
      ? `Endereço público ${rootStatus} em ${probe.root.response_ms} ms. Página de login 200 em ${probe.login.response_ms} ms, com resposta lenta.`
      : `Endereço público respondeu ${rootStatus} em ${probe.root.response_ms} ms. Página de login respondeu 200 em ${probe.login.response_ms} ms.`,
  })
}

export function classifyBackend(probe, now, expected = EXPECTED_CONTRACT) {
  if (probe.error === "collector") {
    return component({
      id: "backend",
      name: "Backend e APIs",
      area: "producao",
      scope: "producao",
      state: "desconhecido",
      failure_class: "coleta",
      checked_at: now,
      detail: "Falha da coleta. O estado da API não foi confirmado.",
    })
  }
  if (probe.error === "timeout" || probe.error === "network") {
    return component({
      id: "backend",
      name: "Backend e APIs",
      area: "producao",
      scope: "producao",
      state: "indisponivel",
      failure_class: "componente",
      checked_at: now,
      response_ms: probe.response_ms ?? null,
      detail: httpFailure(probe.error),
    })
  }
  const status = probe.http_status
  const contract = probe.contract_version
  if (status === 200 && contract === expected && probe.body_status === "ok") {
    const slow = (probe.response_ms ?? 0) > 8000
    return component({
      id: "backend",
      name: "Backend e APIs",
      area: "producao",
      scope: "producao",
      state: slow ? "degradado" : "operacional",
      failure_class: slow ? "componente" : null,
      checked_at: now,
      http_status: status,
      response_ms: probe.response_ms ?? null,
      detail: slow
        ? `A API de saúde respondeu 200 com contrato ${contract}, em ${probe.response_ms} ms, com resposta lenta.`
        : `A API de saúde respondeu 200 com contrato ${contract}, em ${probe.response_ms} ms.`,
    })
  }
  if (status === 200 && contract && contract !== expected) {
    return component({
      id: "backend",
      name: "Backend e APIs",
      area: "producao",
      scope: "producao",
      state: "degradado",
      failure_class: "componente",
      checked_at: now,
      http_status: status,
      response_ms: probe.response_ms ?? null,
      detail: `A API respondeu 200 com contrato ${sanitize(contract)}, diferente de ${expected}.`,
    })
  }
  return component({
    id: "backend",
    name: "Backend e APIs",
    area: "producao",
    scope: "producao",
    state: status >= 500 ? "indisponivel" : "degradado",
    failure_class: "componente",
    checked_at: now,
    http_status: status ?? null,
    response_ms: probe.response_ms ?? null,
    detail: `A API de saúde respondeu ${status ?? "sem código"}.`,
  })
}

export function classifySupabase(probe, now) {
  if (!probe.configured) {
    return component({
      id: "supabase_http",
      name: "Supabase — borda HTTP",
      area: "producao",
      scope: "producao",
      state: "desconhecido",
      failure_class: "autenticacao",
      checked_at: now,
      detail: "Falha de autenticação da integração. A credencial da borda HTTP não está configurada no coletor.",
    })
  }
  if (probe.error === "collector") {
    return component({
      id: "supabase_http",
      name: "Supabase — borda HTTP",
      area: "producao",
      scope: "producao",
      state: "desconhecido",
      failure_class: "coleta",
      checked_at: now,
      detail: "Falha da coleta. A borda HTTP não foi confirmada.",
    })
  }
  if (probe.error === "timeout" || probe.error === "network") {
    return component({
      id: "supabase_http",
      name: "Supabase — borda HTTP",
      area: "producao",
      scope: "producao",
      state: "indisponivel",
      failure_class: "componente",
      checked_at: now,
      response_ms: probe.response_ms ?? null,
      detail: `${httpFailure(probe.error)} Isto não distingue a borda do PostgreSQL.`,
    })
  }
  if (probe.http_status === 401) {
    return component({
      id: "supabase_http",
      name: "Supabase — borda HTTP",
      area: "producao",
      scope: "producao",
      state: "operacional",
      checked_at: now,
      http_status: 401,
      response_ms: probe.response_ms ?? null,
      detail: `A borda HTTP respondeu 401 sem chave, em ${probe.response_ms} ms. Esse 401 não prova o PostgreSQL.`,
    })
  }
  return component({
    id: "supabase_http",
    name: "Supabase — borda HTTP",
    area: "producao",
    scope: "producao",
    state: probe.http_status >= 500 ? "indisponivel" : "degradado",
    failure_class: "componente",
    checked_at: now,
    http_status: probe.http_status ?? null,
    response_ms: probe.response_ms ?? null,
    detail: `A borda HTTP respondeu ${probe.http_status ?? "sem código"}.`,
  })
}

export function classifyPostgres(probe, now) {
  if (probe.error === "collector") {
    return component({
      id: "postgres",
      name: "Conectividade PostgreSQL",
      area: "producao",
      scope: "producao",
      state: "desconhecido",
      failure_class: "coleta",
      checked_at: now,
      detail: "Falha da coleta. A conectividade com o banco não foi confirmada.",
    })
  }
  if (probe.error === "timeout" || probe.error === "network") {
    return component({
      id: "postgres",
      name: "Conectividade PostgreSQL",
      area: "producao",
      scope: "producao",
      state: "indisponivel",
      failure_class: "componente",
      checked_at: now,
      response_ms: probe.response_ms ?? null,
      detail: httpFailure(probe.error),
    })
  }
  if (probe.http_status === 401 && probe.error_code === "invalid_token") {
    return component({
      id: "postgres",
      name: "Conectividade PostgreSQL",
      area: "producao",
      scope: "producao",
      state: "operacional",
      checked_at: now,
      http_status: 401,
      response_ms: probe.response_ms ?? null,
      detail: `A API consultou a credencial e recusou a prova em ${probe.response_ms} ms. Isso verifica conectividade, não a integridade do banco. O 401 da borda HTTP é outra verificação.`,
    })
  }
  if (probe.http_status >= 500) {
    return component({
      id: "postgres",
      name: "Conectividade PostgreSQL",
      area: "producao",
      scope: "producao",
      state: "indisponivel",
      failure_class: "componente",
      checked_at: now,
      http_status: probe.http_status,
      response_ms: probe.response_ms ?? null,
      detail: "A consulta de credencial pela API falhou antes de concluir.",
    })
  }
  return component({
    id: "postgres",
    name: "Conectividade PostgreSQL",
    area: "producao",
    scope: "producao",
    state: "degradado",
    failure_class: "componente",
    checked_at: now,
    http_status: probe.http_status ?? null,
    response_ms: probe.response_ms ?? null,
    detail: "A consulta de credencial devolveu uma resposta diferente da esperada.",
  })
}

export function directDatabase(now) {
  return component({
    id: "postgres_direto",
    name: "PostgreSQL direto",
    area: "producao",
    scope: "informativo",
    state: "desconhecido",
    checked_at: now,
    detail: "Sem papel somente leitura autorizado. Nenhuma sessão direta foi aberta.",
  })
}

export function localComponents(now) {
  const common = {
    area: "local",
    scope: "informativo",
    state: "desconhecido",
    checked_at: now,
    last_seen: null,
    heartbeat: false,
    detail: "Sem heartbeat confiável e sem consulta somente leitura autorizada. Um cadastro ou um contato antigo não seria tratado como operação.",
  }
  return [
    component({ ...common, id: "satellites", name: "Satellites" }),
    component({ ...common, id: "agents", name: "Agentes" }),
    component({ ...common, id: "executors", name: "Executores" }),
    component({ ...common, id: "local_integrations", name: "Integrações locais" }),
  ]
}

function shortSha(sha) {
  return typeof sha === "string" && sha.length >= 7 ? sha.slice(0, 7) : null
}

function deployState(vercel) {
  if (!vercel) return "sem_status"
  if (vercel.state === "success") return "sucesso"
  if (vercel.state === "failure" || vercel.state === "error") return "falha"
  if (vercel.state === "pending") return "em_andamento"
  return "sem_status"
}

export function classifyDeploy(input, now) {
  const empty = {
    source: "status-do-commit",
    checked_at: now,
    integration: null,
    production: null,
    latest: null,
    main_sha: null,
    diverged: null,
    history: [],
    failures: [],
  }
  if (input.auth_error) {
    empty.integration = component({
      id: "github_vercel",
      name: "Integração GitHub → Vercel",
      area: "implantacao",
      scope: "informativo",
      state: "desconhecido",
      failure_class: "autenticacao",
      checked_at: now,
      detail: "Falha de autenticação da integração. O coletor não leu os commits.",
    })
    return empty
  }
  if (input.collector_error) {
    empty.integration = component({
      id: "github_vercel",
      name: "Integração GitHub → Vercel",
      area: "implantacao",
      scope: "informativo",
      state: "desconhecido",
      failure_class: "coleta",
      checked_at: now,
      detail: "Falha da coleta ao consultar o GitHub. O estado da implantação não foi confirmado.",
    })
    return empty
  }
  const commits = Array.isArray(input.commits) ? input.commits : []
  const withStatus = commits.filter((commit) => commit.vercel)
  const integration = component({
    id: "github_vercel",
    name: "Integração GitHub → Vercel",
    area: "implantacao",
    scope: "informativo",
    state: withStatus.length ? "operacional" : "degradado",
    failure_class: withStatus.length ? null : "componente",
    checked_at: now,
    detail: withStatus.length
      ? "A Vercel publicou status nos commits recentes da branch principal. A API de deployments do GitHub não é a fonte desta seção."
      : "A integração não publicou status da Vercel nos commits recentes.",
  })
  const newest = commits[0] ?? null
  const published = commits.find((commit) => commit.vercel?.state === "success") ?? null
  const history = commits.slice(0, 8).map((commit) => ({
    sha: shortSha(commit.sha),
    state: deployState(commit.vercel),
    at: commit.vercel?.updated_at || commit.date || null,
    summary: sanitize(commit.vercel?.description || "Status não publicado pela integração.", input.secrets),
  }))
  const failures = commits
    .filter((commit) => deployState(commit.vercel) === "falha")
    .map((commit) => ({
      sha: shortSha(commit.sha),
      at: commit.vercel?.updated_at || commit.date || null,
      summary: sanitize(commit.vercel?.description || "Motivo não informado pela integração.", input.secrets),
    }))
  return {
    source: "status-do-commit",
    checked_at: now,
    integration,
    production: published
      ? {
          state: "publicado",
          sha: shortSha(published.sha),
          published_at: published.vercel.updated_at || published.date || null,
        }
      : { state: "desconhecido", sha: null, published_at: null },
    latest: newest
      ? {
          sha: shortSha(newest.sha),
          state: deployState(newest.vercel),
          at: newest.vercel?.updated_at || newest.date || null,
          same_as_production: Boolean(published && published.sha === newest.sha),
        }
      : null,
    main_sha: shortSha(newest?.sha),
    diverged: Boolean(published && newest && published.sha !== newest.sha),
    history,
    failures,
  }
}

export function worst(states) {
  let selected = "operacional"
  for (const state of states) {
    if ((STATE_RANK[state] ?? 1) > STATE_RANK[selected]) selected = state
  }
  return states.length ? selected : "desconhecido"
}

export function countStates(components) {
  const counts = { operacional: 0, degradado: 0, indisponivel: 0, desconhecido: 0 }
  for (const item of components) {
    if (counts[item.state] !== undefined) counts[item.state] += 1
  }
  return counts
}

export function diffEvents(previous, components, deploy, now) {
  const prior = new Map((previous?.components ?? []).map((item) => [item.id, item.state]))
  const events = []
  if (!previous) return events
  for (const item of components) {
    const before = prior.get(item.id)
    if (!before || before === item.state) continue
    const recovered = item.state === "operacional" && (before === "indisponivel" || before === "degradado")
    events.push({
      at: now,
      kind: recovered ? "recuperacao" : item.state === "indisponivel" || item.state === "degradado" ? "falha" : "mudanca",
      component: item.name,
      summary: recovered
        ? `${item.name} voltou a operacional.`
        : `${item.name} passou de ${before} para ${item.state}.`,
    })
  }
  const seen = new Set((previous.deployments?.failures ?? []).map((item) => item.sha))
  for (const failure of deploy.failures ?? []) {
    if (!failure.sha || seen.has(failure.sha)) continue
    events.push({
      at: now,
      kind: "falha",
      component: "Implantação",
      summary: `A implantação ${failure.sha} falhou. A produção publicada não muda de estado por causa desse registro.`,
    })
  }
  const older = Array.isArray(previous.events) ? previous.events : []
  return [...events, ...older].slice(0, 20)
}

export function buildReport({ now, probes, github, previous, secrets = [], collector = "local" }) {
  const networkDown = ["root", "login"].every((key) => probes.frontend?.[key]?.error === "network" || probes.frontend?.[key]?.error === "timeout")
    && (probes.backend?.error === "network" || probes.backend?.error === "timeout")
    && (probes.postgres?.error === "network" || probes.postgres?.error === "timeout")
    && (!probes.supabase?.configured || probes.supabase?.error === "network" || probes.supabase?.error === "timeout")
  const adjusted = networkDown
    ? {
        frontend: { root: { error: "collector" }, login: { error: "collector" } },
        backend: { error: "collector" },
        supabase: { ...probes.supabase, error: probes.supabase?.configured ? "collector" : undefined },
        postgres: { error: "collector" },
      }
    : probes
  const production = [
    classifyFrontend(adjusted.frontend, now),
    classifyBackend(adjusted.backend, now),
    classifySupabase(adjusted.supabase, now),
    classifyPostgres(adjusted.postgres, now),
    directDatabase(now),
  ]
  const local = localComponents(now)
  const deployments = classifyDeploy({ ...github, secrets }, now)
  const components = [...production, ...local, deployments.integration].filter(Boolean)
  for (const item of components) item.detail = sanitize(item.detail, secrets)
  const productionState = worst(production.filter((item) => item.scope === "producao").map((item) => item.state))
  const report = {
    schema: 1,
    generated_at: now,
    collector,
    stale_after_seconds: STALE_MS / 1000,
    schedule: "A coleta está agendada a cada 5 minutos. O GitHub Actions não garante o minuto exato.",
    production_state: productionState,
    environment_state: worst(components.map((item) => item.state)),
    counts: countStates(components),
    components,
    deployments,
    events: diffEvents(previous, components, deployments, now),
    note: networkDown ? "Falha da coleta: nenhuma sonda remota completou. Os estados não foram confirmados." : null,
  }
  assertPublic(report, secrets)
  return report
}
