#!/usr/bin/env bash
# install-skills.sh
# Vendor Matt Pocock + Superpowers engineering skills into ~/.claude/skills/
# Does NOT modify CLAUDE.md, settings.json, or register any hooks.
# Requires: git, rsync, python3 (macOS system tool)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/skills-config.json"
MARKER_FILE=".managed-by-supervisor"

# Colors
R='\033[0;31m'; Y='\033[1;33m'; G='\033[0;32m'; C='\033[0;36m'
DIM='\033[2m'; B='\033[1m'; NC='\033[0m'

# ── Args ───────────────────────────────────────────────────────────────────────
CORE_ONLY=false
DO_UPDATE=false
DO_APPLY=false
VENDOR_OVERRIDE=""

usage() {
  cat <<'EOF'
Usage: install-skills.sh [OPTIONS]

Vendor Matt Pocock + Superpowers engineering skills into ~/.claude/skills/
Default: installs all 14 skills (8 core + 6 optional).

  --core-only      Install only 8 core skills
  --update         Fetch upstream, show per-skill diff summary (no files changed)
  --apply          With --update: apply changes and pin new commits in config
  --vendor-dir DIR Override vendor cache dir (default: from config or $SKILLS_VENDOR_DIR)
  -h, --help       Show this help

Examples:
  ./install-skills.sh                      # install/update all 14
  ./install-skills.sh --core-only          # install/update 8 core only
  ./install-skills.sh --update             # show what changed upstream (dry run)
  ./install-skills.sh --update --apply     # pull latest + update pinned commits
  SKILLS_VENDOR_DIR=/mnt/fast ./install-skills.sh   # custom cache location
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --core-only)  CORE_ONLY=true;         shift   ;;
    --update)     DO_UPDATE=true;         shift   ;;
    --apply)      DO_APPLY=true;          shift   ;;
    --vendor-dir) VENDOR_OVERRIDE="$2";  shift 2 ;;
    -h|--help)    usage ;;
    *) echo -e "${R}Unknown argument: $1${NC}" >&2; usage ;;
  esac
done

if $DO_APPLY && ! $DO_UPDATE; then
  echo -e "${R}Error: --apply requires --update${NC}" >&2; exit 1
fi

# ── Prerequisites ──────────────────────────────────────────────────────────────
for tool in git rsync python3; do
  command -v "$tool" &>/dev/null || {
    echo -e "${R}Required tool not found: $tool${NC}" >&2; exit 1
  }
done
[[ -f "$CONFIG_FILE" ]] || {
  echo -e "${R}Config not found: $CONFIG_FILE${NC}" >&2; exit 1
}

# ── Parse JSON config ──────────────────────────────────────────────────────────
# Uses python3 (macOS built-in) for JSON; all filesystem ops remain in bash.
_parse_config() {
  python3 - "$CONFIG_FILE" "$VENDOR_OVERRIDE" <<'PY'
import json, os, sys
cfg = json.load(open(sys.argv[1]))
override = sys.argv[2]
venv = os.environ.get("SKILLS_VENDOR_DIR", "")
vendor = os.path.expanduser(override or venv or cfg.get("vendorDir", "~/.cache/claude-skills-vendor"))
install = os.path.expanduser(cfg["installDir"])
print("CFG_VENDOR\t" + vendor)
print("CFG_INSTALL\t" + install)
for s in cfg["sources"]:
    print("\t".join(["SOURCE", s["name"], s["repo"], s["commit"], s["skillsRoot"]]))
for sk in cfg["skills"]:
    print("\t".join(["SKILL", sk["source"], sk["path"], sk["tier"]]))
PY
}

VENDOR_DIR=""
INSTALL_DIR=""
SRC_NAMES=(); SRC_REPOS=(); SRC_COMMITS=(); SRC_ROOTS=()
SK_SRC=();    SK_PATH=();    SK_TIER=()

while IFS=$'\t' read -r tag a b c d; do
  case "$tag" in
    CFG_VENDOR)  VENDOR_DIR="$a" ;;
    CFG_INSTALL) INSTALL_DIR="$a" ;;
    SOURCE)      SRC_NAMES+=("$a"); SRC_REPOS+=("$b"); SRC_COMMITS+=("$c"); SRC_ROOTS+=("$d") ;;
    SKILL)       SK_SRC+=("$a");   SK_PATH+=("$b");   SK_TIER+=("$c") ;;
  esac
done < <(_parse_config)

mkdir -p "$VENDOR_DIR" "$INSTALL_DIR"

# ── Helpers ────────────────────────────────────────────────────────────────────

# Return index of source by name
_src_idx() {
  local name="$1"
  local i
  for i in "${!SRC_NAMES[@]}"; do
    [[ "${SRC_NAMES[$i]}" == "$name" ]] && { echo "$i"; return; }
  done
  echo -e "${R}Unknown source: $name${NC}" >&2; exit 1
}

# Extract 'name:' from SKILL.md YAML frontmatter
_skill_fm_name() {
  awk 'NR==1 && /^---/ { f=1; next }
       f && /^---/     { exit }
       f && /^name:/   { sub(/^name:[[:space:]]*/,""); gsub(/^["'"'"']|["'"'"']$/,""); print; exit }
  ' "$1"
}

# Ensure a full (non-shallow) clone, checked out at the given commit
_ensure_clone() {
  local name="$1" repo="$2" commit="$3"
  local dir="$VENDOR_DIR/$name"

  if [[ -d "$dir/.git" ]]; then
    local shallow
    shallow=$(git -C "$dir" rev-parse --is-shallow-repository 2>/dev/null || echo "false")
    if [[ "$shallow" == "true" ]]; then
      echo -e "  ${Y}[$name]${NC} Shallow clone detected — unshallowing (full history needed for --update)"
      git -C "$dir" fetch --unshallow
    fi
  else
    echo -e "  ${C}[$name]${NC} Cloning ${repo} ..."
    git clone "$repo" "$dir"
  fi

  # Fetch only if pinned commit is not yet local
  if ! git -C "$dir" cat-file -e "${commit}^{commit}" 2>/dev/null; then
    echo -e "  ${Y}[$name]${NC} Pinned commit $commit not local — fetching"
    git -C "$dir" fetch origin
  fi

  git -C "$dir" checkout --quiet --detach "$commit"
  echo -e "  ${C}[$name]${NC} At pinned commit ${commit:0:8}"
}

# ── Main ───────────────────────────────────────────────────────────────────────

echo -e "\n${B}═══ Claude Skills Installer ═══${NC}"
if $CORE_ONLY; then
  echo -e "  Tier:   core only (8 skills)"
else
  echo -e "  Tier:   core + optional (14 skills)"
fi
if $DO_UPDATE; then
  if $DO_APPLY; then echo -e "  Mode:   --update --apply (fetch + sync + pin new commits)"
  else               echo -e "  Mode:   --update (dry run — no files changed)"
  fi
fi
echo -e "${DIM}  Vendor: $VENDOR_DIR${NC}"
echo -e "${DIM}  Target: $INSTALL_DIR${NC}"

# ── [1/3] Repositories ────────────────────────────────────────────────────────
echo -e "\n${B}[1/3] Repositories${NC}"
for i in "${!SRC_NAMES[@]}"; do
  _ensure_clone "${SRC_NAMES[$i]}" "${SRC_REPOS[$i]}" "${SRC_COMMITS[$i]}"
done

if $DO_UPDATE; then
  echo -e "\n  Fetching upstream..."
  for i in "${!SRC_NAMES[@]}"; do
    git -C "$VENDOR_DIR/${SRC_NAMES[$i]}" fetch --quiet origin || \
      echo -e "  ${Y}[${SRC_NAMES[$i]}]${NC} fetch failed (network?), continuing with cached"
    echo -e "  ${C}[${SRC_NAMES[$i]}]${NC} fetched"
  done

  if $DO_APPLY; then
    echo -e "\n  Checking out latest commits..."
    for i in "${!SRC_NAMES[@]}"; do
      latest=$(git -C "$VENDOR_DIR/${SRC_NAMES[$i]}" rev-parse "origin/HEAD" 2>/dev/null \
               || echo "${SRC_COMMITS[$i]}")
      if [[ "$latest" != "${SRC_COMMITS[$i]}" ]]; then
        echo -e "  ${C}[${SRC_NAMES[$i]}]${NC} ${SRC_COMMITS[$i]:0:8} → ${latest:0:8}"
        git -C "$VENDOR_DIR/${SRC_NAMES[$i]}" checkout --quiet --detach "$latest"
        SRC_COMMITS[$i]="$latest"
      else
        echo -e "  ${C}[${SRC_NAMES[$i]}]${NC} already at latest"
      fi
    done
  fi
fi

# ── [2/3] Resolve skill names + collision check ───────────────────────────────
echo -e "\n${B}[2/3] Resolving skill names${NC}"
SK_NAMES=()   # frontmatter 'name:' per SK_* entry; "" if tier-filtered out
SEEN_NAMES=()

for i in "${!SK_SRC[@]}"; do
  src="${SK_SRC[$i]}"; path="${SK_PATH[$i]}"; tier="${SK_TIER[$i]}"

  if $CORE_ONLY && [[ "$tier" != "core" ]]; then
    SK_NAMES+=("")
    continue
  fi

  idx=$(_src_idx "$src")
  root="${SRC_ROOTS[$idx]}"
  skill_md="$VENDOR_DIR/$src/$root/$path/SKILL.md"

  [[ -f "$skill_md" ]] || {
    echo -e "${R}SKILL.md not found: $skill_md${NC}" >&2; exit 1
  }
  sname=$(_skill_fm_name "$skill_md")
  [[ -n "$sname" ]] || {
    echo -e "${R}No 'name:' field in frontmatter: $skill_md${NC}" >&2; exit 1
  }

  # Collision guard: two ALLOWLIST skills must not share a frontmatter name
  if [[ ${#SEEN_NAMES[@]} -gt 0 ]]; then
    for seen in "${SEEN_NAMES[@]}"; do
      if [[ "$seen" == "$sname" ]]; then
        echo -e "${R}ERROR: Name collision — '$sname' appears in more than one ALLOWLIST skill.${NC}" >&2
        echo -e "${R}       Refusing to proceed. Fix skills-config.json.${NC}" >&2
        exit 1
      fi
    done
  fi

  SEEN_NAMES+=("$sname")
  SK_NAMES+=("$sname")
  echo -e "  ${DIM}$src/$path${NC} → ${C}$sname${NC}"
done

# ── [3/3] Install or diff ─────────────────────────────────────────────────────
if $DO_UPDATE && ! $DO_APPLY; then
  echo -e "\n${B}[3/3] Diff summary (dry run — no files changed)${NC}"
else
  echo -e "\n${B}[3/3] Installing${NC}"
fi

SUM_NAME=(); SUM_SRC=(); SUM_COMMIT=(); SUM_TIER=(); SUM_ACTION=()

for i in "${!SK_SRC[@]}"; do
  src="${SK_SRC[$i]}"; path="${SK_PATH[$i]}"; tier="${SK_TIER[$i]}"
  sname="${SK_NAMES[$i]}"
  [[ -z "$sname" ]] && continue  # tier-filtered

  idx=$(_src_idx "$src")
  commit="${SRC_COMMITS[$idx]}"
  root="${SRC_ROOTS[$idx]}"
  skill_src_dir="$VENDOR_DIR/$src/$root/$path"
  install_path="$INSTALL_DIR/$sname"
  marker_path="$install_path/$MARKER_FILE"

  # ── Dry-run diff mode ──────────────────────────────────────────────────────
  if $DO_UPDATE && ! $DO_APPLY; then
    latest=$(git -C "$VENDOR_DIR/$src" rev-parse "origin/HEAD" 2>/dev/null || echo "$commit")
    if [[ "$commit" == "$latest" ]]; then
      echo -e "  ${G}✓${NC} $sname  ${DIM}up to date${NC}"
      SUM_ACTION+=("up-to-date")
    else
      diff_stat=$(git -C "$VENDOR_DIR/$src" diff --stat \
                    "${commit}..${latest}" -- "$root/$path/" 2>/dev/null || true)
      if [[ -n "$diff_stat" ]]; then
        echo -e "  ${Y}↑${NC} ${B}$sname${NC}  ${DIM}${commit:0:8} → ${latest:0:8}${NC}"
        echo "$diff_stat" | sed 's/^/      /'
        SUM_ACTION+=("upstream-changes")
      else
        echo -e "  ${G}✓${NC} $sname  ${DIM}up to date${NC}"
        SUM_ACTION+=("up-to-date")
      fi
    fi
    SUM_NAME+=("$sname"); SUM_SRC+=("$src")
    SUM_COMMIT+=("${commit:0:8}"); SUM_TIER+=("$tier")
    continue
  fi

  # ── Install / update ───────────────────────────────────────────────────────
  action="installed"
  if [[ -d "$install_path" ]]; then
    if [[ ! -f "$marker_path" ]]; then
      # Exists but no marker → user-managed directory; never overwrite
      echo -e "  ${Y}SKIP${NC} ${B}$sname${NC} — $install_path exists without marker (user-managed, not touching)"
      SUM_NAME+=("$sname"); SUM_SRC+=("$src")
      SUM_COMMIT+=("${commit:0:8}"); SUM_TIER+=("$tier"); SUM_ACTION+=("skipped-user-managed")
      continue
    fi
    action="updated"
  fi

  mkdir -p "$install_path"
  # rsync --delete keeps install_path an exact mirror of source (idempotent)
  rsync -a --delete --exclude="$MARKER_FILE" "$skill_src_dir/" "$install_path/"

  # Write/refresh marker
  printf 'source: %s\npath: %s\ncommit: %s\nmanaged-by: supervisor/scripts/install-skills.sh\n' \
    "$src" "$path" "$commit" > "$marker_path"

  echo -e "  ${G}✓${NC} ${B}$sname${NC}  ($action)"
  SUM_NAME+=("$sname"); SUM_SRC+=("$src")
  SUM_COMMIT+=("${commit:0:8}"); SUM_TIER+=("$tier"); SUM_ACTION+=("$action")
done

# ── Update config if --update --apply ─────────────────────────────────────────
if $DO_UPDATE && $DO_APPLY; then
  echo -e "\n  Updating pinned commits in $CONFIG_FILE ..."
  # Write updated commits to a temp file for Python to consume
  updates_tmp=$(mktemp)
  for i in "${!SRC_NAMES[@]}"; do
    printf '%s\t%s\n' "${SRC_NAMES[$i]}" "${SRC_COMMITS[$i]}" >> "$updates_tmp"
  done
  python3 - "$CONFIG_FILE" "$updates_tmp" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
updates = {}
with open(sys.argv[2]) as f:
    for line in f:
        parts = line.rstrip("\n").split("\t", 1)
        if len(parts) == 2:
            updates[parts[0]] = parts[1]
changed = False
for src in cfg["sources"]:
    new = updates.get(src["name"])
    if new and new != src["commit"]:
        print(f"  {src['name']}: {src['commit'][:8]} → {new[:8]}")
        src["commit"] = new
        changed = True
if changed:
    with open(sys.argv[1], "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
    print("  Config updated.")
else:
    print("  Config already up to date.")
PY
  rm -f "$updates_tmp"
fi

# ── Summary table ──────────────────────────────────────────────────────────────
echo -e "\n${B}═══ Summary ═══════════════════════════════════════════════════════════════════${NC}"
printf "${B}%-34s %-15s %-10s %-9s %s${NC}\n" "Skill" "Source" "Commit" "Tier" "Action"
printf '%.0s─' {1..80}; echo
for i in "${!SUM_NAME[@]}"; do
  case "${SUM_ACTION[$i]}" in
    installed)             c="$G" ;;
    updated)               c="$C" ;;
    skipped-user-managed)  c="$Y" ;;
    *)                     c="$DIM" ;;
  esac
  printf "%-34s %-15s %-10s %-9s ${c}%s${NC}\n" \
    "${SUM_NAME[$i]}" "${SUM_SRC[$i]}" "${SUM_COMMIT[$i]}" "${SUM_TIER[$i]}" "${SUM_ACTION[$i]}"
done
echo ""
