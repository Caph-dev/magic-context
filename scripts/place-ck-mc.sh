#!/usr/bin/env bash
# Check the live context.db and store.db versions and source epoch constants before placement.
set -euo pipefail

usage() { echo "usage: $0 [--dry-run] [--require-epochs-unchanged] [--source-ref REF] STAGED_BINARY" >&2; exit 2; }
die() { echo "place-ck-mc: $*" >&2; exit 1; }
dry_run=0
require_epochs=0
source_ref=
staged=
while (($#)); do
    case "$1" in
        --dry-run) dry_run=1 ;;
        --require-epochs-unchanged) require_epochs=1 ;;
        --source-ref) (($# >= 2)) || usage; source_ref=$2; shift ;;
        --*) usage ;;
        *) [[ -z "$staged" ]] || usage; staged=$1 ;;
    esac
    shift
done
[[ -n "$staged" && -f "$staged" && -x "$staged" ]] || die "staged binary must exist and be executable: $staged"
# Resolve before changing directories; later copies must use exactly the inspected bytes.
staged=$(cd "$(dirname "$staged")" && pwd -P)/$(basename "$staged")
staged_digest=$(shasum -a 256 "$staged" | cut -d' ' -f1)
root=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
cd "$root"

codesign --verify --strict "$staged" >/dev/null 2>&1 || die "invalid staged code signature"
signature=$(codesign -dv --verbose=2 "$staged" 2>&1) || die "cannot read staged signature"
[[ "$signature" == *$'\nIdentifier=ck-mc\n'* ]] || die "staged signature identifier is not ck-mc"
sha_from() {
    local line sha
    line=$("$1" --version) || die "cannot read $1 --version"
    [[ "$line" =~ ^ck-mc[[:space:]]+[^[:space:]]+[[:space:]]+\(([[:xdigit:]]{40})\)$ ]] || die "invalid full build SHA in $1 --version: $line"
    sha=${BASH_REMATCH[1]}
    printf '%s\n' "$sha"
}
staged_sha=$(sha_from "$staged")
if [[ -n "$source_ref" ]]; then
    source_sha=$(git rev-parse --verify "${source_ref}^{commit}") || die "unknown source ref: $source_ref"
    [[ "$staged_sha" == "$source_sha" ]] || die "staged SHA $staged_sha differs from source $source_sha"
else
    echo "staged build SHA: $staged_sha (compare with the build source; use --source-ref REF to enforce)"
fi
fences=$("$staged" --print-fences) || die "staged binary does not report supported fences"
[[ "$fences" =~ ^context\.db=([0-9]+)[[:space:]]store\.db=([0-9]+)$ ]] || die "invalid --print-fences output: $fences"
context_supported=${BASH_REMATCH[1]}
store_supported=${BASH_REMATCH[2]}
mc_dir=${MAGIC_CONTEXT_STORAGE_DIR:-$HOME/.local/share/cortexkit/magic-context}
read_version() {
    local path=$1 sql=$2 value
    [[ -f "$path" ]] || die "missing live store: $path"
    value=$(sqlite3 -readonly "$path" "$sql") || die "cannot read schema version from $path"
    [[ "$value" =~ ^[0-9]+$ ]] || die "invalid schema version from $path: $value"
    printf '%s\n' "$value"
}
context_live=$(read_version "$mc_dir/context.db" 'SELECT COALESCE(MAX(version), 0) FROM schema_migrations;')
store_live=$(read_version "$mc_dir/store.db" "SELECT COALESCE(MAX(version), 0) FROM cortexkit_schema_version WHERE namespace = 'mc_cache';")
echo "context.db: live=$context_live staged=$context_supported; store.db: live=$store_live staged=$store_supported"
((10#$context_supported >= 10#$context_live)) || die "rollback refused: context.db live=$context_live staged=$context_supported; store.db live=$store_live staged=$store_supported"
((10#$store_supported >= 10#$store_live)) || die "rollback refused: context.db live=$context_live staged=$context_supported; store.db live=$store_live staged=$store_supported"

bin_dir=$HOME/.local/share/cortexkit/bin
deployed=$bin_dir/ck-mc
[[ -f "$deployed" && -x "$deployed" ]] || die "missing deployed ck-mc: $deployed"
deployed_sha=$(sha_from "$deployed")
# Require both build revisions locally; guessing an unavailable epoch could hide a change.
epochs() {
    git show "$1:crates/mc-module/src/lib.rs" | python3 -c '
import re, sys
source = sys.stdin.read()
for name in ("PROFILE_EPOCH_CLAUDE_CODE_ANTHROPIC", "TAGGER_FEATURE_EPOCH", "MEMORY_RENDER_FORMAT_EPOCH", "COMPARTMENT_RENDER_FORMAT_EPOCH"):
    matches = re.findall(r"pub const " + name + r": u32 = (\d+);", source)
    if len(matches) != 1:
        sys.exit("missing or ambiguous epoch: " + name)
    print(name + "=" + matches[0])
'
}
old_epochs=$(epochs "$deployed_sha") || die "cannot read deployed epochs from git $deployed_sha"
new_epochs=$(epochs "$staged_sha") || die "cannot read staged epochs from git $staged_sha"
echo "epoch diff ($deployed_sha -> $staged_sha):"
python3 - "$old_epochs" "$new_epochs" <<'PY'
import sys
old = dict(line.split('=') for line in sys.argv[1].splitlines())
new = dict(line.split('=') for line in sys.argv[2].splitlines())
for key in old:
    print(f"  {key}: {old[key]} -> {new[key]}" + (" CHANGED" if old[key] != new[key] else ""))
PY
[[ "$old_epochs" == "$new_epochs" || "$require_epochs" -eq 0 ]] || die "epochs changed; pre-announce before placing"
rollback=$bin_dir/staging/ck-mc.rollback.$deployed_sha
printf -v rollback_cmd 'cp %q %q && ck module restart magic-context' "$rollback" "$deployed"
if ((dry_run)); then
    echo "dry-run: would preserve $deployed as $rollback (without overwriting), atomically place $staged, restart magic-context, verify inode/version/digest/health"
    exit 0
fi
[[ "$staged" != "$deployed" ]] || die "staged path is the deployed binary"
mkdir -p "$bin_dir/staging"
if [[ -e "$rollback" ]]; then
    cmp -s "$deployed" "$rollback" || die "existing rollback $rollback differs from deployed binary"
else
    # cp -n prevents a racing placement from replacing a rollback for this SHA.
    cp -pn "$deployed" "$rollback" || die "cannot preserve rollback $rollback"
    cmp -s "$deployed" "$rollback" || die "rollback copy differs from deployed binary"
fi
[[ $(shasum -a 256 "$staged" | cut -d' ' -f1) == "$staged_digest" ]] || die "staged binary changed since preflight"
tmp=$(mktemp "$bin_dir/.ck-mc.XXXXXXXX") || die "cannot make placement temp"
trap 'rm -f "$tmp"' EXIT
cp -p "$staged" "$tmp"
[[ $(shasum -a 256 "$tmp" | cut -d' ' -f1) == "$staged_digest" ]] || die "staged binary changed during placement"
mv -f "$tmp" "$deployed"
trap 'echo "placement verification failed; rollback binary only when both stores are compatible: $rollback_cmd" >&2' ERR
ck module restart magic-context
# The restart returns while the old process drains, before the new one has declared its
# build. Wait for the new process to report a build instead of reading a half-started state.
poll_seconds=${PLACE_CK_MC_POLL_SECONDS:-2}
running=""
for _ in $(seq 1 60); do
    provenance=$(ck --json provenance magic-context 2>/dev/null) || provenance=""
    running=$(printf '%s' "$provenance" | python3 -c 'import json,sys
try:
    x = json.load(sys.stdin)
    m = next(m for m in x["modules"] if m["module_id"] == "magic-context")
    print(m["daemon_observed"]["pid"], m["module_declared"]["build"]["build_git_sha"])
except (KeyError, StopIteration, TypeError, ValueError):
    pass' || true)
    [[ -n "$running" && "${running#* }" == "$staged_sha" ]] && break
    sleep "$poll_seconds"
done
[[ -n "$running" ]] || { echo "magic-context did not declare a build after the restart" >&2; false; }
read -r pid running_sha <<< "$running"
[[ "$pid" =~ ^[0-9]+$ && "$running_sha" == "$staged_sha" ]] || { echo "running build $running_sha does not match staged $staged_sha" >&2; false; }
running_inode=$(lsof -nP -p "$pid" -a -d txt -F in | python3 -c '
import sys
inode = None
for line in sys.stdin:
    line = line.strip()
    if line.startswith("i"): inode = line[1:]
    if line.startswith("n") and line[1:] == sys.argv[1]:
        print(inode or "")
' "$deployed")
[[ "$running_inode" == "$(stat -f %i "$deployed")" ]] || { echo "running inode $running_inode differs from placed inode $(stat -f %i "$deployed")" >&2; false; }
[[ "$(sha_from "$deployed")" == "$staged_sha" ]] || false
[[ "$(shasum -a 256 "$deployed" | cut -d' ' -f1)" == "$staged_digest" ]] || false
# Health reads "unknown" until the new process answers its first probe; allow it to settle.
health_ok=0
for _ in $(seq 1 30); do
    health=$(ck --json health magic-context 2>/dev/null) || health=""
    if printf '%s' "$health" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("status") == "ok" else 1)' 2>/dev/null; then
        health_ok=1
        break
    fi
    sleep "$poll_seconds"
done
[[ $health_ok -eq 1 ]] || { echo "ck health is not ok after the restart" >&2; false; }
trap - ERR
echo "placed ck-mc $staged_sha; context.db $context_live/$context_supported store.db $store_live/$store_supported; inode/version/digest/health ok"
