# AI DevOps Incident & Error Resolver — Full Project Documentation

**Location:** `E:\Projects\AI DevOps`
**Test repo:** github.com/GaiusDuddey/AI-DevOps (cloned locally to `test-repo`)
**Stack:** Docker + n8n (workflow engine) + ngrok (tunnel) + Groq (LLM inference) + GitHub API + Node.js sandbox runner

---

## 1. High-Level Architecture

```
GitHub Actions failure
        │  (webhook)
        ▼
   ngrok tunnel ──► n8n Webhook node
        │
        ▼
  Filter: only completed+failure runs (IF node)
        │
        ▼
  Fetch CI log zip (GitHub API) → decompress → clean/truncate text
        │
        ▼
  Agent1 (Groq LLM): extract error_message, file_name, line_number, failing_dependency
        │
        ▼
  Merge extracted data with repo/commit info (Merge_AgentData)
        │
        ▼
  Fetch the actual faulty file's source code from GitHub
        │
        ▼
  Agent2 (Groq LLM): diagnose root cause + confidence score
        │
        ▼
  ConfidenceGate (IF, >=70%)
   ├── TRUE ──► Agent3 (Groq LLM): generate fixed code
   │              │
   │              ▼
   │          Sandbox runner (local Node.js server + Docker):
   │          writes fixed file, runs pytest inside a throwaway
   │          python:3.11-slim container
   │              │
   │              ▼
   │          TestPassed (IF, exitCode == 0)
   │           ├── TRUE ──► Create GitHub branch → commit fix → open PR
   │           └── FALSE ──► Jira ticket + Discord alert (sandbox failure)
   │
   └── FALSE ──► Jira ticket + Discord alert (low confidence, no auto-fix attempted)
```

---

## 2. Part 1 — Base Environment (Docker, n8n, Tunnel)

### What was built
- Folder structure under `E:\Projects\AI DevOps`: `n8n-data/`, `workflows/`, `sandbox/`, `docs/`
- Docker Desktop installed (WSL2 backend)
- `docker-compose.yml` defining an `n8nio/n8n:latest` container:
  - Port 5678 exposed
  - Persistent volume `./n8n-data:/home/node/.n8n`
  - `./sandbox:/sandbox` mounted for later sandbox file writes
  - `WEBHOOK_URL` env var pointing to the public tunnel URL (required so n8n generates correct webhook URLs for GitHub to call)

### Why a tunnel is needed
n8n runs on `localhost:5678`, which GitHub's servers cannot reach directly. A tunnel exposes that local port on a public HTTPS URL.

### Tunnel tool evolution
1. **First attempt: `cloudflared` quick tunnel** — worked, but generates a **new random URL every restart**, meaning the GitHub webhook URL and n8n's `WEBHOOK_URL` would need updating every single time. Rejected as impractical.
2. **Switched to ngrok** — has a **free static domain** feature (one fixed URL forever). Final domain used: `hemistichal-adrienne-militantly.ngrok-free.dev`.

### Errors encountered & fixes
- **`ERR_NGROK_121` — agent version too old (3.3.1 vs required 3.20+):** `ngrok update` claimed success but didn't actually replace the binary. Root cause was a **stale winget-installed exe** conflicting with a newer Microsoft Store–installed version. Fixed by installing ngrok via the **Microsoft Store app** instead of winget, which gave a working modern version (3.39.x).
- **`--domain` flag confusion:** some ngrok builds show `--url` in help text instead of `--domain`; both work depending on version — `--domain=` was used successfully in the end.
- **docker-compose `version:` warning:** harmless, cosmetic only, safe to ignore or delete the `version: "3.8"` line.
- **Accidentally edited `docker-compose.yaml` instead of `docker-compose.yml`** at one point — always double-check the exact filename before editing, since Docker Compose only reads `docker-compose.yml`.

### Restart procedure (every new session)
```cmd
:: Terminal 1
cd "E:\Projects\AI DevOps"
docker compose up -d

:: Terminal 2 (keep open)
cd "E:\Projects\AI DevOps"
ngrok http 5678 --domain=hemistichal-adrienne-militantly.ngrok-free.dev

:: Terminal 3 (keep open)
cd "E:\Projects\AI DevOps\sandbox-runner"
node server.js
```
Docker Desktop app itself must also be running (launch from Start Menu first).

---

## 3. Part 2 — Ingestion Workflow (`01-Ingestion-CI-Failure`)

### Nodes built, in order
| Node | Type | Purpose |
|---|---|---|
| `Webhook` | Webhook | Entry point. POST, path `github-ci-failure`, responds immediately (200) so GitHub doesn't time out waiting |
| `If` | IF | Filters payload: only proceeds when `body.action == "completed"` AND `body.workflow_run.conclusion == "failure"` — ignores successful runs, in-progress runs, etc. |
| `Edit Fields` | Set | Extracts clean fields from the raw GitHub payload: `repo_name`, `run_id`, `commit_sha`, `branch`, `logs_url`, `run_url` |
| `HTTP Request` | HTTP Request | GET request to `logs_url` with GitHub PAT (Header Auth), **Response Format: File** — downloads the CI log as a zip binary |
| `Compression` | Compression (Decompress) | Unzips the log archive. Binary Property: `data`, Output Prefix: `file_` |
| `Code in JavaScript` | Code | Converts the decompressed binary log file(s) into a single text string (`raw_logs`) |
| `Ready for Agent Processing` | NoOp | Marker node — visual checkpoint between ingestion and the agent pipeline |

### GitHub side setup
- Personal Access Token (PAT) with `repo` + `actions:read` scope, stored in n8n as a **Header Auth** credential (`Authorization: Bearer <PAT>`)
- Repository webhook: Payload URL = `https://<ngrok-domain>/webhook/github-ci-failure`, Content type `application/json`, event = **Workflow runs** only (not "Send me everything")

### Errors encountered & fixes
- **`404 Not Found` on the GitHub API call** — happened repeatedly across the whole project whenever an expression resolved to an empty/undefined value (e.g. `repo_name` or `file_name` missing), producing a malformed URL like `.../repos//contents/?ref=`. Root cause was always upstream data not being where the expression assumed it was — fixed by tracing back to the actual source node's real output field names via the Output tab, never assuming.
- **Binary decode producing garbage (`~)^â—+-zo` repeating pattern):** This was the single biggest debugging chain of the whole project. Root cause: this n8n Docker instance stores binary data **by reference** (a short internal ID), not inline as base64 — so `item.binary[key].data` is not the actual file bytes, it's a pointer. Manually calling `Buffer.from(pointer, 'base64')` decodes garbage. **Fix:** use n8n's built-in binary helper `await this.helpers.getBinaryDataBuffer(itemIndex, propertyName)` inside the Code node instead of manually reading `.data`.
- **Wrong file edited (`docker-compose.yaml` vs `.yml`)** — same mistake as Part 1, re-encountered.
- **GitHub Actions workflow YAML accidentally contained docker-compose content** — a copy-paste mistake put the wrong YAML into `.github/workflows/test.yml`, causing "Invalid workflow file" on GitHub. Fixed by clearing and re-pasting the correct CI YAML.

---

## 4. Part 3 — Multi-Agent LLM Workflow

### LLM provider decision
Originally planned to use **Google AI Studio / Gemini**, but switched to **Groq** because Gemini's free tier kept prompting for billing/paid access in practice. Groq's free tier (no card required) proved reliable.

### Groq node setup
- Credential type: native **Groq** credential in n8n (API key from console.groq.com/keys)
- Chat nodes: **Basic LLM Chain** (has a direct Prompt field) + a **Groq Chat Model** sub-node attached to its Model slot (the standalone "Groq Chat Model" node alone has no prompt field — it's a connector, not a chat node)
- Model used: `openai/gpt-oss-120b` (Groq's hosted OSS model) — `llama-3.3-70b-versatile` was not available in the account's model list at the time, so this was substituted

### Nodes built, in order
| Node | Type | Purpose |
|---|---|---|
| `Agent1_LogCleaner` | Basic LLM Chain + Groq Chat Model | Strips log noise, extracts `error_message`, `file_name`, `line_number`, `failing_dependency` as strict JSON |
| `Merge_AgentData` | Code | Parses Agent1's markdown-fenced JSON response, merges it with `repo_name`/`commit_sha` from the `Edit Fields` node into one clean object |
| `Fetch_FaultyFile` | HTTP Request | GET the actual source file from GitHub's contents API using `repo_name` + `file_name` + `commit_sha` |
| `Decode_FileContent` | Code | Decodes the GitHub API's base64 file content into readable source code (`decoded_code`) |
| `Agent2_RootCause` | Basic LLM Chain + Groq Chat Model | Given the error and the source file, diagnoses the exact root cause + confidence (0–100) |
| `Parse_Agent2Output` | Code | Strips markdown fences and parses Agent2's JSON response |
| `ConfidenceGate` | IF | Routes to auto-fix (true) if confidence ≥ 70, else escalation (false) |

### Errors encountered & fixes (this was the longest debugging chain)
1. **Groq "Request too large" (token limit exceeded)** — full CI logs were far bigger than Groq's free-tier per-minute token limit (8000 TPM, log was ~13,600 tokens). **Fix:** truncate `raw_logs` to the last ~6000 characters in the Code node (errors are almost always near the end of a log).
2. **Agent1 returning "I don't see any log" / all-null fields** — happened whenever `raw_logs` was empty or garbled upstream (see binary decode issue above); once that was fixed, Agent1 started returning real data.
3. **LLM responses wrapped in markdown code fences** (```` ```json ... ``` ````) — `JSON.parse()` throws `Unexpected token`` on these. **Fix:** always strip fences with `.replace(/^```json\s*/i, '').replace(/```$/, '').trim()` before parsing any LLM JSON output. This pattern had to be applied to **every** LLM output consumed downstream (Agent1, Agent2, and later Agent3).
4. **`$('NodeName').item.json.field` returning `undefined`** — happened because `Code in JavaScript`'s `return` statement replaced the entire item with only `{ raw_logs: ... }`, silently dropping `repo_name`/`commit_sha` that existed earlier in the chain. n8n's `$('NodeName')` reference only sees what that specific node actually output, not what passed through the whole chain. **Fix:** reference the node that still actually has the field (`Edit Fields`), or explicitly carry fields forward in `return` statements, or centralize everything into one `Merge_AgentData` node that pulls from multiple named nodes at once.
5. **Fetch_FaultyFile hitting the repo root / getting a directory listing instead of a file** — caused by `file_name` resolving empty in the URL expression, producing `.../contents/?ref=...` which GitHub interprets as "list root directory." Symptom cascades into `Decode_FileContent` failing with *"first argument must be of type string... Received undefined"* because `.content` doesn't exist on a directory-listing array.
6. **Transient "Connection error... self-signed certificate in certificate chain" from Groq** — caused by **Kaspersky's HTTPS/SSL traffic scanning** intercepting Docker container's outbound TLS connections and injecting its own certificate, which Docker doesn't trust. **Fix:** Kaspersky → Settings → Network Settings → Encrypted Connections Scan → set to **"Do not scan encrypted connections."** (Remember to switch this back on after the project, or add proper trusted-application exclusions for Docker instead of disabling scanning entirely.)

---

## 5. Part 4 — Sandbox Verification + Auto-PR

### Why a separate Node.js "sandbox runner" server was needed
n8n (this version) has **no "Execute Command" node**, so it cannot run shell commands directly. Workaround: a tiny local Express server (`sandbox-runner/server.js`) runs on the Windows host, listens on port 3939, and n8n calls it via a plain HTTP Request. The server writes the AI's fixed file into `/sandbox` and runs it inside a **throwaway `python:3.11-slim` Docker container** via `docker run --rm -v ...`.

n8n's Docker container reaches this host-side server via `host.docker.internal:3939` (Docker's built-in hostname for reaching the host machine from inside a container).

### Nodes built, in order
| Node | Type | Purpose |
|---|---|---|
| `Agent3_FixProposer` | Basic LLM Chain + Groq Chat Model | Generates corrected source code based on Agent2's diagnosed root cause |
| `Clean_FixedCode` | Code | Strips markdown fences from Agent3's response, produces `fixed_code` |
| `Run_SandboxTest` | HTTP Request | POST to `http://host.docker.internal:3939/run-test` with `{ fileName, fileContent }` — the sandbox server writes the file and runs `pytest` inside Docker, returns `{ exitCode, stdout, stderr }` |
| `TestPassed` | IF | Routes on `exitCode == 0` |
| `Create_Branch` | HTTP Request (true branch) | POST to GitHub `git/refs` — creates a new branch `ai-fix-<short-sha>` pointing at the original commit |
| `Build_CommitBody` | Code (true branch) | Builds the commit JSON body (base64-encodes fixed code, sets branch name) — needed because inline expressions using `Buffer.from()` were unreliable directly in the HTTP Request node's JSON field |
| `Commit_Fix` | HTTP Request (true branch) | **PUT** to GitHub `contents/{file}` — commits the fixed file to the new branch |
| `Create_PR` | HTTP Request (true branch) | POST to GitHub `pulls` — opens a PR from the fix branch into `main`, with root cause + confidence + "sandbox verification passed" in the PR body |

### Errors encountered & fixes
- **No Execute Command / Shell node available** in this n8n installation — solved via the external sandbox-runner server described above (checked via node search: "Execute Command", "Command", "Shell" all returned nothing usable).
- **`JSON parameter needs to be valid JSON` in `Run_SandboxTest`** — the fixed code contains real newlines, which break naive string interpolation inside a JSON literal typed directly in n8n's UI. **Fix:** wrap the whole body in a single expression using `JSON.stringify({...})` rather than hand-typing JSON with embedded expressions.
- **Same `JSON.stringify(...)` + `Buffer.from(...)` combo evaluating to `undefined` inside `Commit_Fix`'s inline expression field** — `Buffer` is not reliably available inside n8n's UI expression sandbox (only inside actual Code nodes). **Fix:** moved all the body-building logic (`Buffer.from().toString('base64')`, string concatenation) into a dedicated `Build_CommitBody` Code node, then just referenced `{{ JSON.stringify($json.body) }}` in the HTTP Request's JSON field.
- **`Commit_Fix` returning 404 "resource not found"** — the node's **Method** was still set to `POST` instead of `PUT`. GitHub's "update file contents" endpoint requires PUT. Easy to miss since `Create_Branch` and `Create_PR` are both POST, but `Commit_Fix` is the odd one out.

---

## 6. Part 5 — Escalation (Jira + Discord)

### Setup
- **Jira**: free Atlassian Cloud account, one project created, API token generated at id.atlassian.com, stored as a Jira Software Cloud credential in n8n (email + token + domain).
- **Discord**: a webhook created in a target channel (Server Settings → Integrations → Webhooks → New Webhook), webhook URL copied.

### Nodes built (two parallel escalation branches)
| Branch | Nodes | Trigger condition |
|---|---|---|
| Low confidence | `Jira_LowConfidence` (Jira: Create issue), `Discord_LowConfidence` (HTTP Request POST to webhook) | `ConfidenceGate` false output — Agent2's confidence < 70% |
| Sandbox test failed | `Jira_SandboxFailed` (Jira: Create issue), `Discord_SandboxFailed` (HTTP Request POST to webhook) | `TestPassed` false output — AI's fix didn't pass pytest in the sandbox |

Both Jira nodes include the error message, repo, file, and (for the sandbox-failed branch) the actual `stdout`/`stderr` from the failed test run, so a human reviewer has full context without needing to dig through n8n.

### Why HTTP Request instead of the native Discord node
The native **Discord node** (Webhook connection type) was configured correctly (verified: credential, message, content type all correct) but consistently produced no output and no message in Discord, even after regenerating the webhook URL. Root-caused by testing the raw webhook URL directly with `curl` from the host (worked) and then from **inside the n8n Docker container** with `wget` (also worked) — proving both the webhook and container networking were fine, meaning the native Discord node itself was the broken link. **Fix:** replaced it entirely with a plain **HTTP Request** node POSTing `{"content": "..."}` as JSON directly to the webhook URL — this worked immediately and became the standard approach for all Discord alerts in this project.

### Errors encountered & fixes
- **Testing a node in isolation ("Execute step") produced no output** for nodes that depend on data from earlier in the real workflow chain (like `$('Merge_AgentData')`) — "Execute step" alone has no upstream context. **Fix:** always trigger the *entire* workflow for a real test (via `git commit --allow-empty && git push`) and inspect the node's output from within that full **Execution**, not via standalone "Execute step."
- **To manually force-test the low-confidence branch** (since Agent2 was consistently returning ~99% confidence), the `ConfidenceGate` condition was temporarily changed to an impossible threshold (`>= 100000`) to force it false, tested, then reverted back to `>= 70`.

---

## 7. Master List of Recurring Lessons (apply these to any future n8n debugging)

1. **Always check a node's actual Output tab**, not just its Parameters — assumptions about field names/shapes are the #1 source of bugs in this project.
2. **`$('NodeName').item.json.field`** only works if that exact node's output actually contains that field — a `return` statement in a Code node that doesn't explicitly carry a field forward will drop it, breaking every later reference to it.
3. **LLM JSON output is not guaranteed clean JSON** — always strip markdown code fences before `JSON.parse()`.
4. **`Buffer` and other Node.js built-ins are unreliable inside inline n8n UI expressions** — do that kind of logic inside a Code node and pass the result forward instead.
5. **"Execute step" tests a node in isolation** and won't have real data from other branches of a multi-branch workflow — use a full trigger + check the Execution history for realistic tests.
6. **GitHub API method matters**: creating a ref = POST, updating file contents = PUT, opening a PR = POST. Mixing these up gives a misleading 404 rather than a clear "wrong method" error.
7. **Kaspersky/AV HTTPS scanning can silently break Docker container TLS connections** — "self-signed certificate in certificate chain" from inside a container, when the same request works fine outside Docker, is a strong signal to check antivirus SSL inspection settings.
8. **Binary data in this n8n/Docker setup is stored by reference**, not inline — always use `this.helpers.getBinaryDataBuffer()` in Code nodes rather than manually reading `.data` as if it were already base64 content.

---

## 8. Local Pre-Commit Layer (Hybrid Addition)

### Why this was added
The original pipeline (Parts 1–5) is **reactive** — it only catches problems *after* a push reaches GitHub Actions and fails. To also catch obvious failures *before* a push ever leaves the machine, a standard local **pre-commit hook** was added as a separate, complementary layer. It does not modify or depend on anything in the n8n pipeline.

### What it does
Runs `pytest` automatically every time `git commit` is run, in that repo. If tests fail, the commit is blocked locally — nothing broken ever reaches GitHub in the first place. If tests pass, the commit proceeds normally.

### Setup steps
```cmd
cd "E:\Projects\AI DevOps\test-repo"
pip install pre-commit
pip install pytest
```

Create `.pre-commit-config.yaml` in the repo root:
```yaml
repos:
  - repo: local
    hooks:
      - id: pytest-check
        name: Run pytest before commit
        entry: python -m pytest
        language: system
        pass_filenames: false
        always_run: true
```

Install the git hook (one-time per repo):
```cmd
python -m pre_commit install
```

Add a `.gitignore` to keep pytest's generated cache files out of version control:
```
__pycache__/
*.pyc
.pytest_cache/
```

### Errors encountered & fixes
- **`pre-commit` command not recognized** — pip installed the script to `C:\Users\Dell\AppData\Roaming\Python\Python311\Scripts`, which wasn't on PATH. Adding it via `setx` required a brand-new terminal window to take effect (existing open terminals don't pick up PATH changes).
- **Windows Device Guard blocked `pre-commit.exe`** ("Part of this app has been blocked... can't confirm who published it") — unsigned executable triggered Windows' application control policy. **Fix:** bypass the blocked `.exe` entirely by invoking pre-commit as a Python module instead: `python -m pre_commit <command>` (works identically, no PATH or signing issues).
- **`Executable pytest not found`** — same root cause as above; pip-installed `pytest.exe` also wasn't on PATH and pre-commit calls it as a bare command. **Fix:** changed the hook's `entry` from `pytest` to `python -m pytest` in `.pre-commit-config.yaml`, sidestepping PATH entirely.
- **`Your pre-commit configuration is unstaged`** — forgot to `git add .pre-commit-config.yaml` before committing; pre-commit refuses to run using an unstaged config. Fixed by staging the config file first.
- **Hook reported "Failed... files were modified by this hook"** even though the actual test passed — pytest generates `__pycache__/` and `.pytest_cache/` on every run, which git then sees as new/modified files, and pre-commit flags that as a failure condition. **Fix:** added the `.gitignore` above so those generated files are never tracked.
- **A stray `__pycache__/*.pyc` file still got committed** despite the `.gitignore` — it had already been staged/committed once *before* the `.gitignore` existed, so git kept tracking it. **Fix:** `git rm -r --cached __pycache__` followed by a commit, which untracks it going forward without deleting the local file.

### How the two layers now work together
| Layer | Catches | Speed | Uses AI? |
|---|---|---|---|
| Pre-commit (local) | Obvious failures, before push | Instant | No |
| n8n pipeline (remote) | Anything that still reaches GitHub Actions and fails | ~10–30 sec after push | Yes — diagnoses, fixes, verifies, opens PR |

To bypass the local hook when genuinely needed (e.g. committing a known-broken WIP branch): `git commit --no-verify`.

---

## 9. Cleanup Reminders
- Multiple test PRs and `ai-fix-*` branches were created on the test repo during development — go delete/close the unneeded ones.
- Kaspersky's "Do not scan encrypted connections" setting was left disabled for this project — switch it back once you're done, or configure a proper Docker exclusion instead.
