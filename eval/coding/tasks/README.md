# Local coding-search fixtures

Five public bug-fix tasks selected from the official `princeton-nlp/SWE-bench_Lite` test split. These are intentionally a small fixture set, not a benchmark framework.

## Isolation contract

- Give an agent only the manifest's `problem_statement` and a fresh extraction of its base source archive.
- Do **not** expose `manifest.json`, `.tmp/coding-tasks/artifacts/`, dataset records, validation logs, or repository history to the model.
- Source archives contain no `.git`. The two pytest archives add only the generated setuptools-scm `_version.py` needed to execute an archive without Git.
- During grading, start from a fresh base, apply only the agent's source diff (discard agent test edits), then apply the verifier-only official `test.patch` and run `test_command`.
- Agent and verifier containers run with `--network none` and `/workspace` as the isolated bind mount.

The ignored `.tmp/coding-tasks/` tree is the local artifact store. Gold and test patches never belong in model workspaces.

## Selected tasks

| Instance | Base commit | Image | Focused result (base → gold) |
|---|---|---|---|
| `sympy__sympy-19007` | `f9e030b57623bebdc2efa7f297c1b5ede08fcebf` | `jev-coding-sympy:lite-py38` | 3 regression failures → 14 pass, 1 expected failure |
| `sympy__sympy-21379` | `624217179aaf8d094e6ff75b7493ad1ee47599b0` | `jev-coding-sympy:lite-py38` | 1 regression exception → 93 pass, 2 expected failures |
| `pytest-dev__pytest-7220` | `56bf819c2f4eaf8b36bd8c42c06bb59d5a3bfc0f` | `jev-coding-pytest:lite-py38` | 1 fail + 2 pass → 3 pass |
| `pytest-dev__pytest-7373` | `7b77fc086aab8b3a8ebc890200371884555eea1e` | `jev-coding-pytest:lite-py38` | 1 fail + 2 pass → 3 pass |
| `psf__requests-3362` | `36453b95b13079296776d11b09cab2567ea3e703` | `jev-coding-requests:lite-py38` | 1 fail + 2 pass → 3 pass |

Exact issue text, repository breadth, selected `FAIL_TO_PASS`/`PASS_TO_PASS`, commands, artifact hashes, and validation logs are indexed in [`manifest.json`](manifest.json).

## Local images

All three images are Linux arm64, use Python 3.8.20, and are already built locally. Test the IDs before paid runs:

```sh
docker image inspect jev-coding-sympy:lite-py38 \
  --format '{{.Id}} {{.Os}}/{{.Architecture}}'
docker image inspect jev-coding-pytest:lite-py38 \
  --format '{{.Id}} {{.Os}}/{{.Architecture}}'
docker image inspect jev-coding-requests:lite-py38 \
  --format '{{.Id}} {{.Os}}/{{.Architecture}}'
```

Expected IDs are in the manifest. The ignored build definitions are:

- `.tmp/coding-tasks/docker/sympy.Dockerfile`
- `.tmp/coding-tasks/docker/pytest.Dockerfile`
- `.tmp/coding-tasks/docker/requests.Dockerfile`

Rebuild, if needed, from the repository root:

```sh
docker build -f .tmp/coding-tasks/docker/sympy.Dockerfile \
  -t jev-coding-sympy:lite-py38 .tmp/coding-tasks/docker
docker build -f .tmp/coding-tasks/docker/pytest.Dockerfile \
  -t jev-coding-pytest:lite-py38 .tmp/coding-tasks/docker
docker build -f .tmp/coding-tasks/docker/requests.Dockerfile \
  -t jev-coding-requests:lite-py38 .tmp/coding-tasks/docker
```

Installed dependencies observed with `python -m pip freeze`:

- SymPy image: `mpmath==1.1.0`.
- pytest image: `atomicwrites==1.4.1`, `attrs==19.3.0`, `certifi==2026.7.22`, `chardet==4.0.0`, `hypothesis==4.57.1`, `idna==2.10`, `iniconfig==1.1.1`, `mock==4.0.3`, `more-itertools==7.2.0`, `nose==1.3.7`, `packaging==20.9`, `pluggy==0.13.1`, `py==1.11.0`, `pyparsing==3.1.4`, `requests==2.25.1`, `six==1.16.0`, `sortedcontainers==2.4.0`, `toml==0.10.2`, `urllib3==1.26.20`, `wcwidth==0.2.13`.
- Requests image: `attrs==21.4.0`, `iniconfig==2.1.0`, `packaging==26.2`, `pluggy==0.13.1`, `py==1.11.0`, `pytest==6.2.5`, `toml==0.10.2`.

## Reproduction pattern

Set `ID`, consult the corresponding manifest entry, and create fresh base and gold workspaces outside any model workspace:

```sh
ID=sympy__sympy-19007
rm -rf ".tmp/coding-tasks/recheck/$ID"
mkdir -p ".tmp/coding-tasks/recheck/$ID/base" \
         ".tmp/coding-tasks/recheck/$ID/gold"
tar -xzf ".tmp/coding-tasks/sources/$ID.tar.gz" --strip-components=1 \
  -C ".tmp/coding-tasks/recheck/$ID/base"
cp -R ".tmp/coding-tasks/recheck/$ID/base/." \
      ".tmp/coding-tasks/recheck/$ID/gold/"
patch -d ".tmp/coding-tasks/recheck/$ID/base" -p1 \
  < ".tmp/coding-tasks/artifacts/$ID/test.patch"
patch -d ".tmp/coding-tasks/recheck/$ID/gold" -p1 \
  < ".tmp/coding-tasks/artifacts/$ID/test.patch"
patch -d ".tmp/coding-tasks/recheck/$ID/gold" -p1 \
  < ".tmp/coding-tasks/artifacts/$ID/gold.patch"
```

Run the manifest's `docker_test_command_template` once with `WORKSPACE` set to `.../base` (must fail the selected regression) and once with `.../gold` (must pass). The observed focused runs took 1–5 seconds each after image setup.

## Provenance

- Dataset parquet: official Hugging Face `princeton-nlp/SWE-bench_Lite`, `default/test`, SHA-256 recorded in the manifest.
- Dataset discovery endpoint: `https://datasets-server.huggingface.co/parquet?dataset=princeton-nlp%2FSWE-bench_Lite`.
- SWE-bench documentation/source inspected at `https://github.com/SWE-bench/SWE-bench.git`, commit `02e7a74ffd0b707aab73d203fe87bdc7c76afc8e`; its README describes SWE-bench as real GitHub issues and Docker as the reproducible evaluation mechanism.
- Repository source comes from each public upstream URL and exact dataset base commit.

No model calls or billable benchmark runs were made during preflight.
