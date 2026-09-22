# Third-party notices

## FFF

`vendor/pi-fff/` and `vendor/stock-pi-fff/` contain `@ff-labs/pi-fff` 0.11.0 from [FFF](https://github.com/dmtrKovalenko/fff). Each directory retains its upstream package manifest and MIT license. Only `vendor/pi-fff/src/index.ts` is modified for this pilot.

## Navigation fixtures

`eval/fixtures/source-snapshot/` is a frozen snapshot of Charlie's `pi-personal` source. The `vendor/pi-memory/src/` portion retains its upstream MIT notice in `licenses/pi-memory-MIT.txt`. The snapshot manifest records source-file hashes. The license notice is outside the snapshot to preserve those frozen inputs.

## Retrieval excerpts and coding task metadata

`eval/retrieval/frozen.json` includes source excerpts from Requests, pytest and SymPy. Source repositories and exact revisions are recorded in `eval/coding/tasks/manifest.json` and the retrieval dataset.

- [Requests](https://github.com/psf/requests). Copyright notice in `licenses/requests-notice.txt`, with the full Apache License 2.0 in `licenses/Apache-2.0.txt`.
- [pytest](https://github.com/pytest-dev/pytest). MIT license in `licenses/pytest-MIT.txt`.
- [SymPy](https://github.com/sympy/sympy). BSD license and upstream component notices from each source revision in `licenses/sympy-19007-BSD.txt` and `licenses/sympy-21379-BSD.txt`.

Coding task metadata comes from the official [SWE-bench Lite dataset](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite). The upstream SWE-bench MIT notice is retained in `licenses/SWE-bench-MIT.txt`. Full repository archives, gold patches, test patches and generated workspaces remain local and are excluded from Git.

Original project code is licensed under the [MIT License](LICENSE). The third-party material identified above retains its respective licenses and notices.
