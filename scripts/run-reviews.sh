#!/usr/bin/env bash
set -euo pipefail

# Reads env vars:
#   INPUT_MODELS            - comma-separated review models (default: claude-sonnet-4.6)
#   INPUT_PROMPTS           - comma-separated built-in names or workspace-relative paths (default: code-review)
#   INPUT_FUSION            - 'true' to synthesize individual reviews
#   INPUT_FUSION_MODEL      - fusion model override
#   INPUT_ALLOW_ALL_TOOLS   - 'true' to pass --yolo; 'false' to use --allow-tool="shell(git:*)"
#   INPUT_MIN_PROMPT_LENGTH - minimum PR diff length before review runs
#   COPILOT_AUTO_UPDATE     - must remain 'false' in all copilot invocations
#   GITHUB_ACTION_PATH      - action root containing prompts/
#   GITHUB_BASE_REF         - PR base branch name
#   GITHUB_REPOSITORY       - owner/repo (available in action runtime)
#   GITHUB_OUTPUT           - step output file
#   GITHUB_ENV              - step env file for REVIEW_FILE handoff
#   GITHUB_WORKSPACE        - checked-out repository root

if [[ -z "${GITHUB_OUTPUT:-}" ]]; then
  GITHUB_OUTPUT="/dev/null"
fi

if [[ -z "${GITHUB_ENV:-}" ]]; then
  GITHUB_ENV="/dev/null"
fi

cleanup_files=()
LAST_REVIEW_FILE=""

cleanup() {
  local file
  for file in "${cleanup_files[@]:-}"; do
    if [[ -n "$file" ]] && [[ "$file" != "$LAST_REVIEW_FILE" ]] && [[ -e "$file" ]]; then
      rm -f "$file"
    fi
  done
}

trap cleanup EXIT

record_temp_file() {
  cleanup_files+=("$1")
}

append_unique_model() {
  local candidate="$1"
  local existing

  for existing in "${SUCCEEDED_MODELS[@]}"; do
    if [[ "$existing" == "$candidate" ]]; then
      return 0
    fi
  done

  SUCCEEDED_MODELS+=("$candidate")
}

is_within_workspace() {
  local path="$1"
  local workspace="$2"

  [[ "$path" == "$workspace" ]] || [[ "$path" == "$workspace"/* ]]
}

write_empty_outputs() {
  echo "review=" >> "$GITHUB_OUTPUT"
  echo "models-used=" >> "$GITHUB_OUTPUT"
}

# Step 1 — Verify Copilot CLI
if ! command -v copilot &>/dev/null; then
  echo "ERROR: copilot CLI not found; ensure the npm install step ran before this script" >&2
  exit 1
fi

if copilot help 2>/dev/null | grep -q 'no-custom-instructions'; then
  NO_CUSTOM_FLAG='--no-custom-instructions'
else
  echo "WARNING: --no-custom-instructions flag not found; AGENTS.md injection protection unavailable" >&2
  NO_CUSTOM_FLAG=''
fi

# Check --yolo flag availability
YOLO_SUPPORTED=false
if copilot help 2>&1 | grep -q -- '--yolo'; then
  YOLO_SUPPORTED=true
fi

# Resolve tool flags
if [[ "${INPUT_ALLOW_ALL_TOOLS:-false}" == "true" ]]; then
  if [[ "$YOLO_SUPPORTED" == "true" ]]; then
    TOOL_FLAGS=('--yolo')
  else
    echo "WARNING: --yolo not supported in this copilot version; falling back to --allow-tool=\"shell(git:*)\"" >&2
    TOOL_FLAGS=("--allow-tool=shell(git:*)")
  fi
else
  TOOL_FLAGS=("--allow-tool=shell(git:*)")
fi

# Step 2 — Resolve models list
IFS=',' read -r -a raw_models <<< "${INPUT_MODELS:-claude-sonnet-4.6}"
MODELS_LIST=()
for model in "${raw_models[@]}"; do
  model="${model// /}"
  if [[ -n "$model" ]]; then
    MODELS_LIST+=("$model")
  fi
done

if [[ "${#MODELS_LIST[@]}" -eq 0 ]]; then
  echo "ERROR: No models specified" >&2
  exit 1
fi

# Step 3 — Resolve prompts list
PROMPT_FILES=()
workspace_root="${GITHUB_WORKSPACE:-/github/workspace}"

IFS=',' read -r -a raw_prompts <<< "${INPUT_PROMPTS:-code-review}"
for entry in "${raw_prompts[@]}"; do
  # Trim all leading/trailing whitespace (tabs, multiple spaces)
  entry="$(echo "$entry" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  if [[ -z "$entry" ]]; then
    continue
  fi

  # Strip .md suffix for built-in lookup
  name="${entry%.md}"
  builtin_path="${GITHUB_ACTION_PATH}/prompts/${name}.md"

  if [[ -f "$builtin_path" ]]; then
    PROMPT_FILES+=("$builtin_path")
  else
    # Treat as workspace-relative file path
    resolved_path=$(realpath --canonicalize-missing "${workspace_root}/${entry}" 2>/dev/null \
      || python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "${workspace_root}/${entry}" 2>/dev/null \
      || echo "${workspace_root}/${entry}")
    if ! is_within_workspace "$resolved_path" "$workspace_root"; then
      echo "ERROR: prompt path '$entry' is outside workspace" >&2
      continue
    fi
    if [[ ! -f "$resolved_path" ]]; then
      echo "WARNING: prompt '$entry' is neither a built-in nor an existing file; skipping" >&2
      continue
    fi
    PROMPT_FILES+=("$resolved_path")
  fi
done

if [[ "${#PROMPT_FILES[@]}" -eq 0 ]]; then
  PROMPT_FILES+=("${GITHUB_ACTION_PATH}/prompts/code-review.md")
fi

# Step 4 — PR diff length check
set +e
pr_diff_len=$(git diff "${GITHUB_BASE_SHA:-origin/${GITHUB_BASE_REF:-main}}...HEAD" 2>/dev/null | wc -c)
_git_rc=${PIPESTATUS[0]}
set -e
if [[ "$_git_rc" -ne 0 ]]; then
  echo "WARNING: git diff failed (exit $_git_rc); check that fetch-depth: 0 is set in actions/checkout." >&2
fi
pr_diff_len=$(( pr_diff_len ))
min_len="${INPUT_MIN_PROMPT_LENGTH:-50}"
if ! [[ "$min_len" =~ ^[0-9]+$ ]]; then
  echo "WARNING: min-prompt-length '$min_len' is not a valid integer; using default 50." >&2
  min_len=50
fi
if (( pr_diff_len < min_len )); then
  echo "PR diff (${pr_diff_len} chars) is smaller than min-prompt-length ($min_len); skipping review." >&2
  write_empty_outputs
  exit 0
fi

# Step 5 — Run reviews
SUCCEEDED_MODELS=()
all_review_files=()

for prompt_file in "${PROMPT_FILES[@]}"; do
  prompt_slug=$(basename "$prompt_file")
  prompt_slug="${prompt_slug%.md}"

  for model in "${MODELS_LIST[@]}"; do
    output_file=$(mktemp)
    record_temp_file "$output_file"
    model_slug="${model//\//-}"

    echo "Running review: model=$model prompt=$prompt_slug output=$model_slug" >&2
    copilot_args=(
      -p "$(cat "$prompt_file")"
      -s
      --no-ask-user
      "${TOOL_FLAGS[@]}"
      --model "$model"
    )
    if [[ -n "$NO_CUSTOM_FLAG" ]]; then
      copilot_args+=("$NO_CUSTOM_FLAG")
    fi

    if COPILOT_AUTO_UPDATE=false copilot "${copilot_args[@]}" > "$output_file"; then
      append_unique_model "$model"
      all_review_files+=("$output_file")
      LAST_REVIEW_FILE="$output_file"
    else
      echo "WARNING: Review failed for model=$model prompt=$prompt_slug" >&2
    fi
  done
done

if [[ -z "$LAST_REVIEW_FILE" ]]; then
  echo "WARNING: All reviews failed; no output generated." >&2
  write_empty_outputs
  if [[ "${INPUT_FAIL_ON_ERROR:-false}" == "true" ]]; then
    echo "ERROR: fail-on-error is true; exiting with failure." >&2
    exit 1
  fi
  exit 0
fi

# Step 6 — Fusion (optional)
if [[ "${INPUT_FUSION:-false}" == "true" ]] && [[ "${#SUCCEEDED_MODELS[@]}" -gt 0 ]]; then
  fusion_prompt=$(mktemp)
  fusion_output=$(mktemp)
  record_temp_file "$fusion_prompt"
  record_temp_file "$fusion_output"

  {
    printf 'You are synthesizing multiple AI code reviews into one coherent review.\n'
    printf 'Deduplicate findings, prioritize by severity, and write a clear summary.\n\n'
    for review_file in "${all_review_files[@]}"; do
      printf -- '---\n'
      cat "$review_file"
      printf '\n'
    done
  } > "$fusion_prompt"

  fusion_model="${INPUT_FUSION_MODEL:-${MODELS_LIST[0]}}"
  fusion_args=(
    -p "$(cat "$fusion_prompt")"
    -s
    --no-ask-user
    "${TOOL_FLAGS[@]}"
    --model "$fusion_model"
  )
  if [[ -n "$NO_CUSTOM_FLAG" ]]; then
    fusion_args+=("$NO_CUSTOM_FLAG")
  fi

  if COPILOT_AUTO_UPDATE=false copilot "${fusion_args[@]}" > "$fusion_output"; then
    LAST_REVIEW_FILE="$fusion_output"
  else
    echo "WARNING: Fusion pass failed; using last individual review." >&2
  fi
fi

# Step 7 — Set outputs
{
  _delim="REVIEW_$(openssl rand -hex 8 2>/dev/null || printf '%s' "$$$(date +%s)")"
  echo "review<<${_delim}"
  cat "$LAST_REVIEW_FILE"
  echo "${_delim}"
} >> "$GITHUB_OUTPUT"

models_csv=$(IFS=','; echo "${SUCCEEDED_MODELS[*]}")
echo "models-used=${models_csv}" >> "$GITHUB_OUTPUT"
echo "REVIEW_FILE=${LAST_REVIEW_FILE}" >> "$GITHUB_ENV"
