# University IT Helpdesk Triage Demo

A synchronous ticket-triage portfolio demo. The React app submits a title and description to an API Gateway HTTP API. A Lambda runs a LangGraph workflow that classifies the request and drafts a cited answer with Groq, retrieves evidence from Qdrant using local MiniLM embeddings, and stores the ticket and audit trail in DynamoDB. No OpenAI account or key is used.

This is a demo, not a production helpdesk. API routes require a shared API key, but there is no per-user authentication, ticketing integration, human queue, organizational knowledge base, or email/notification delivery. Tickets and escalations are simulated; escalations are marked closed in the audit log. All KB records are synthetic and are used exactly as provided in `kb_articles.json`.

## Included KB

`kb_articles.json` contains 100 records: 20 each for Network & connectivity, Account & access, Software & licensing, Hardware, and Collaboration tools. Six records are marked as stubs. The source records, including their original text and `stub` flags, are not rewritten or expanded by this project.

The classifier schema uses those same five categories so collaboration tickets can be classified and category-filtered retrieval can find their articles.

## Architecture

- `backend/src/graph.ts` implements the classify, risk escalation, Qdrant retrieval, confidence threshold, grounded draft, and persistence nodes.
- Each classify, retrieve, and draft node has one shared failure counter and at most four total attempts. Retry and terminal failure decisions are added to the audit trail.
- Keyword and model risk signals are recorded separately. Either signal escalates.
- `backend/src/embeddings.ts` uses the open `Xenova/all-MiniLM-L6-v2` model through Transformers.js to create normalized 384-dimensional vectors locally. The model weights are downloaded from Hugging Face on first use and cached locally; Lambda caches them under `/tmp` for the lifetime of a warm execution environment.
- `scripts/ingest-kb.ts` is a manual one-off ingestion command. It uses the same local MiniLM model for every article, verifies a 384-dimensional cosine collection, and upserts all source records by deterministic UUID.
- `infra/` defines the HTTP API, Lambda, scoped IAM access, Secrets Manager read access, and DynamoDB ticket table.

The API Gateway HTTP API has a 30-second integration limit. The Lambda uses a 28-second timeout to return before that limit. The first cold Lambda environment must download the embedding model, so its first ticket can take longer or time out if model hosting is slow. Later requests on a warm environment reuse the cached model. A slow provider or repeated failures can also exhaust the synchronous request window before all three nodes use their full retry budgets.

## Prerequisites

- Node.js 22 LTS or 24+ and npm
- Docker Desktop installed and running for CDK to bundle Transformers.js and its native ONNX runtime for Lambda
- An AWS account and configured AWS credentials for CDK
- A Groq API key and a Groq chat model that supports JSON-mode output
- Internet access on the machine running ingestion and from Lambda so Transformers.js can fetch the public embedding model on first use
- A Qdrant Cloud collection endpoint and API key

Install dependencies and make a local environment file:

```sh
npm install
cp .env.example .env
```

Fill in `.env` locally. Do not commit it. Set `GROQ_API_KEY`, `GROQ_CHAT_MODEL`, `QDRANT_URL`, `QDRANT_API_KEY`, and `QDRANT_COLLECTION` to the name of your Qdrant collection. The same collection setting is used for ingestion, sample queries, evaluation, and Lambda deployment. `GROQ_CHAT_MODEL` must be a model currently enabled for your Groq account that supports JSON-mode output. The ingestion and sample-query scripts compute embeddings locally and require Qdrant credentials.

## Seed and Verify Qdrant

The ingestion is separate from Lambda deployment/runtime. It reads the checked-in JSON, computes embeddings locally with Transformers.js, and sends the resulting vectors to Qdrant:

```sh
npm run ingest:kb
npm run test:query
```

The sample query accepts a custom title and description:

```sh
npm run test:query -- "VPN issue" "The VPN will not connect from home."
```

Review cosine-similarity scores for relevant and unrelated sample tickets before relying on the configured `0.6` threshold. Adjust the threshold based on observed results to balance missed relevant matches against unrelated matches.

## Deploy the Backend

Create a random API key for this demo and store it with the provider credentials. For example, `openssl rand -hex 32` creates a 64-character key. Do not paste the generated value into source code or chat. Create a Secrets Manager secret whose JSON string has these exact keys:

```json
{
  "GROQ_API_KEY": "your Groq API key",
  "QDRANT_URL": "your Qdrant Cloud URL",
  "QDRANT_API_KEY": "your Qdrant Cloud API key",
  "TICKET_API_KEY": "your generated 64-character API key"
}
```

Set `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION` in the environment. Deploy with the frontend origin, secret ARN, and the Groq model ID you selected:

```sh
npx cdk deploy \
  -c frontendOrigin=http://localhost:5173 \
  -c triageSecretArn=arn:aws:secretsmanager:REGION:ACCOUNT:secret:SECRET_NAME \
  -c groqChatModel=YOUR_GROQ_MODEL_ID
```

The model ID is an explicit deployment choice; use a model enabled for your Groq account with JSON-mode support. CDK prints the API URL and DynamoDB table name. Lambda reads the Groq, Qdrant, and ticket API key from Secrets Manager.

## Run the Frontend

Set `VITE_API_BASE_URL` in `.env` to the deployed API URL and `VITE_TICKET_API_KEY` to the same generated key stored as `TICKET_API_KEY`, then run:

```sh
npm run dev
```

Open `http://localhost:5173`. The API's `frontendOrigin` must match the browser origin exactly. This shared key is included in browser requests; keep this demo frontend local. Anyone can extract the key from a publicly hosted JavaScript app. For a public frontend, replace this demo key with per-user sign-in and JWT authorization, such as Amazon Cognito.

## Checks

```sh
npm run typecheck
npm test
npm run build
```

## Agent Evaluation

The evaluation layer wraps the existing graph and does not change its production routing. The golden dataset is in `backend/src/evaluation-cases.json`; scenarios use the synthetic categories and articles in `kb_articles.json`. Graph node updates are captured through LangGraph streaming, while wrappers record classifier/draft model calls, embeddings, Qdrant queries, and persistence input. The report includes final state, ordered node trace, tool arguments/results/errors, per-level scores, and failures.

Level 0 checks category, risk, status, response presence, required phrases, and citation validity deterministically. Level 1 checks required/forbidden nodes, ordering, routing, termination, call limits, duplicate calls, and retries; expected behavior is expressed as properties so equivalent valid routes remain allowed. Level 2 validates observed tool contracts. Existing unit tests cover deterministic risk detection, structured-output normalization, and retry behavior. When enabled, the Groq judge adds semantic scores for final correctness, understanding, completeness, grounding, trajectory appropriateness/efficiency, and classifier/draft quality. Each judge response is schema-validated JSON with scores from 0 to 1. Deterministic failures are not overridden by judge scores.

The judge is disabled by default. Enable it with `EVAL_ENABLE_LLM_JUDGE=true` in `.env`; it uses the configured `GROQ_CHAT_MODEL` with temperature 0 and sends only the ticket, expected behavior, result, and relevant retrieved article data. Treat evaluation reports as sensitive because traces include submitted ticket text. Some retrieval outcomes depend on the live Qdrant collection and similarity threshold. The `ticket_013_qdrant_retries_exhausted` case injects four Qdrant failures inside the evaluation-only wrapper to verify the retry/error path; no production dependency or graph code is changed.

Every report also includes deterministic aggregate classification metrics computed directly from explicit golden labels, independently of the LLM judge. Ticket category includes per-class precision/recall/F1, macro and support-weighted averages, accuracy, support, and an actual-by-predicted confusion matrix. Macro averages use classes present in the evaluated ground truth or predictions; all configured categories remain visible in per-class and confusion-matrix output. High-risk and escalation decisions include precision, recall, F1, accuracy, support, and TP/FP/TN/FN counts. Cases without an explicit expected label are excluded for that decision; in particular, the vague request is not guessed into an escalation label. A missing binary prediction is counted as negative and reported as unclassified. Zero denominators produce `0` for precision, recall, or F1. Priority/severity and team assignment are not included because the current agent does not emit those decisions.

Run the complete dataset or select a level, case, or tag:

```sh
npm run evaluate
npm run evaluate -- --level 0
npm run evaluate -- --level 1
npm run evaluate -- --level 2
npm run evaluate -- --case ticket_001_vpn_home
npm run evaluate -- --filter security_stub
npm run evaluate -- --output evaluation-results.json
```

This project uses Vitest rather than pytest. The evaluator itself is covered by the normal test command, and those unit tests need no Groq or Qdrant credentials:

```sh
npm test
npm test --workspace backend -- src/evaluation.test.ts
```

To add a case, append a unique object to `backend/src/evaluation-cases.json`. Set only assertions that are stable for the scenario: `category`, `highRisk`, `status`, `requiredNodes`, `forbiddenNodes`, `nodeOrder`, `requiredTools`, call limits, response phrases, and/or `shouldRetry`. Tags support `--filter`. `faultInjection` is reserved for controlled evaluation failures and currently supports tool names such as `qdrant.query`; it affects only the evaluation wrapper. Avoid specifying one exact full trajectory when several routes can be valid.