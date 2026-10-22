import assert from "node:assert/strict"
import test from "node:test"
import { STALE_MESSAGE, STALE_MS, presentation } from "../docs/logic.js"
import { assertPublic, buildReport, sanitize } from "./report.mjs"

const now = "2026-10-22T18:00:00.000Z"
const nowMs = Date.parse(now)

function healthyProbes() {
  return {
    frontend: {
      root: { http_status: 307, response_ms: 180 },
      login: { http_status: 200, response_ms: 240, identified: true },
    },
    backend: { http_status: 200, response_ms: 400, body_status: "ok", contract_version: "1.0" },
    supabase: { configured: true, http_status: 401, response_ms: 300 },
    postgres: { http_status: 401, response_ms: 280, error_code: "invalid_token" },
  }
}

function githubOk(extra = []) {
  return {
    commits: [
      {
        sha: "119a1c2a730707b539fb9ab794c6d5e452834fde",
        date: "2026-10-22T16:12:09Z",
        vercel: { state: "success", description: "Deployment has completed", updated_at: "2026-10-22T16:12:37Z" },
      },
      ...extra,
    ],
  }
}

test("página fresca mostra estados e página antiga exige o aviso exato", () => {
  const report = buildReport({ now, probes: healthyProbes(), github: githubOk() })
  assert.equal(presentation(report, nowMs).showStates, true)
  const stale = presentation(report, nowMs + STALE_MS + 1)
  assert.equal(stale.showStates, false)
  assert.equal(stale.mode, "desatualizado")
  assert.equal(stale.message, STALE_MESSAGE)
  assert.equal(presentation(null, nowMs).mode, "coleta")
})

test("produção operacional não depende de componentes sem evidência", () => {
  const report = buildReport({ now, probes: healthyProbes(), github: githubOk() })
  assert.equal(report.production_state, "operacional")
  assert.equal(report.environment_state, "desconhecido")
  const unknown = report.components.filter((item) => item.state === "desconhecido").map((item) => item.id)
  assert.deepEqual(unknown.sort(), ["agents", "executors", "local_integrations", "postgres_direto", "satellites"])
  assert.equal(report.components.find((item) => item.id === "satellites").heartbeat, false)
  assert.equal(report.deployments.diverged, false)
  assert.equal(report.deployments.production.sha, "119a1c2")
  assert.equal(report.deployments.latest.same_as_production, true)
})

test("falha de implantação não torna a produção indisponível", () => {
  const report = buildReport({
    now,
    probes: healthyProbes(),
    github: {
      commits: [
        {
          sha: "aaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          date: "2026-10-22T17:00:00Z",
          vercel: { state: "failure", description: "Deployment failed", updated_at: "2026-10-22T17:00:20Z" },
        },
        {
          sha: "119a1c2a730707b539fb9ab794c6d5e452834fde",
          date: "2026-10-22T16:12:09Z",
          vercel: { state: "success", description: "Deployment has completed", updated_at: "2026-10-22T16:12:37Z" },
        },
      ],
    },
  })
  assert.equal(report.production_state, "operacional")
  assert.equal(report.deployments.diverged, true)
  assert.equal(report.deployments.production.sha, "119a1c2")
  assert.equal(report.deployments.latest.sha, "aaaaaaa")
  assert.equal(report.deployments.latest.state, "falha")
  assert.equal(report.deployments.failures.length, 1)
  assert.equal(report.components.find((item) => item.id === "frontend").state, "operacional")
})

test("401 da borda não prova o banco e a consulta de credencial prova conectividade", () => {
  const edgeOnly = buildReport({
    now,
    probes: {
      ...healthyProbes(),
      postgres: { http_status: 500, response_ms: 900 },
    },
    github: githubOk(),
  })
  assert.equal(edgeOnly.components.find((item) => item.id === "supabase_http").state, "operacional")
  assert.equal(edgeOnly.components.find((item) => item.id === "postgres").state, "indisponivel")
  assert.equal(edgeOnly.production_state, "indisponivel")
  assert.match(edgeOnly.components.find((item) => item.id === "supabase_http").detail, /não prova o PostgreSQL/)
})

test("contrato divergente degrada a API e timeout com outras sondas vivas marca indisponível", () => {
  const contract = buildReport({
    now,
    probes: { ...healthyProbes(), backend: { http_status: 200, response_ms: 100, body_status: "ok", contract_version: "9.9" } },
    github: githubOk(),
  })
  assert.equal(contract.components.find((item) => item.id === "backend").state, "degradado")
  const timeout = buildReport({
    now,
    probes: { ...healthyProbes(), backend: { error: "timeout", response_ms: 10000 } },
    github: githubOk(),
  })
  const backend = timeout.components.find((item) => item.id === "backend")
  assert.equal(backend.state, "indisponivel")
  assert.equal(backend.failure_class, "componente")
})

test("falha geral de rede é falha da coleta, não indisponibilidade do ambiente", () => {
  const report = buildReport({
    now,
    probes: {
      frontend: { root: { error: "network" }, login: { error: "network" } },
      backend: { error: "timeout" },
      supabase: { configured: true, error: "network" },
      postgres: { error: "network" },
    },
    github: githubOk(),
  })
  assert.equal(report.production_state, "desconhecido")
  assert.equal(report.note.startsWith("Falha da coleta"), true)
  for (const id of ["frontend", "backend", "supabase_http", "postgres"]) {
    assert.equal(report.components.find((item) => item.id === id).failure_class, "coleta")
  }
})

test("credencial ausente e erro de autenticação ficam distintos da saúde da aplicação", () => {
  const report = buildReport({
    now,
    probes: { ...healthyProbes(), supabase: { configured: false } },
    github: { auth_error: true },
  })
  assert.equal(report.production_state, "desconhecido")
  assert.equal(report.components.find((item) => item.id === "supabase_http").failure_class, "autenticacao")
  assert.equal(report.components.find((item) => item.id === "github_vercel").failure_class, "autenticacao")
  assert.equal(report.components.find((item) => item.id === "frontend").state, "operacional")
})

test("eventos registram recuperação e falha nova de implantação", () => {
  const previous = buildReport({
    now: "2026-10-22T17:00:00.000Z",
    probes: { ...healthyProbes(), backend: { error: "timeout" } },
    github: githubOk(),
  })
  const next = buildReport({
    now,
    previous,
    probes: healthyProbes(),
    github: {
      commits: [
        {
          sha: "bbbbbbbccccccccccccccccccccccccccccccccc",
          date: "2026-10-22T17:40:00Z",
          vercel: { state: "failure", description: "Build failed", updated_at: "2026-10-22T17:41:00Z" },
        },
        ...githubOk().commits,
      ],
    },
  })
  assert.equal(next.events.some((event) => event.kind === "recuperacao" && event.component === "Backend e APIs"), true)
  assert.equal(next.events.some((event) => event.component === "Implantação" && event.summary.includes("bbbbbbb")), true)
  assert.equal(next.production_state, "operacional")
})

test("sanitiza segredo, endereço interno e identificador antes de publicar", () => {
  const secret = "gho_exemploNaoUsarEmLugarNenhum123456"
  const text = sanitize(
    `token ${secret} postgres://user:senha@10.1.2.3/db host aaaabbbbccccdddd.supabase.co ip 192.168.56.20`,
    [secret, "aaaabbbbccccdddd.supabase.co"],
  )
  assert.equal(text.includes(secret), false)
  assert.equal(text.includes("192.168.56.20"), false)
  assert.equal(text.includes("postgres://"), false)
  assert.equal(text.includes("supabase.co"), false)
  assert.throws(() => assertPublic({ vazado: "postgres://user:senha@db/app" }, []))
  assert.throws(() => assertPublic({ vazado: secret }, [secret]))
})
