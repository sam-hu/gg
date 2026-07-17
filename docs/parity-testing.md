# Manual parity testing

Use two disposable repositories outside this project. Never run parity experiments in `/Users/samhu/dev/gg` or another working repository.

## Minimal local comparison

```sh
reference=$(mktemp -d /private/tmp/gt-parity.XXXXXX)
candidate=$(mktemp -d /private/tmp/gg-parity.XXXXXX)

git init -b main "$reference"
git init -b main "$candidate"

for repo in "$reference" "$candidate"; do
  git -C "$repo" config user.name "Parity Test"
  git -C "$repo" config user.email "parity@example.invalid"
  git -C "$repo" commit --allow-empty -m initial
done

gt init --cwd "$reference" --trunk main --no-interactive
gg init --cwd "$candidate" --trunk main --no-interactive

gt bc a --cwd "$reference" --no-interactive
gt bc b --cwd "$reference" --no-interactive
gg bc a --cwd "$candidate" --no-interactive
gg bc b --cwd "$candidate" --no-interactive

git -C "$reference" log --graph --oneline --all
git -C "$candidate" log --graph --oneline --all
gt log short --cwd "$reference" --no-interactive
gg log short --cwd "$candidate" --no-interactive
```

Compare:

- checked-out branch;
- `git for-each-ref refs/heads` output;
- parent/child rows in the reference tool's database and `.git/.gg_metadata.db`;
- merge-base and ancestor relationships;
- important success/error strings and exit status.

## Conflict recovery

Create the same conflicting parent/child edits in each repository. Run `gt restack` and `gg restack`, confirm a normal rebase is live, resolve and continue, then repeat and abort. Compare every branch ref before and after abort. `gg` should also restore its SQLite rows exactly.

## Submission

Do not use real disposable pull requests. Run the automated fake-GitHub tests instead:

```sh
npm test -- tests/integration/sync-submit.test.ts
```

They use a local bare remote and fake `gh`, and verify scope, bases, draft state, idempotent updates, authentication failure, and no duplicate PRs.

## Cleanup

Resolve each temporary directory to its exact printed path, confirm it contains only the parity repositories you created, and remove those exact directories. Do not use an unresolved variable or wildcard. The automated suite handles its own narrow cleanup.
