#!/usr/bin/env bash
set -euo pipefail

# Reads env vars:
#   INPUT_MODEL             - single review model (default: claude-sonnet-4.6)
#   INPUT_MODELS            - comma-separated review models; overrides INPUT_MODEL
#   INPUT_PROMPT            - inline prompt text; overrides INPUT_PROMPT_FILE
#   INPUT_PROMPT_FILE       - prompt file path inside GITHUB_WORKSPACE
#   INPUT_PROMPTS           - comma-separated built-in prompt names
#   INPUT_FUSION            - 'true' to synthesize individual reviews
#   INPUT_FUSION_MODEL      - fusion model override
#   INPUT_ALLOWED_TOOLS     - Copilot tool allowlist
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

if copilot help 2>&1 | grep -q 'no-custom-instructions'; then
  NO_CUSTOM_FLAG='--no-custom-instructions'
else
  echo "WARNING: --no-custom-instructions flag not found; AGENTS.md injection protection unavailable" >&2
  NO_CUSTOM_FLAG=''
fi

# Step 2 — Resolve models list
if [[ -n "${INPUT_MODELS:-}" ]]; then
  if [[ -n "${INPUT_MODEL:-}" ]]; then
    echo "WARNING: INPUT_MODELS is set; ignoring INPUT_MODEL." >&2
  fi

  IFS=',' read -r -a raw_models <<< "$INPUT_MODELS"
else
  raw_models=("${INPUT_MODEL:-claude-sonnet-4.6}")
fi

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

if [[ -n "${INPUT_PROMPT:-}" ]]; then
  if [[ -n "${INPUT_PROMPT_FILE:-}" ]]; then
    echo "WARNING: INPUT_PROMPT is set; ignoring INPUT_PROMPT_FILE." >&2
  fi

  tmp_prompt=$(mktemp)
  record_temp_file "$tmp_prompt"
  printf '%s' "$INPUT_PROMPT" > "$tmp_prompt"
  PROMPT_FILES+=("$tmp_prompt")
elif [[ -n "${INPUT_PROMPT_FILE:-}" ]]; then
  resolved_prompt=$(realpath -m "${workspace_root}/${INPUT_PROMPT_FILE}")
  if ! is_within_workspace "$resolved_prompt" "$workspace_root"; then
    echo "ERROR: prompt-file '$INPUT_PROMPT_FILE' is outside workspace" >&2
    exit 1
  fi
  if [[ ! -f "$resolved_prompt" ]]; then
    echo "ERROR: prompt-file not found: $resolved_prompt" >&2
    exit 1
  fi
  PROMPT_FILES+=("$resolved_prompt")
fi

if [[ -n "${INPUT_PROMPTS:-}" ]]; then
  IFS=',' read -r -a BUILTIN_NAMES <<< "$INPUT_PROMPTS"
  for name in "${BUILTIN_NAMES[@]}"; do
    name="${name// /}"
    if [[ -z "$name" ]]; then
      continue
    fi

    pfile="${GITHUB_ACTION_PATH}/prompts/${name}.md"
    if [[ ! -f "$pfile" ]]; then
      echo "ERROR: Built-in prompt '$name' not found at $pfile" >&2
      exit 1
    fi
    PROMPT_FILES+=("$pfile")
  done
fi

if [[ "${#PROMPT_FILES[@]}" -eq 0 ]]; then
  PROMPT_FILES+=("${GITHUB_ACTION_PATH}/prompts/code-review.md")
fi

# Step 4 — PR diff length check
PR_DIFF=$(git diff "origin/${GITHUB_BASE_REF:-main}...HEAD" 2>/dev/null || echo "")
min_len="${INPUT_MIN_PROMPT_LENGTH:-50}"
if (( ${#PR_DIFF} < min_len )); then
  echo "PR diff (${#PR_DIFF} chars) is smaller than min-prompt-length ($min_len); skipping review." >&2
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
      --allow-tool="${INPUT_ALLOWED_TOOLS:-shell(git:*)}"
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
    --allow-tool='shell(git:*)'
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
  echo "review<<EOF_REVIEW"
  cat "$LAST_REVIEW_FILE"
  echo "EOF_REVIEW"
} >> "$GITHUB_OUTPUT"

models_csv=$(IFS=','; echo "${SUCCEEDED_MODELS[*]}")
echo "models-used=${models_csv}" >> "$GITHUB_OUTPUT"
echo "REVIEW_FILE=${LAST_REVIEW_FILE}" >> "$GITHUB_ENV"
