# Health Check do Platcert

Página pública e independente da aplicação. O GitHub Actions coleta as sondas a cada 5 minutos e o GitHub Pages publica o resultado. O navegador só lê o `status.json` desta página.

A coleta não altera o Platcert, não grava dados e não executa tarefas. Satellite, agentes e executores ficam como Desconhecido enquanto não houver evidência confiável.

Segredos usados apenas no Actions, nunca no site:

- `PLATCERT_READ_TOKEN` — leitura dos commits do repositório privado.
- `SUPABASE_HTTP_URL` — endereço da borda HTTP, sem chave.

O estado das implantações vem do status que a Vercel já publica nos commits. Não há token da Vercel neste repositório.
