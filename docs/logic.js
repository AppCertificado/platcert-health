export const STALE_MS = 15 * 60 * 1000
export const STALE_MESSAGE = "Monitoramento desatualizado — não é possível confirmar o estado atual."

export const STATE_LABEL = {
  operacional: "Operacional",
  degradado: "Degradado",
  indisponivel: "Indisponível",
  desconhecido: "Desconhecido",
}

export const DEPLOY_LABEL = {
  sucesso: "Sucesso",
  falha: "Falha",
  em_andamento: "Em andamento",
  sem_status: "Sem status",
  publicado: "Publicado",
  desconhecido: "Desconhecido",
}

export const FAILURE_LABEL = {
  componente: "Falha do componente",
  coleta: "Falha da coleta",
  autenticacao: "Falha de autenticação da integração",
}

export function presentation(report, now) {
  if (!report || typeof report.generated_at !== "string") {
    return { mode: "coleta", showStates: false, message: "Falha da coleta — não foi possível ler o relatório." }
  }
  const generated = Date.parse(report.generated_at)
  if (Number.isNaN(generated)) {
    return { mode: "coleta", showStates: false, message: "Falha da coleta — o relatório não tem horário válido." }
  }
  if (now - generated > STALE_MS) {
    return { mode: "desatualizado", showStates: false, message: STALE_MESSAGE, generated_at: report.generated_at }
  }
  return { mode: "ok", showStates: true, report }
}

export function formatWhen(iso) {
  if (!iso) return "não disponível"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "não disponível"
  const formatted = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
  return `${formatted} BRT`
}
