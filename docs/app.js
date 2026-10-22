import { DEPLOY_LABEL, FAILURE_LABEL, STATE_LABEL, formatWhen, presentation } from "./logic.js"

const app = document.querySelector("#app")
const notice = document.querySelector("#notice")

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function pill(state) {
  const node = el("span", `pill ${state}`, STATE_LABEL[state] || state)
  return node
}

function stat(label, value) {
  const node = el("div", "stat")
  node.append(el("span", "", label), el("strong", "", String(value)))
  return node
}

function card(component) {
  const node = el("article", "card")
  const head = el("div", "row")
  head.append(el("h3", "", component.name), pill(component.state))
  node.append(head)
  if (component.failure_class && FAILURE_LABEL[component.failure_class]) {
    node.append(el("p", "meta", FAILURE_LABEL[component.failure_class]))
  }
  node.append(el("p", "detail", component.detail || ""))
  const bits = [`Última verificação: ${formatWhen(component.checked_at)}`]
  if (component.http_status) bits.push(`HTTP ${component.http_status}`)
  if (Number.isInteger(component.response_ms)) bits.push(`${component.response_ms} ms`)
  if (component.area === "local") {
    bits.push(`Última comunicação: ${component.last_seen ? formatWhen(component.last_seen) : "não disponível"}`)
    if (component.heartbeat === false) bits.push("Sem heartbeat confiável")
  }
  node.append(el("p", "meta", bits.join(" · ")))
  return node
}

function section(title, components) {
  const wrap = el("section", "area")
  wrap.append(el("h2", "", title))
  const grid = el("div", "grid")
  for (const component of components) grid.append(card(component))
  wrap.append(grid)
  return wrap
}

function deploySection(report) {
  const wrap = el("section", "area")
  wrap.append(el("h2", "", "Implantações"))
  wrap.append(el("p", "detail", "Uma implantação com falha fica nesta seção. Ela não classifica a aplicação publicada como indisponível."))
  const deploy = report.deployments || {}
  const grid = el("div", "grid")
  if (deploy.integration) grid.append(card(deploy.integration))
  const production = el("article", "card")
  production.append(el("h3", "", "Versão publicada"))
  const published = deploy.production
  production.append(el("p", "detail", published?.sha
    ? `${DEPLOY_LABEL[published.state] || published.state}. SHA ${published.sha}. Publicação em ${formatWhen(published.published_at)}.`
    : "A versão publicada não foi identificada nesta coleta."))
  production.append(el("p", "meta", "Fonte: status que a integração Vercel publica no commit da branch principal."))
  grid.append(production)
  const latest = el("article", "card")
  latest.append(el("h3", "", "Último deployment"))
  if (deploy.latest) {
    latest.append(el("p", "detail", `SHA ${deploy.latest.sha || "—"}. ${DEPLOY_LABEL[deploy.latest.state] || deploy.latest.state}. ${formatWhen(deploy.latest.at)}.`))
    latest.append(el("p", "meta", deploy.diverged
      ? `O SHA da branch principal (${deploy.main_sha}) diverge do SHA publicado (${deploy.production?.sha || "—"}). A produção não foi marcada como indisponível por isso.`
      : `O SHA publicado é o mesmo da branch principal (${deploy.main_sha || "—"}).`))
  } else {
    latest.append(el("p", "detail", "O último deployment não foi lido nesta coleta."))
  }
  grid.append(latest)
  wrap.append(grid)

  const history = el("div", "stack")
  history.append(el("h3", "", "Histórico recente"))
  const table = document.createElement("table")
  const head = document.createElement("tr")
  for (const label of ["SHA", "Estado", "Quando", "Resumo"]) head.append(el("th", "", label))
  table.append(head)
  for (const item of deploy.history || []) {
    const row = document.createElement("tr")
    row.append(el("td", "", item.sha || "—"), el("td", "", DEPLOY_LABEL[item.state] || item.state), el("td", "", formatWhen(item.at)), el("td", "", item.summary || ""))
    table.append(row)
  }
  if (!(deploy.history || []).length) {
    const row = document.createElement("tr")
    const cell = el("td", "", "Sem histórico nesta coleta.")
    cell.colSpan = 4
    row.append(cell)
    table.append(row)
  }
  history.append(table)
  wrap.append(history)

  const failures = el("div", "card")
  failures.append(el("h3", "", "Falhas recentes"))
  if ((deploy.failures || []).length) {
    for (const failure of deploy.failures) {
      failures.append(el("p", "detail", `${failure.sha} · ${formatWhen(failure.at)} · ${failure.summary || "Motivo não informado pela integração."}`))
    }
  } else {
    failures.append(el("p", "detail", "Nenhuma falha no histórico recente."))
  }
  wrap.append(failures)
  return wrap
}

function eventsSection(events) {
  const wrap = el("section", "area")
  wrap.append(el("h2", "", "Eventos"))
  const box = el("div", "card")
  if (!events?.length) {
    box.append(el("p", "detail", "Nenhuma mudança de estado desde a coleta anterior."))
  } else {
    for (const event of events) {
      const row = el("div", "event")
      row.append(el("strong", "", `${formatWhen(event.at)} · ${event.component}`), el("p", "detail", event.summary || ""))
      box.append(row)
    }
  }
  wrap.append(box)
  return wrap
}

function renderReady(report) {
  app.replaceChildren()
  const summary = el("section", "summary")
  const headline = el("article", "card")
  headline.append(el("span", "", "Estado da produção"))
  headline.append(el("strong", `headline ${report.production_state}`, STATE_LABEL[report.production_state] || report.production_state))
  headline.append(el("p", "meta", `Ambiente completo: ${STATE_LABEL[report.environment_state] || report.environment_state}. Componentes sem evidência permanecem desconhecidos e não alteram o estado da produção.`))
  headline.append(el("p", "meta", `Última coleta: ${formatWhen(report.generated_at)}. ${report.schedule || ""}`))
  if (report.note) headline.append(el("p", "detail", report.note))
  summary.append(headline)
  summary.append(stat("Operacionais", report.counts.operacional))
  summary.append(stat("Degradados", report.counts.degradado))
  summary.append(stat("Indisponíveis", report.counts.indisponivel))
  summary.append(stat("Desconhecidos", report.counts.desconhecido))
  app.append(summary)
  const byArea = (area) => report.components.filter((item) => item.area === area && item.id !== "github_vercel")
  app.append(section("Produção", byArea("producao")))
  app.append(section("Componentes locais", byArea("local")))
  app.append(deploySection(report))
  app.append(eventsSection(report.events))
}

function renderBlocked(view) {
  app.replaceChildren()
  const box = el("section", "card")
  box.append(el("h2", "", "Relatório"))
  if (view.generated_at) box.append(el("p", "meta", `Última coleta recebida: ${formatWhen(view.generated_at)}.`))
  box.append(el("p", "detail", "Os estados deixam de ser exibidos até que uma coleta nova confirme a situação."))
  app.append(box)
}

function showNotice(view) {
  if (view.mode === "ok") {
    notice.hidden = true
    notice.textContent = ""
    return
  }
  notice.hidden = false
  notice.className = view.mode === "desatualizado" ? "notice" : "notice bad"
  notice.textContent = view.message
}

async function tick() {
  try {
    const response = await fetch(`status.json?ts=${Date.now()}`, { cache: "no-store" })
    if (!response.ok) throw new Error("read")
    const report = await response.json()
    const view = presentation(report, Date.now())
    showNotice(view)
    if (view.showStates) renderReady(report)
    else renderBlocked(view)
  } catch {
    const view = presentation(null, Date.now())
    showNotice(view)
    renderBlocked(view)
  }
}

tick()
setInterval(tick, 60_000)
