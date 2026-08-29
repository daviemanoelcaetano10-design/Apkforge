// APKForge backend
// Orquestra builds reais disparando um workflow no GitHub Actions,
// consulta o progresso e serve o .apk final para download.
//
// Requer Node 18+ (usa fetch nativo).

import express from "express";
import cors from "cors";
import AdmZip from "adm-zip";
import { randomUUID } from "crypto";

const {
  GITHUB_TOKEN,          // PAT com escopo "repo" + "workflow"
  BUILDER_OWNER,         // dono do repositório "builder" (você ou sua org)
  BUILDER_REPO,          // nome do repositório que contém o workflow
  WORKFLOW_FILE = "build-apk.yml",
  PORT = 3000,
  ALLOWED_ORIGIN = "*",
} = process.env;

if (!GITHUB_TOKEN || !BUILDER_OWNER || !BUILDER_REPO) {
  console.error(
    "Faltam variáveis de ambiente: GITHUB_TOKEN, BUILDER_OWNER, BUILDER_REPO"
  );
  process.exit(1);
}

const GH_API = "https://api.github.com";
const ghHeaders = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

// Guarda em memória o mapeamento build_id -> run_id enquanto o processo vive.
// Em produção, troque por um armazenamento persistente (Redis, banco, etc).
const builds = new Map();

// Bloqueia repos claramente perigosos/óbvios de abusar: só aceita URLs do GitHub.
function isValidGithubUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === "github.com" && u.pathname.split("/").filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

// 1) Dispara o build
app.post("/api/builds", async (req, res) => {
  const { repoUrl } = req.body || {};
  if (!isValidGithubUrl(repoUrl)) {
    return res.status(400).json({ error: "URL de repositório GitHub inválida." });
  }

  const buildId = randomUUID();
  const dispatchedAt = new Date().toISOString();

  const dispatchResp = await fetch(
    `${GH_API}/repos/${BUILDER_OWNER}/${BUILDER_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: "main",
        inputs: { repo_url: repoUrl, build_id: buildId },
      }),
    }
  );

  if (!dispatchResp.ok) {
    const detail = await dispatchResp.text();
    return res.status(502).json({ error: "Falha ao disparar o workflow.", detail });
  }

  builds.set(buildId, { status: "queued", repoUrl, runId: null, dispatchedAt });

  // O dispatch não retorna o run_id diretamente — precisamos localizá-lo
  // procurando, logo em seguida, a run mais recente criada após o dispatch.
  resolveRunId(buildId, dispatchedAt).catch((err) =>
    console.error(`Erro localizando run para build ${buildId}:`, err)
  );

  res.json({ buildId });
});

async function resolveRunId(buildId, dispatchedAt, attempt = 0) {
  if (attempt > 10) return; // ~20s de tentativas
  const resp = await fetch(
    `${GH_API}/repos/${BUILDER_OWNER}/${BUILDER_REPO}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=5`,
    { headers: ghHeaders }
  );
  const data = await resp.json();
  const match = (data.workflow_runs || []).find(
    (run) => new Date(run.created_at) >= new Date(dispatchedAt)
  );

  if (match) {
    const build = builds.get(buildId);
    build.runId = match.id;
    build.status = match.status; // queued | in_progress | completed
    return;
  }

  await new Promise((r) => setTimeout(r, 2000));
  return resolveRunId(buildId, dispatchedAt, attempt + 1);
}

// 2) Consulta o progresso (status geral + passos do job, como um "log")
app.get("/api/builds/:buildId", async (req, res) => {
  const build = builds.get(req.params.buildId);
  if (!build) return res.status(404).json({ error: "Build não encontrado." });
  if (!build.runId) return res.json({ status: "queued", steps: [] });

  const runResp = await fetch(
    `${GH_API}/repos/${BUILDER_OWNER}/${BUILDER_REPO}/actions/runs/${build.runId}`,
    { headers: ghHeaders }
  );
  const run = await runResp.json();

  const jobsResp = await fetch(
    `${GH_API}/repos/${BUILDER_OWNER}/${BUILDER_REPO}/actions/runs/${build.runId}/jobs`,
    { headers: ghHeaders }
  );
  const jobsData = await jobsResp.json();
  const steps = (jobsData.jobs?.[0]?.steps || []).map((s) => ({
    name: s.name,
    status: s.status,
    conclusion: s.conclusion,
  }));

  build.status = run.status;
  build.conclusion = run.conclusion;

  res.json({
    status: run.status,           // queued | in_progress | completed
    conclusion: run.conclusion,   // success | failure | null
    steps,
    htmlUrl: run.html_url,        // link pro log completo no GitHub, se quiser inspecionar
  });
});

// 3) Baixa o artefato (.apk) quando o build terminar com sucesso
app.get("/api/builds/:buildId/download", async (req, res) => {
  const build = builds.get(req.params.buildId);
  if (!build?.runId) return res.status(404).json({ error: "Build não encontrado." });

  const artifactsResp = await fetch(
    `${GH_API}/repos/${BUILDER_OWNER}/${BUILDER_REPO}/actions/runs/${build.runId}/artifacts`,
    { headers: ghHeaders }
  );
  const artifactsData = await artifactsResp.json();
  const artifact = artifactsData.artifacts?.[0];
  if (!artifact) return res.status(404).json({ error: "Nenhum artefato disponível ainda." });

  const zipResp = await fetch(
    `${GH_API}/repos/${BUILDER_OWNER}/${BUILDER_REPO}/actions/artifacts/${artifact.id}/zip`,
    { headers: ghHeaders }
  );
  const zipBuffer = Buffer.from(await zipResp.arrayBuffer());

  // O GitHub sempre entrega artefatos como .zip; extraímos o .apk de dentro
  // para que o usuário baixe o arquivo final diretamente.
  const zip = new AdmZip(zipBuffer);
  const apkEntry = zip.getEntries().find((e) => e.entryName.endsWith(".apk"));
  if (!apkEntry) return res.status(500).json({ error: "Artefato não continha um .apk." });

  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  res.setHeader("Content-Disposition", `attachment; filename="${apkEntry.entryName}"`);
  res.send(apkEntry.getData());
});

app.listen(PORT, () => console.log(`APKForge backend rodando na porta ${PORT}`));
