# APKForge — repositório → APK, de verdade

Três peças que trabalham juntas:

```
frontend/   → a página que o usuário usa (pode ir na Vercel, Netlify, Cloudflare Pages...)
backend/    → API Node/Express que orquestra os builds
workflow-template/ → o workflow do GitHub Actions que faz a compilação de verdade
```

## Como funciona

1. O usuário cola uma URL de repositório no frontend.
2. O frontend chama `POST /api/builds` no seu backend.
3. O backend dispara o workflow `build-apk.yml` num repositório seu ("builder"),
   passando a URL como input.
4. O GitHub Actions clona o repositório alvo, detecta o tipo de projeto
   (Android nativo, Capacitor ou PWA) e compila com Gradle/Bubblewrap.
5. O frontend consulta `GET /api/builds/:id` a cada poucos segundos e mostra
   o andamento real de cada etapa do job.
6. Quando termina, `GET /api/builds/:id/download` baixa o artefato do GitHub
   e entrega o `.apk` diretamente ao usuário.

## Passo a passo de implantação

### 1. Crie o repositório "builder"

Crie um repositório novo no GitHub (pode ser privado) só para hospedar o
workflow. Copie `workflow-template/.github/workflows/build-apk.yml` para
dentro dele, no mesmo caminho.

### 2. Gere um token do GitHub

Settings → Developer settings → Personal access tokens → Tokens (classic).
Escopos necessários: `repo` e `workflow`.

Guarde esse token com cuidado — ele pode disparar workflows na sua conta.

### 3. Configure e implante o backend

```bash
cd backend
npm install
cp .env.example .env
# edite .env com seu token e o nome do repositório builder
npm start
```

Para produção, implante em Render, Railway, Fly.io ou similar — qualquer
lugar que rode um processo Node de forma contínua. Configure as mesmas
variáveis de ambiente do `.env.example` no painel do provedor.

### 4. Publique o frontend

Antes de publicar `frontend/index.html`, defina a URL pública do backend:

```html
<script>window.APKFORGE_API_BASE = 'https://seu-backend.exemplo.com';</script>
```

Adicione essa linha antes do `<script>` principal no `index.html`, ou sirva
o arquivo com essa variável já injetada pelo seu processo de build.

## Limitações que continuam existindo mesmo com o backend real

- **Bubblewrap não é 100% não-interativo.** O passo de PWA no workflow
  pode precisar de ajustes por repositório (gerar um `twa-manifest.json`
  antecipadamente resolve isso na maioria dos casos).
- **React Native e Flutter** têm toolchains próprios; o workflow atual
  cobre Android nativo, Capacitor e PWA — adicionar os outros dois é
  questão de novos passos condicionais, seguindo o mesmo padrão.
- **Assinatura é de debug.** Para publicar na Play Store de verdade, você
  precisa gerar e gerenciar uma keystore de release — isso envolve guardar
  um segredo com muito cuidado (idealmente fora do repositório builder).
- **Segurança**: este sistema executa código de repositórios arbitrários.
  Antes de abrir isso ao público, adicione autenticação, limite de builds
  por usuário/IP, e considere isolar ainda mais os runners (ex.: runners
  self-hosted efêmeros em containers descartáveis).
