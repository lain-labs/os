# jlens — Jacobian-lens introspection side channel

The idea: let Lain compare what she said with what she was *disposed* to say,
using the Jacobian lens from
[anthropics/jacobian-lens](https://github.com/anthropics/jacobian-lens)
(reference implementation, Apache-2.0, unmaintained; the estimator is
reimplemented in `jlens_sidecar.py`):

```
lens_l(h) = unembed(J_l @ h),   J_l = E[∂h_final / ∂h_l]
```

Lain's replies come from a hosted model. Lain has none of its weights or
activations, so the lens cannot read production inference. It reads a small
local open-weights instruct model instead (the *proxy*, default
`Qwen/Qwen2.5-0.5B-Instruct`). The proxy runs in a separate Python process,
spawned per call and never in the reply path.

**Read the [findings](#findings) before using the numbers.** In short, the
per-layer readout is a faithful lens on the proxy, but not on Lain.

## Pieces

| Piece | What it does |
|---|---|
| `scripts/jlens/jlens_sidecar.py` | CLI with `status`, `fetch`, `corpus`, `fit`, `introspect` and `compare`. Each prints one JSON object on stdout and logs progress to stderr. |
| `skills/jlens_introspect.mjs` | The chat tool. It has three modes: `introspect`, `compare` (writes to the journal) and `status`. It spawns the sidecar and passes it only `LAINOS_JLENS_*` settings and offline flags, never API keys. |
| `<home>/config.json` | Python, model, corpus, lens and sidecar paths, written by `fetch`, `corpus` and `fit`. Lets the daemon find everything without an env edit. |
| `<data>/jlens/journal.jsonl` | One line per `compare`. It is separate from the trading journal. |

`<home>` is `LAINOS_JLENS_HOME` (default `~/.local/share/lainos/jlens`).
`<data>` is the process's `LAINOS_DATA_DIR`.

## Install

Disk comes first. The sidecar refuses before writing anything if the step
would leave less than a reserve free (`--reserve-gb`, default 2 GiB). It
fails with a message naming the shortfall; it never quietly fills the disk.

| Item | Size (default 0.5B proxy) |
|---|---|
| CPU-only torch + transformers venv (skip if you already have one) | ~1 GiB |
| Proxy weights, bf16 safetensors | 0.93 GiB |
| Fitted lens (23 × 896² fp16, `npz` compressed) | ~35 MiB |
| Fit checkpoint, fp32, deleted when the fit finishes | ~74 MiB (×2 while it is rewritten) |
| Corpus | <100 KiB |

A 1.5B proxy (`LAINOS_JLENS_MODEL=Qwen/Qwen2.5-1.5B-Instruct`) needs 3.1 GiB
of weights and a ~130 MiB lens, and costs about 6× more to fit per prompt.

```bash
# 1. A Python with torch + transformers. Reuse one if you have it, else CPU wheels:
python3 -m venv ~/.local/share/lainos/jlens/venv
~/.local/share/lainos/jlens/venv/bin/pip install --no-cache-dir \
  --index-url https://download.pytorch.org/whl/cpu torch
~/.local/share/lainos/jlens/venv/bin/pip install --no-cache-dir \
  transformers huggingface_hub safetensors numpy
PY=~/.local/share/lainos/jlens/venv/bin/python

# 2. Weights (checks disk first; the Python that runs this becomes the sidecar's).
$PY scripts/jlens/jlens_sidecar.py fetch

# 3. Calibration corpus. Default: the repo's tracked Markdown, cut into ~250
#    passages of 200–700 characters (public, reproducible from a clean clone).
#    Mix in texts in the other languages Lain speaks: .txt/.md are cut into
#    passages, .jsonl takes one {"text": ...} per line.
$PY scripts/jlens/jlens_sidecar.py corpus my-texts.jsonl --with-repo

# 4. The offline fit, resumable and logged. Run it in tmux or under systemd-run.
$PY scripts/jlens/jlens_sidecar.py fit

$PY scripts/jlens/jlens_sidecar.py status   # what is still missing
```

The GPU is not used: the RTX 2060's driver does not answer here, so
everything runs on CPU in float32.

## Fitting time

Per prompt, the fit runs one forward pass and `d_model / dim_batch` backward
passes (112 for the 0.5B proxy). Measured on the i5-11400F, at 60–64 tokens
per prompt, `nice 10`, with the daemon running:

| Threads | Seconds per prompt | 250-prompt corpus | 100 prompts |
|---|---|---|---|
| 4 | 132 | ~9 h | ~3.7 h |
| 6 | FIT6 | FIT6_250 | FIT6_100 |

Peak RSS is about 4 GB. The paper reports usable lenses from ~100 prompts and
saturation well before 1000. `--prompts N` fits on the first N texts only;
the lens is then named `…-nN`. Progress goes to `<home>/logs/fit-<lens>.log`:
seconds per prompt, the largest `‖J‖/√d`, and the shift of the running mean,
which falls roughly as 1/n once the lens settles. A checkpoint is written
after every prompt, so a killed fit resumes where it stopped.

A lens is named `<model>-<sha256 of the weights>-<sha256 of the corpus>`. A
lens fitted on different weights is refused at load time.

## Using it

From chat, the `jlens_introspect` tool:

- `{ mode: "introspect", text, layers?, topk?, position? }`: the top-k tokens
  the proxy is disposed to say next at one position (default: the last), for
  every layer. Also returns a trajectory: each layer's top-1, the rank of the
  proxy's actual next token, and the layer where that token first enters the
  top-k.
- `{ mode: "compare", prompt, said, layers?, topk? }`: the prompt is framed by
  the proxy's chat template and `said` follows as the assistant turn. For each
  token of `said`, it reads where that token ranks in the lens readout of the
  preceding position. The result goes to the journal unless `journal: false`.
- `{ mode: "status" }`: what is installed and the next step.

From the shell:

```bash
$PY scripts/jlens/jlens_sidecar.py introspect --text "The capital of France is"
$PY scripts/jlens/jlens_sidecar.py compare --prompt "…" --said "…" --journal data/jlens/journal.jsonl
```

Without the Python packages, the weights or a lens, every mode returns
`ok: false` with the missing piece and the exact command that installs it.
It never makes up a readout.

## What the metrics mean

All metrics are per layer `l`, over the tokens of `said`. The last row
(`L23` for the 0.5B proxy) is the proxy's real output with no lens applied.

| Metric | Meaning |
|---|---|
| `median_rank` | Median full-vocabulary rank of the said token in the layer-`l` readout. 0 is the top; the vocabulary is ~152k tokens. |
| `mean_log2_rank` | Mean of `log2(1 + rank)`. Less dominated by a few very bad tokens. |
| `overlap@k` | Fraction of said tokens that fall in the readout's top-k (default k = 10). |
| `top1` | Fraction where the said token is the readout's top-1. |
| `nll`, `ppl` | Mean negative log-likelihood (nats per token) of the said tokens under softmax of the readout, and `exp(nll)`. |
| `ppl_shift` | `nll(l) − nll(output)`, in nats per token. Positive means layer `l` was further than the proxy's own output from what was said. |
| `divergence` | The headline: output-layer median rank, overlap@k and ppl, plus the middle layer's overlap@k and ppl shift. |
| `first_token` | The top 5 per layer at the first reply position: what the proxy leaned to open with, next to what was said. |
| `study_flag` | Set when output-layer overlap@k is below `flag_below` (default 0.25). It marks material for self-study, and only that. |

**Evidence, not a lever.** No mode rewrites, retracts, replaces or
re-ranks a reply, and nothing here feeds trading. A journal entry holds
sha256 hashes and character counts of the prompt and reply, never their text,
plus the metrics, the lens id and the first-token readout.

## Limits written into every result

Every `introspect` and `compare` result carries these caveats:

1. **Proxy.** The dispositions are the local stand-in's, not those of the
   production model that wrote the reply.
2. **First-order approximation.** The nonlinearity between layer `l` and the
   output is collapsed into one averaged linear map. At a branch point the
   lens shows the mean direction, not the fork. It is not "the model's
   thoughts".
3. **Corpus prior.** `J_l` is averaged over the calibration corpus. It
   describes the model in general, not this context.
4. **Readout only through the unembedding.** Whatever is not verbalizable is
   invisible by construction.

## Settings

| Setting | Default | |
|---|---|---|
| `LAINOS_JLENS_HOME` | `~/.local/share/lainos/jlens` | weights, corpus, lenses, logs, `config.json` |
| `LAINOS_JLENS_PYTHON` | `config.json` → `python3` | interpreter with torch + transformers |
| `LAINOS_JLENS_MODEL` | `Qwen/Qwen2.5-0.5B-Instruct` | Hub id or local directory (Llama/Qwen/Mistral layout) |
| `LAINOS_JLENS_DTYPE` | `float32` | torch dtype on CPU |
| `LAINOS_JLENS_MAX_LEN` | `512` | token cap for introspect/compare (the prompt is cut from the left) |
| `LAINOS_JLENS_THREADS` | `4` | CPU threads |
| `LAINOS_JLENS_LENS` | the last fitted lens | a specific lens `.npz` |
| `LAINOS_JLENS_SIDECAR` | next to the skill → `config.json` → `./scripts/jlens/` | sidecar path |
| `LAINOS_JLENS_TIMEOUT_MS` | `180000` | per tool call |

## Findings

FINDINGS
