# gg

`gg` is a local, GitHub-native stacked-branch CLI. It implements a stacked-branch workflow using its own `.gg_*` repository metadata namespace.

The supported workflow is:

```text
init -> branch create -> commit/amend -> restack -> move -> sync -> submit
```

`gg` is intentionally local-first. Git operations use your existing Git credentials. Pull-request operations prefer an authenticated `gh` CLI and fall back to `GITHUB_TOKEN`. The tool has no account, hosted service, telemetry, or Graphite backend dependency.

## Requirements

- Node.js 22.13 or newer (Node 24+ recommended)
- Git 2.38 or newer with `merge-tree --write-tree --merge-base`
- npm
- make
- For `gg submit` and GitHub-aware sync cleanup: authenticated `gh`, or `GITHUB_TOKEN`

## Install from this checkout

```sh
cd /Users/samhu/dev/gg
make install
gg --help
```

Uninstall with one command:

```sh
make uninstall
```

`make install` builds from the lockfile in an isolated temporary directory, installs the self-contained package under `~/.local/share/gg`, and creates `~/.local/bin/gg`. It refuses to overwrite an unrelated executable. `make uninstall` removes the executable, package, installer metadata, locks, temporary build directories, dedicated npm cache/logs, and any now-empty directories that the installer created. It is safe and idempotent; it does not touch project dependencies created separately with `npm ci`. Repository stack metadata and your existing Git/GitHub credentials are user data, not installation traces, so uninstall never removes them.

## First stack

```sh
cd /path/to/a/git/repository
gg init --trunk main
gg branch create feature-base --all -m "Feature base"
gg branch create feature-ui --all -m "Feature UI"
gg log short
gg down
gg up
gg submit --stack
```

The short aliases are available too:

```sh
gg bc feature-base --all -m "Feature base"
gg cc --all -m "A new commit"
gg ca --all -m "Amend the current commit"
gg r
gg l
gg s
```

When an explicit restack or move hits a conflict, resolve files using the normal Git index and run `gg continue`. Use `gg abort --force` to restore every branch ref and metadata row captured at the start of the interrupted operation.

## Development

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm run format
npm test
npm run test:install
```

The integration suite creates repositories only in the operating system's temporary directory and removes them in `finally` blocks. GitHub tests use a fake `gh` executable and local bare Git remotes; they never create real repositories or pull requests.

## Documentation

- [Command reference](docs/command-reference.md)
- [Architecture and safety model](docs/architecture.md)
- [Metadata format](docs/metadata.md)
- [Graphite 1.8.6 compatibility matrix and known differences](docs/compatibility.md)
- [Manual parity-testing guide](docs/parity-testing.md)
- [Development and cleanup audit](docs/development-audit.md)

## License

MIT
