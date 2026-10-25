#!/usr/bin/env python3
"""Jacobian-lens sidecar: a local open-weights stand-in Lain can look inside.

Lain's live replies come from a hosted model whose weights and activations
she never sees, so the lens cannot hang on production inference. It runs here,
on a small local instruct model (the "proxy"), as a separate process that is
never in the reply path. Everything this reads out is the proxy's disposition,
not the production model's.

Subcommands (each prints one JSON object on stdout; progress goes to stderr):

  status      what is installed, what is missing, how much disk is free
  fetch       download the proxy weights; refuses when the disk would run low
  corpus      build the calibration corpus from public text files
  fit         offline job: fit J_l for every layer, logged and resumable
  introspect  per-layer top-k of the lens at one position of a text
  compare     where each token of a reply ranks in the lens readout

The estimator and the readout follow anthropics/jacobian-lens (Apache-2.0,
Copyright 2026 Anthropic PBC), reimplemented compactly for this sidecar:

  lens_l(h) = unembed(J_l @ h),   J_l = E[d h_final / d h_l]

For each prompt, a one-hot cotangent on output dimension i is set at every
valid target position at once and backpropagated, so the gradient at source
position p sums d h_final[p'] / d h_l[p] over p' >= p; rows are averaged over
source positions, then over prompts.

Settings (environment, then <home>/config.json, then the default):
  LAINOS_JLENS_HOME     ~/.local/share/lainos/jlens   weights, corpus, lenses, logs
  LAINOS_JLENS_MODEL    Qwen/Qwen2.5-0.5B-Instruct    Hub id or a local directory
  LAINOS_JLENS_DTYPE    float32                       torch dtype on CPU
  LAINOS_JLENS_MAX_LEN  512                           token cap for introspect/compare
  LAINOS_JLENS_THREADS  4                             CPU threads
  LAINOS_JLENS_LENS     (the last fitted lens)        a lens .npz to use instead
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import logging
import math
import os
import random
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

DEFAULT_MODEL = "Qwen/Qwen2.5-0.5B-Instruct"
GIB = 1024**3
#: Leading positions act as attention sinks with atypical residuals; the
#: reference excludes them from the Jacobian average, and so do we.
SKIP_FIRST = 16
REPO_ROOT = Path(__file__).resolve().parents[2]
SIDECAR = "scripts/jlens/jlens_sidecar.py"

CAVEATS = [
    "Proxy: these are the dispositions of a small local stand-in model, not of the "
    "production model that wrote Lain's reply.",
    "First-order approximation: the nonlinearity between layer l and the output is "
    "collapsed into one averaged linear map; at a branch point the lens shows the "
    "mean direction, not the fork. This is not 'the model's thoughts'.",
    "Corpus prior: J_l is averaged over the calibration corpus; it describes the "
    "model in general, not this particular context.",
    "Readout only through the unembedding: whatever is not verbalizable is invisible "
    "by construction.",
]

log = logging.getLogger("jlens")


class SidecarError(Exception):
    """A failure the operator can act on: what is wrong and the next step."""

    def __init__(self, message: str, step: str | None = None) -> None:
        super().__init__(message)
        self.step = step


# ---------------------------------------------------------------- settings


def jlens_home() -> Path:
    return Path(os.environ.get("LAINOS_JLENS_HOME") or "~/.local/share/lainos/jlens").expanduser()


def load_config() -> dict:
    try:
        return json.loads((jlens_home() / "config.json").read_text())
    except (OSError, ValueError):
        return {}


def save_config(update: dict) -> None:
    path = jlens_home() / "config.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    config = {**load_config(), **update}
    tmp = path.with_suffix(f".tmp.{os.getpid()}")
    tmp.write_text(json.dumps(config, indent=2) + "\n")
    os.replace(tmp, path)


def setting(name: str, default: str) -> str:
    value = os.environ.get(f"LAINOS_JLENS_{name.upper()}")
    if value:
        return value
    value = load_config().get(name)
    return str(value) if value not in (None, "") else default


def model_ref() -> tuple[str, Path]:
    """The proxy's Hub id (or local path) and the directory its weights live in."""
    ref = setting("model", DEFAULT_MODEL)
    local = Path(ref).expanduser()
    if local.is_dir():
        return ref, local
    return ref, jlens_home() / "models" / ref.rstrip("/").split("/")[-1]


def fmt_bytes(n: float) -> str:
    return f"{n / GIB:.2f} GiB" if n >= GIB / 10 else f"{n / 1024**2:.0f} MiB"


def existing_parent(path: Path) -> Path:
    while not path.exists() and path != path.parent:
        path = path.parent
    return path


def require_free(target: Path, need: int, what: str, reserve: int) -> None:
    """Refuse loudly, before writing anything, when ``need`` would eat the reserve."""
    probe = existing_parent(target)
    free = shutil.disk_usage(probe).free
    if free < need + reserve:
        raise SidecarError(
            f"not enough disk for {what}: it needs {fmt_bytes(need)} and a "
            f"{fmt_bytes(reserve)} reserve must stay free, but only {fmt_bytes(free)} "
            f"is free on {probe}. Nothing was written.",
            step="free space on that filesystem, or point LAINOS_JLENS_HOME at a disk "
            "with room (--reserve-gb lowers the reserve at your own risk)",
        )


def have(module: str) -> str | None:
    if importlib.util.find_spec(module) is None:
        return None
    try:
        return importlib.metadata.version(module)
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


INSTALL_STEP = (
    "create a CPU-only environment (about 1 GiB on disk): "
    "python3 -m venv ~/.local/share/lainos/jlens/venv && "
    "~/.local/share/lainos/jlens/venv/bin/pip install --no-cache-dir "
    "--index-url https://download.pytorch.org/whl/cpu torch && "
    "~/.local/share/lainos/jlens/venv/bin/pip install --no-cache-dir "
    "transformers huggingface_hub safetensors numpy; then run "
    f"`<that python> {SIDECAR} fetch` (or point LAINOS_JLENS_PYTHON at a Python "
    "that already has torch and transformers)"
)


def require_deps(*modules: str) -> None:
    missing = [m for m in modules if have(m) is None]
    if missing:
        raise SidecarError(
            f"{sys.executable} lacks {', '.join(missing)}", step=INSTALL_STEP
        )


# ---------------------------------------------------------------- the proxy


def model_fingerprint(model_dir: Path) -> dict:
    """Identity of the weights: Hub revision when fetched, sha256 of the files always."""
    marker = model_dir / ".jlens-model.json"
    try:
        return json.loads(marker.read_text())
    except (OSError, ValueError):
        pass
    digest = hashlib.sha256()
    for path in sorted(model_dir.glob("*.safetensors")):
        digest.update(path.name.encode())
        with path.open("rb") as fh:
            for block in iter(lambda: fh.read(1 << 22), b""):
                digest.update(block)
    info = {"sha256": digest.hexdigest()}
    try:
        marker.write_text(json.dumps(info, indent=2) + "\n")
    except OSError:
        pass
    return info


class Proxy:
    """A loaded HF decoder: its residual blocks, final norm and unembedding."""

    def __init__(self) -> None:
        require_deps("torch", "transformers", "numpy")
        import torch
        import transformers

        self.torch = torch
        ref, model_dir = model_ref()
        if not (model_dir / "config.json").exists():
            raise SidecarError(
                f"proxy weights for {ref} are not installed at {model_dir}",
                step=f"run `{sys.executable} {SIDECAR} fetch` (about 1 GiB for the "
                "default 0.5B model; it checks free disk first)",
            )
        torch.set_num_threads(int(setting("threads", "4")))
        dtype = getattr(torch, setting("dtype", "float32"))
        try:
            hf = transformers.AutoModelForCausalLM.from_pretrained(model_dir, dtype=dtype)
        except TypeError:  # transformers < 4.56 names it torch_dtype
            hf = transformers.AutoModelForCausalLM.from_pretrained(model_dir, torch_dtype=dtype)
        hf.eval()
        for param in hf.parameters():
            param.requires_grad_(False)
        decoder = getattr(hf, "model", None)
        if not all(hasattr(decoder, a) for a in ("layers", "norm", "embed_tokens")):
            raise SidecarError(
                f"{type(hf).__name__} is not a Llama/Qwen-style decoder (model.layers, "
                "model.norm, lm_head)",
                step="use a Llama, Qwen or Mistral family instruct model",
            )
        self.ref, self.dir = ref, model_dir
        self.hf, self.decoder = hf, decoder
        self.layers = decoder.layers
        self.n_layers = len(self.layers)
        self.d_model = hf.config.hidden_size
        self.final = self.n_layers - 1
        self.tokenizer = transformers.AutoTokenizer.from_pretrained(model_dir)
        self.fingerprint = model_fingerprint(model_dir)

    def run(self, input_ids, record, root: int | None = None) -> dict:
        """Forward pass; returns the residual after each block in ``record``.

        ``root`` marks that block's output as the autograd leaf, so the graph a
        fit retains spans only the blocks after it.
        """
        acts: dict = {}

        def hook_for(index: int):
            def hook(_module, _inputs, output):
                tensor = output if self.torch.is_tensor(output) else output[0]
                if index == root:
                    tensor.requires_grad_(True)
                acts[index] = tensor

            return hook

        wanted = sorted(set(record) | ({root} if root is not None else set()))
        handles = [self.layers[i].register_forward_hook(hook_for(i)) for i in wanted]
        try:
            self.decoder(input_ids=input_ids, use_cache=False)
        finally:
            for handle in handles:
                handle.remove()
        return acts

    def unembed(self, residual):
        return self.hf.lm_head(self.decoder.norm(residual)).float()

    def token(self, token_id: int) -> str:
        return self.tokenizer.decode([int(token_id)])

    def encode(self, text: str) -> list[int]:
        return self.tokenizer(text, add_special_tokens=False).input_ids


def lens_id(proxy: Proxy, corpus_sha: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9.]+", "-", proxy.ref.rstrip("/").split("/")[-1])
    return f"{slug}-{proxy.fingerprint['sha256'][:12]}-{corpus_sha[:12]}"


def load_lens(proxy: Proxy, path_arg: str | None) -> tuple[dict, dict, Path]:
    import numpy as np

    path_text = path_arg or setting("lens", "")
    if not path_text:
        raise SidecarError(
            f"no fitted lens for {proxy.ref} yet",
            step=f"build a corpus and run the offline fit: `{sys.executable} {SIDECAR} "
            f"corpus` then `{sys.executable} {SIDECAR} fit` (hours on CPU; see "
            "scripts/jlens/README.md)",
        )
    path = Path(path_text).expanduser()
    if not path.exists():
        raise SidecarError(
            f"the lens file {path} is missing",
            step=f"refit with `{sys.executable} {SIDECAR} fit`",
        )
    with np.load(path, allow_pickle=False) as archive:
        meta = json.loads(str(archive["meta"]))
        jacobians = {
            int(key[2:]): proxy.torch.from_numpy(archive[key].astype(np.float32))
            for key in archive.files
            if key.startswith("J_")
        }
    if meta.get("model_sha256") != proxy.fingerprint["sha256"]:
        raise SidecarError(
            f"the lens {path.name} was fitted on different weights than {proxy.dir}",
            step=f"refit with `{sys.executable} {SIDECAR} fit`",
        )
    return jacobians, meta, path


def transport(jacobians: dict, layer: int, residual):
    """``J_l @ h`` for a lens layer; the last block's output is already final."""
    return residual if layer not in jacobians else residual @ jacobians[layer].T


def pick_layers(requested, jacobians: dict, final: int) -> list[int]:
    available = sorted(jacobians) + [final]
    if not requested:
        return available
    layers = sorted({int(l) + (final + 1 if int(l) < 0 else 0) for l in requested})
    unknown = [l for l in layers if l not in available]
    if unknown:
        raise SidecarError(
            f"layers {unknown} are not available; the lens covers {available[0]}..{final}"
        )
    return layers


# ---------------------------------------------------------------- status / fetch


def cmd_status(_args, _request) -> dict:
    ref, model_dir = model_ref()
    home = jlens_home()
    lens_path = setting("lens", "")
    corpus_path = setting("corpus", "")
    deps = {m: have(m) for m in ("torch", "transformers", "huggingface_hub", "numpy")}
    steps = []
    if not all(deps[m] for m in ("torch", "transformers", "numpy")):
        steps.append(INSTALL_STEP)
    else:
        if not (model_dir / "config.json").exists():
            steps.append(f"`{sys.executable} {SIDECAR} fetch`")
        if not (corpus_path and Path(corpus_path).exists()):
            steps.append(f"`{sys.executable} {SIDECAR} corpus`")
        if not (lens_path and Path(lens_path).exists()):
            steps.append(f"`{sys.executable} {SIDECAR} fit` (offline, hours on CPU)")
    ready = not steps
    lines = [
        f"jlens sidecar: {'ready' if ready else 'not ready'}",
        f"python {sys.executable}: "
        + ", ".join(f"{m} {v or 'MISSING'}" for m, v in deps.items()),
        f"proxy {ref}: {'installed' if (model_dir / 'config.json').exists() else 'missing'} at {model_dir}",
        f"lens: {lens_path or 'none'}",
        f"free disk at {existing_parent(home)}: {fmt_bytes(shutil.disk_usage(existing_parent(home)).free)}",
    ]
    lines += [f"next: {step}" for step in steps]
    return {
        "ok": True,
        "ready": ready,
        "python": sys.executable,
        "deps": deps,
        "home": str(home),
        "model": {"ref": ref, "dir": str(model_dir), "installed": (model_dir / "config.json").exists()},
        "corpus": corpus_path or None,
        "lens": lens_path or None,
        "disk_free_bytes": shutil.disk_usage(existing_parent(home)).free,
        "steps": steps,
        "summary": "\n".join(lines),
    }


WEIGHT_PATTERNS = ["*.safetensors", "*.json", "merges.txt", "vocab.json", "tokenizer*", "*.model"]


def cmd_fetch(args, _request) -> dict:
    require_deps("huggingface_hub")
    # Downloads go straight into the model directory: no chunk cache that would
    # quietly hold a second copy of the weights.
    os.environ.setdefault("HF_XET_CHUNK_CACHE_SIZE_BYTES", "0")
    import fnmatch

    from huggingface_hub import HfApi, snapshot_download

    ref, model_dir = model_ref()
    if Path(ref).expanduser().is_dir():
        raise SidecarError(f"{ref} is a local directory; there is nothing to fetch")
    info = HfApi().model_info(ref, files_metadata=True)
    files = [
        s for s in info.siblings
        if any(fnmatch.fnmatch(s.rfilename, p) for p in WEIGHT_PATTERNS) and "/" not in s.rfilename
    ]
    need = sum(
        (s.size or 0) for s in files
        if not ((model_dir / s.rfilename).exists() and (model_dir / s.rfilename).stat().st_size == s.size)
    )
    require_free(model_dir, need, f"the {ref} weights", int(args.reserve_gb * GIB))
    log.info("fetching %s@%s (%s) into %s", ref, info.sha[:12], fmt_bytes(need), model_dir)
    snapshot_download(ref, revision=info.sha, local_dir=model_dir, allow_patterns=WEIGHT_PATTERNS)
    (model_dir / ".jlens-model.json").unlink(missing_ok=True)
    fingerprint = {**model_fingerprint(model_dir), "repo": ref, "revision": info.sha}
    (model_dir / ".jlens-model.json").write_text(json.dumps(fingerprint, indent=2) + "\n")
    save_config({"python": sys.executable, "model": ref, "sidecar": str(Path(__file__).resolve())})
    size = sum(p.stat().st_size for p in model_dir.glob("*") if p.is_file())
    return {
        "ok": True,
        "model": ref,
        "revision": info.sha,
        "dir": str(model_dir),
        "bytes": size,
        "sha256": fingerprint["sha256"],
        "summary": f"fetched {ref}@{info.sha[:12]} ({fmt_bytes(size)}) into {model_dir}; "
        f"this Python ({sys.executable}) is now the sidecar's interpreter",
    }


# ---------------------------------------------------------------- corpus


def repo_markdown() -> list[Path]:
    out = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "ls-files", "*.md"],
        capture_output=True, text=True, check=True,
    ).stdout.split()
    return [REPO_ROOT / name for name in out]


def passages_of(text: str, low: int, high: int) -> list[str]:
    """Prose paragraphs merged into passages of ``low``..``high`` characters."""
    text = re.sub(r"```.*?```", "\n\n", text, flags=re.S)
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    paragraphs = []
    for block in re.split(r"\n\s*\n", text):
        lines = [l.strip() for l in block.splitlines() if not l.startswith(("    ", "\t"))]
        lines = [l for l in lines if l and not l.startswith(("|", "#", "<")) and not re.fullmatch(r"[-=*_ ]+", l)]
        para = re.sub(r"\s+", " ", " ".join(lines)).strip()
        if para:
            paragraphs.append(para)
    passages, current = [], ""
    for sentence in (s for para in paragraphs for s in re.split(r"(?<=[.!?])\s+", para)):
        if current and len(current) + len(sentence) > high:
            passages.append(current)
            current = ""
        current = f"{current} {sentence[:high]}".strip()
        if len(current) >= low:
            passages.append(current)
            current = ""
    return passages


def cmd_corpus(args, _request) -> dict:
    sources = [Path(f) for f in args.files] if args.files else []
    if args.with_repo or not sources:
        sources += repo_markdown()
    texts: list[str] = []
    for path in sorted(set(sources)):
        raw = path.read_text(errors="replace")
        if path.suffix == ".jsonl":
            for line in raw.splitlines():
                if line.strip():
                    item = json.loads(line)
                    texts.append(item["text"] if isinstance(item, dict) else str(item))
        else:
            texts += passages_of(raw, args.min_chars, args.max_chars)
    seen, unique = set(), []
    for text in texts:
        if len(text) >= args.min_chars and text not in seen:
            seen.add(text)
            unique.append(text)
    random.Random(args.seed).shuffle(unique)
    chosen = unique[: args.max]
    body = "".join(json.dumps({"text": t}, ensure_ascii=False) + "\n" for t in chosen)
    sha = hashlib.sha256(body.encode()).hexdigest()
    path = jlens_home() / "corpus" / f"corpus-{sha[:12]}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)
    save_config({"corpus": str(path)})
    return {
        "ok": True,
        "path": str(path),
        "texts": len(chosen),
        "sha256": sha,
        "sources": len(set(sources)),
        "summary": f"corpus of {len(chosen)} texts from {len(set(sources))} files -> {path}",
    }


# ---------------------------------------------------------------- fit


def jacobian_for_prompt(proxy: Proxy, input_ids, sources: list[int], dim_batch: int) -> dict:
    """Per-prompt ``J_l`` for every source layer (rows averaged over positions)."""
    torch = proxy.torch
    seq_len = input_ids.shape[1]
    valid = torch.arange(SKIP_FIRST, seq_len - 1)
    d_model = proxy.d_model
    jacobians = {l: torch.zeros(d_model, d_model) for l in sources}
    with torch.enable_grad():
        acts = proxy.run(input_ids.expand(dim_batch, -1), record=[*sources, proxy.final], root=min(sources))
        target = acts[proxy.final]
        inputs = [acts[l] for l in sources]
        cotangent = torch.zeros_like(target)
        batch = torch.arange(dim_batch)
        starts = list(range(0, d_model, dim_batch))
        for index, start in enumerate(starts):
            n = min(dim_batch, d_model - start)
            cotangent.zero_()
            cotangent[batch[:n, None], valid[None, :], start + batch[:n, None]] = 1.0
            grads = torch.autograd.grad(
                target, inputs, grad_outputs=cotangent, retain_graph=index < len(starts) - 1
            )
            for layer, grad in zip(sources, grads):
                jacobians[layer][start : start + n] = grad[:n, valid].float().mean(dim=1)
    return jacobians


def cmd_fit(args, _request) -> dict:
    import numpy as np

    if args.nice:
        os.nice(args.nice)
    corpus_path = Path(args.corpus or setting("corpus", "")).expanduser()
    if not corpus_path.is_file():
        raise SidecarError(
            "no calibration corpus", step=f"run `{sys.executable} {SIDECAR} corpus` first"
        )
    proxy = Proxy()
    torch = proxy.torch
    corpus_bytes = corpus_path.read_bytes()
    corpus_sha = hashlib.sha256(corpus_bytes).hexdigest()
    texts = [json.loads(l)["text"] for l in corpus_bytes.decode().splitlines() if l.strip()]
    if args.prompts:
        texts = texts[: args.prompts]
    name = lens_id(proxy, corpus_sha) + (f"-n{len(texts)}" if args.prompts else "")
    lenses = jlens_home() / "lenses"
    out = lenses / f"{name}.npz"
    checkpoint = lenses / f"{name}.ckpt.pt"
    log_path = jlens_home() / "logs" / f"fit-{name}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handler = logging.FileHandler(log_path)
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    log.addHandler(handler)

    lenses.mkdir(parents=True, exist_ok=True)
    sources = list(range(proxy.final))
    d_model = proxy.d_model
    lens_bytes = len(sources) * d_model * d_model * 2
    if not checkpoint.exists():
        require_free(lenses, lens_bytes + 2 * len(sources) * d_model * d_model * 4,
                     "the lens and its checkpoint", int(args.reserve_gb * GIB))

    state = {"sum": {l: torch.zeros(d_model, d_model) for l in sources}, "n_done": 0, "next": 0}
    if checkpoint.exists():
        saved = torch.load(checkpoint, map_location="cpu", weights_only=True)
        state = {"sum": saved["sum"], "n_done": saved["n_done"], "next": saved["next"]}
        log.info("resuming %s at prompt %d/%d", name, state["next"], len(texts))
    log.info(
        "fit %s: %s, %d layers, d_model=%d, %d prompts, max_seq_len=%d, dim_batch=%d, threads=%d",
        name, proxy.ref, proxy.n_layers, d_model, len(texts), args.max_seq_len,
        args.dim_batch, torch.get_num_threads(),
    )
    started = time.perf_counter()
    for index, text in enumerate(texts):
        if index < state["next"]:
            continue
        ids = torch.tensor([proxy.encode(text)[: args.max_seq_len]])
        if ids.shape[1] < SKIP_FIRST + 2:
            log.info("  prompt %d/%d skipped: %d tokens", index + 1, len(texts), ids.shape[1])
            state["next"] = index + 1
            continue
        t0 = time.perf_counter()
        per_prompt = jacobian_for_prompt(proxy, ids, sources, args.dim_batch)
        norm = max(per_prompt[l].norm().item() for l in sources) / math.sqrt(d_model)
        drift = float("nan")
        if state["n_done"]:
            drift = max(
                ((per_prompt[l] - state["sum"][l] / state["n_done"]).norm()
                 / ((state["n_done"] + 1) * (state["sum"][l] / state["n_done"]).norm())).item()
                for l in sources
            )
        for layer in sources:
            state["sum"][layer] += per_prompt[layer]
        state["n_done"] += 1
        state["next"] = index + 1
        log.info(
            "  prompt %d/%d tokens=%d %.0fs max||J||/sqrt(d)=%.3f mean-shift=%.2e",
            index + 1, len(texts), ids.shape[1], time.perf_counter() - t0, norm, drift,
        )
        tmp = checkpoint.with_suffix(f".tmp.{os.getpid()}")
        torch.save(state, tmp)
        os.replace(tmp, checkpoint)
    if not state["n_done"]:
        raise SidecarError("no corpus text was long enough to fit on")

    meta = {
        "id": name,
        "model": proxy.ref,
        "model_sha256": proxy.fingerprint["sha256"],
        "model_revision": proxy.fingerprint.get("revision"),
        "corpus_sha256": corpus_sha,
        "n_prompts": state["n_done"],
        "source_layers": sources,
        "n_layers": proxy.n_layers,
        "d_model": d_model,
        "max_seq_len": args.max_seq_len,
        "skip_first": SKIP_FIRST,
        "fitted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "estimator": "anthropics/jacobian-lens: cotangent summed over targets, mean over sources",
    }
    arrays = {f"J_{l}": (state["sum"][l] / state["n_done"]).numpy().astype(np.float16) for l in sources}
    tmp = out.with_suffix(f".tmp.{os.getpid()}.npz")
    np.savez_compressed(tmp, meta=np.array(json.dumps(meta)), **arrays)
    os.replace(tmp, out)
    checkpoint.unlink(missing_ok=True)
    save_config({"lens": str(out)})
    elapsed = time.perf_counter() - started
    log.info("fit done: %d prompts in %.0fs -> %s (%s)", state["n_done"], elapsed, out, fmt_bytes(out.stat().st_size))
    return {
        "ok": True,
        "lens": str(out),
        "bytes": out.stat().st_size,
        "n_prompts": state["n_done"],
        "seconds": round(elapsed),
        "log": str(log_path),
        "summary": f"lens {name}: {state['n_done']} prompts, {fmt_bytes(out.stat().st_size)}, "
        f"{elapsed / 60:.0f} min -> {out}",
    }


# ---------------------------------------------------------------- readouts


def ranks_of(logits, targets):
    """Full-vocabulary rank of each target (0 = top), one row per position."""
    chosen = logits.gather(-1, targets[:, None])
    return (logits > chosen).sum(-1)


def topk_tokens(proxy: Proxy, logits, k: int) -> list[dict]:
    probs = logits.softmax(-1)
    values, ids = probs.topk(k)
    return [{"token": proxy.token(i), "id": int(i), "p": round(float(v), 4)} for v, i in zip(values, ids)]


def cmd_introspect(args, request) -> dict:
    text = request.get("text")
    if not isinstance(text, str) or not text.strip():
        raise SidecarError("introspect needs a non-empty `text`")
    proxy = Proxy()
    torch = proxy.torch
    jacobians, meta, lens_path = load_lens(proxy, request.get("lens"))
    layers = pick_layers(request.get("layers"), jacobians, proxy.final)
    k = max(1, min(int(request.get("topk") or 5), 50))
    max_len = int(setting("max_len", "512"))
    ids = proxy.encode(text)
    truncated = len(ids) > max_len
    ids = ids[-max_len:]
    position = int(request.get("position", -1))
    if not -len(ids) <= position < len(ids):
        raise SidecarError(f"position {position} is outside the {len(ids)}-token text")
    position %= len(ids)
    with torch.no_grad():
        acts = proxy.run(torch.tensor([ids]), record=[*layers, proxy.final])
        output = proxy.unembed(acts[proxy.final][0, position])
        output_top = int(output.argmax())
        rows = []
        for layer in layers:
            logits = proxy.unembed(transport(jacobians, layer, acts[layer][0, position]))
            rows.append({
                "layer": layer,
                "top": topk_tokens(proxy, logits, k),
                "output_token_rank": int((logits > logits[output_top]).sum()),
            })
    emerges = next((r["layer"] for r in rows if r["output_token_rank"] < k), None)
    lines = [
        f"jlens on {proxy.ref} (lens {meta['id']}, {meta['n_prompts']} prompts), "
        f"next-token readout after {proxy.token(ids[position])!r} (position {position} of {len(ids)}"
        + (", text truncated to its tail" if truncated else "") + "):",
    ]
    lines += [
        f"  L{r['layer']:>2}: " + " ".join(repr(t["token"]) for t in r["top"])
        + f"   (output top rank {r['output_token_rank']})"
        for r in rows
    ]
    lines.append(
        f"The proxy's actual next token {proxy.token(output_top)!r} "
        + (f"first enters the lens top-{k} at layer {emerges}." if emerges is not None else f"never enters the lens top-{k}.")
    )
    lines += [f"Caveat: {c}" for c in CAVEATS]
    return {
        "ok": True,
        "mode": "introspect",
        "proxy": proxy.ref,
        "lens": meta["id"],
        "lens_prompts": meta["n_prompts"],
        "position": position,
        "tokens": len(ids),
        "truncated": truncated,
        "position_token": proxy.token(ids[position]),
        "output_token": proxy.token(output_top),
        "output_emerges_at_layer": emerges,
        "layers": rows,
        "trajectory": [{"layer": r["layer"], "top1": r["top"][0]["token"], "output_token_rank": r["output_token_rank"]} for r in rows],
        "caveats": CAVEATS,
        "summary": "\n".join(lines),
    }


def chat_prefix(proxy: Proxy, prompt: str) -> list[int]:
    """The prompt as the proxy's chat template frames it, up to the reply."""
    template = getattr(proxy.tokenizer, "chat_template", None)
    if template:
        rendered = proxy.tokenizer.apply_chat_template(
            [{"role": "user", "content": prompt}], tokenize=False, add_generation_prompt=True
        )
        return proxy.encode(rendered)
    return proxy.encode(prompt + "\n")


def layer_metrics(logits, targets, k: int) -> dict:
    ranks = ranks_of(logits, targets)
    nll = -logits.log_softmax(-1).gather(-1, targets[:, None]).squeeze(-1)
    return {
        "median_rank": int(ranks.float().median()),
        "mean_log2_rank": round(float(((ranks + 1).float().log2()).mean()), 3),
        f"overlap@{k}": round(float((ranks < k).float().mean()), 4),
        "top1": round(float((ranks == 0).float().mean()), 4),
        "nll": float(nll.mean()),
    }


def cmd_compare(args, request) -> dict:
    prompt, said = request.get("prompt"), request.get("said")
    if not isinstance(prompt, str) or not isinstance(said, str) or not said.strip():
        raise SidecarError("compare needs a `prompt` and a non-empty `said`")
    proxy = Proxy()
    torch = proxy.torch
    jacobians, meta, _ = load_lens(proxy, request.get("lens"))
    layers = pick_layers(request.get("layers"), jacobians, proxy.final)
    if proxy.final not in layers:
        layers.append(proxy.final)
    k = max(1, min(int(request.get("topk") or 10), 100))
    max_len = int(setting("max_len", "512"))
    said_ids = proxy.encode(said)
    said_truncated = len(said_ids) > max_len - 32
    said_ids = said_ids[: max_len - 32]
    prefix = chat_prefix(proxy, prompt)
    prompt_truncated = len(prefix) + len(said_ids) > max_len
    prefix = prefix[-(max_len - len(said_ids)):]
    ids = prefix + said_ids
    positions = torch.arange(len(prefix) - 1, len(ids) - 1)
    targets = torch.tensor(said_ids)
    per_layer, first_token = [], []
    with torch.no_grad():
        acts = proxy.run(torch.tensor([ids]), record=layers)
        for layer in layers:
            logits = proxy.unembed(transport(jacobians, layer, acts[layer][0, positions]))
            per_layer.append({"layer": layer, **layer_metrics(logits, targets, k)})
            first_token.append({"layer": layer, "top": [t["token"] for t in topk_tokens(proxy, logits[0], 5)]})
    output = per_layer[-1]
    for row in per_layer:
        row["ppl"] = round(math.exp(min(row["nll"], 50)), 2)
        row["ppl_shift"] = round(row["nll"] - output["nll"], 3)
        row["nll"] = round(row["nll"], 3)
    mid = per_layer[len(per_layer) // 2]
    best = max(per_layer[:-1] or per_layer, key=lambda r: r[f"overlap@{k}"])
    flag_below = float(request.get("flag_below", 0.25))
    study_flag = output[f"overlap@{k}"] < flag_below
    lines = [
        f"jlens compare on {proxy.ref} (lens {meta['id']}, {meta['n_prompts']} prompts): "
        f"{len(said_ids)} reply tokens"
        + (" (reply truncated)" if said_truncated else "")
        + (" (prompt truncated to its tail)" if prompt_truncated else "") + ".",
        f"  proxy output (L{proxy.final}): median rank {output['median_rank']}, overlap@{k} "
        f"{output[f'overlap@{k}']:.0%}, top-1 {output['top1']:.0%}, ppl {output['ppl']}",
        f"  mid layer L{mid['layer']}: median rank {mid['median_rank']}, overlap@{k} "
        f"{mid[f'overlap@{k}']:.0%}, ppl shift {mid['ppl_shift']:+.2f} nats/token",
        f"  closest lens layer L{best['layer']}: overlap@{k} {best[f'overlap@{k}']:.0%}, "
        f"ppl shift {best['ppl_shift']:+.2f} nats/token",
        f"  first reply token {proxy.token(said_ids[0])!r}; the proxy output leaned to "
        + " ".join(repr(t) for t in first_token[-1]["top"]),
    ]
    if study_flag:
        lines.append(
            f"  divergence is high (output overlap@{k} below {flag_below:.0%}): material for "
            "self-study, never a reason to rewrite or replace a reply."
        )
    lines += [f"Caveat: {c}" for c in CAVEATS]
    result = {
        "ok": True,
        "mode": "compare",
        "proxy": proxy.ref,
        "lens": meta["id"],
        "lens_prompts": meta["n_prompts"],
        "k": k,
        "reply_tokens": len(said_ids),
        "prompt_tokens": len(prefix),
        "said_truncated": said_truncated,
        "prompt_truncated": prompt_truncated,
        "divergence": {
            "output_median_rank": output["median_rank"],
            f"output_overlap@{k}": output[f"overlap@{k}"],
            "output_ppl": output["ppl"],
            "mid_layer": mid["layer"],
            f"mid_overlap@{k}": mid[f"overlap@{k}"],
            "mid_ppl_shift": mid["ppl_shift"],
        },
        "study_flag": study_flag,
        "per_layer": per_layer,
        "first_token": {"said": proxy.token(said_ids[0]), "layers": first_token},
        "caveats": CAVEATS,
        "summary": "\n".join(lines),
    }
    if args.journal:
        entry = {
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "kind": "compare",
            "source": request.get("source"),
            "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
            "said_sha256": hashlib.sha256(said.encode()).hexdigest(),
            "prompt_chars": len(prompt),
            "said_chars": len(said),
            **{key: result[key] for key in (
                "proxy", "lens", "lens_prompts", "k", "reply_tokens", "divergence",
                "study_flag", "per_layer", "first_token",
            )},
        }
        journal = Path(args.journal).expanduser()
        journal.parent.mkdir(parents=True, exist_ok=True)
        with journal.open("a") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        result["journal"] = str(journal)
        result["summary"] += f"\nJournaled to {journal}."
    return result


# ---------------------------------------------------------------- main


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    fetch = sub.add_parser("fetch")
    fetch.add_argument("--reserve-gb", type=float, default=2.0, help="disk that must stay free afterwards")
    corpus = sub.add_parser("corpus")
    corpus.add_argument("files", nargs="*", help=".md/.txt (split into passages) or .jsonl ({\"text\"} per line); default: the repo's tracked Markdown")
    corpus.add_argument("--with-repo", action="store_true", help="add the repo's Markdown to the given files")
    corpus.add_argument("--max", type=int, default=256)
    corpus.add_argument("--min-chars", type=int, default=200)
    corpus.add_argument("--max-chars", type=int, default=700)
    corpus.add_argument("--seed", type=int, default=0)
    fit = sub.add_parser("fit")
    fit.add_argument("--corpus")
    fit.add_argument("--prompts", type=int, help="fit on the first N corpus texts only")
    fit.add_argument("--max-seq-len", type=int, default=64)
    fit.add_argument("--dim-batch", type=int, default=8)
    fit.add_argument("--nice", type=int, default=10, help="lower the job's CPU priority (0 = off)")
    fit.add_argument("--reserve-gb", type=float, default=2.0)
    for name in ("introspect", "compare"):
        readout = sub.add_parser(name)
        readout.add_argument("--json", action="store_true", help="read the request object from stdin")
        readout.add_argument("--text")
        readout.add_argument("--prompt")
        readout.add_argument("--said")
        readout.add_argument("--layers", type=lambda s: [int(x) for x in s.split(",")])
        readout.add_argument("--topk", type=int)
        readout.add_argument("--position", type=int)
        readout.add_argument("--lens")
        readout.add_argument("--journal", help="append the compare result to this JSONL journal")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", stream=sys.stderr)
    request: dict = {}
    if getattr(args, "json", False):
        request = json.loads(sys.stdin.read() or "{}")
    for key in ("text", "prompt", "said", "layers", "topk", "position", "lens"):
        value = getattr(args, key, None)
        if value is not None:
            request[key] = value
    commands = {
        "status": cmd_status, "fetch": cmd_fetch, "corpus": cmd_corpus, "fit": cmd_fit,
        "introspect": cmd_introspect, "compare": cmd_compare,
    }
    try:
        result = commands[args.command](args, request)
    except SidecarError as err:
        result = {"ok": False, "error": str(err), "step": err.step}
        result["summary"] = f"jlens: {err}" + (f"\nNext step: {err.step}" if err.step else "")
    except Exception as err:  # noqa: BLE001 - the caller always gets one JSON line
        log.exception("jlens %s failed", args.command)
        result = {"ok": False, "error": f"{type(err).__name__}: {err}", "step": None}
        result["summary"] = f"jlens {args.command} failed: {type(err).__name__}: {err}"
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main())
