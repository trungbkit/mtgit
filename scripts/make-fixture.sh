#!/usr/bin/env bash
#
# make-fixture.sh — build a throwaway git repo with a known topology so every
# MTGit operation (graph, cherry-pick, merge, rebase, reset, checkout, branch
# create/delete, fetch) has a predictable, assertable target.
#
# Usage:  scripts/make-fixture.sh [dest-dir]
#         dest-dir defaults to /tmp/mtgit-fixture
#
# Topology produced (newest at top):
#
#     G            main   (local-only commit  -> main is AHEAD of origin by 1)
#     M            merge of feature into main (clean merge commit)
#    /|
#   C |            main
#   | E           feature
#   B D           B on main, D..E on feature
#   |/
#   A             root (base.txt, shared.txt)
#    \
#     F           release  (edits shared.txt -> CONFLICTS with main on demand)
#
#   origin/*      bare remote; origin/main has one extra commit (O) so a
#                 `fetch` in the UI makes main show BEHIND by 1.
#
# After running, `main` is checked out, tracking `origin/main`,
# ahead 1 / (behind 1 once you fetch).
set -euo pipefail

DEST="${1:-/tmp/mtgit-fixture}"
ORIGIN="${DEST}-origin.git"
SCRATCH="${DEST}-push"

rm -rf "$DEST" "$ORIGIN" "$SCRATCH"
mkdir -p "$DEST"

export GIT_AUTHOR_NAME="Ada Fixture"
export GIT_AUTHOR_EMAIL="ada@example.com"
export GIT_COMMITTER_NAME="Ada Fixture"
export GIT_COMMITTER_EMAIL="ada@example.com"

# Monotonic, deterministic commit timestamps.
T=1700000000
commit() { # commit <message>
  T=$((T + 3600))
  GIT_AUTHOR_DATE="$T +0000" GIT_COMMITTER_DATE="$T +0000" git commit -q -m "$1"
}

git -C "$DEST" init -q -b main
cd "$DEST"
git config user.name  "Ada Fixture"
git config user.email "ada@example.com"

# --- A: root -----------------------------------------------------------------
printf 'base\n'                      > base.txt
printf 'line1\nshared-base\nline3\n' > shared.txt
git add . ; commit "A: initial commit"

# --- B, C: main --------------------------------------------------------------
printf 'line1\nshared-MAIN\nline3\n' > shared.txt   # main's take on shared.txt
printf 'b\n' > b.txt
git add . ; commit "B: main work + edit shared.txt"

printf 'c\n' > c.txt
git add . ; commit "C: more main work"

# --- feature: D, E (touches only feature.txt -> merges cleanly) --------------
git checkout -q -b feature "$(git rev-parse HEAD~1)"   # branch off B
printf 'feature v1\n' > feature.txt
git add . ; commit "D: start feature"
printf 'feature v2\n' > feature.txt
git add . ; commit "E: finish feature"

# --- M: merge feature into main (clean, real merge commit) -------------------
git checkout -q main
GIT_AUTHOR_DATE="$((T + 3600)) +0000" GIT_COMMITTER_DATE="$((T + 3600)) +0000" \
  git merge -q --no-ff feature -m "M: merge feature into main"
T=$((T + 3600))

# --- release: F (edits shared.txt -> conflicts with main) --------------------
git checkout -q -b release "$(git rev-parse main~2)"   # branch off A-ish
printf 'line1\nshared-RELEASE\nline3\n' > shared.txt   # divergent edit == conflict
printf 'r\n' > r.txt
git add . ; commit "F: release edits shared.txt (conflicts with main)"

git checkout -q main

# --- origin: bare remote, push everything ------------------------------------
git init -q --bare "$ORIGIN"
git remote add origin "$ORIGIN"
git push -q -u origin main feature release

# origin/main gets one extra commit the local repo doesn't have yet -> BEHIND 1
git clone -q "$ORIGIN" "$SCRATCH"
cd "$SCRATCH"
git config user.name "Ada Fixture"; git config user.email "ada@example.com"
printf 'o\n' > o.txt
git add . ; GIT_AUTHOR_DATE="$((T + 7200)) +0000" GIT_COMMITTER_DATE="$((T + 7200)) +0000" \
  git commit -q -m "O: commit only on origin/main"
git push -q origin main
cd "$DEST"
rm -rf "$SCRATCH"

# one local-only commit on main -> AHEAD 1 (before fetch)
printf 'g\n' > g.txt
git add . ; commit "G: local-only commit on main"

echo
echo "Fixture ready:"
echo "  repo    : $DEST"
echo "  origin  : $ORIGIN"
echo
git -C "$DEST" log --graph --oneline --all --decorate | sed 's/^/  /'
echo
echo "Branches:"
git -C "$DEST" branch -vv | sed 's/^/  /'
