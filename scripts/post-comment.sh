#!/usr/bin/env bash
set -euo pipefail

# Dependencies:
#   jq  - Required for JSON body construction (line ~95).
#         Pre-installed on GitHub-hosted runners (ubuntu-latest).
#         Self-hosted runners: apt-get install -y jq

# Reads env vars:
#   GH_TOKEN                - GitHub token for API calls (required)
#   INPUT_POST_COMMENT      - 'true' or 'false' (default: 'true')
#   INPUT_MAX_COMMENT_CHARS - max chars for comment (default: '65000')
#   REVIEW_FILE             - path to review text file
#   GITHUB_REPOSITORY       - 'owner/repo'
#   GITHUB_PR_NUMBER        - PR number (integer)
#   GITHUB_OUTPUT           - file to write step outputs

# 1. Validate/default env vars
if [[ -z "${GITHUB_OUTPUT:-}" ]]; then
  GITHUB_OUTPUT="/dev/null"
fi

if [[ -z "${INPUT_POST_COMMENT:-}" ]]; then
  INPUT_POST_COMMENT="true"
fi

if [[ -z "${INPUT_MAX_COMMENT_CHARS:-}" ]]; then
  INPUT_MAX_COMMENT_CHARS="65000"
fi

if ! [[ "${INPUT_MAX_COMMENT_CHARS}" =~ ^[0-9]+$ ]]; then
  echo "WARNING: max-comment-chars '${INPUT_MAX_COMMENT_CHARS}' is not a valid integer; using default 65000." >&2
  INPUT_MAX_COMMENT_CHARS="65000"
fi

# 2. Skip if post-comment is false
if [[ "${INPUT_POST_COMMENT}" != "true" ]]; then
  echo "post-comment is false; skipping PR comment." >&2
  echo "comment-url=" >> "${GITHUB_OUTPUT}"
  exit 0
fi

# 3. Check REVIEW_FILE
if [[ -z "${REVIEW_FILE:-}" ]] || [[ ! -f "${REVIEW_FILE}" ]] || [[ ! -s "${REVIEW_FILE}" ]]; then
  echo "WARNING: REVIEW_FILE is missing or empty; skipping PR comment." >&2
  echo "comment-url=" >> "${GITHUB_OUTPUT}"
  exit 0
fi

# 4. Check required vars
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_PR_NUMBER:?GITHUB_PR_NUMBER is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

# 4a. Verify gh CLI is available
if ! command -v gh > /dev/null 2>&1; then
  echo "ERROR: 'gh' CLI not found. GitHub-hosted runners include gh by default; self-hosted runners must install it." >&2
  exit 1
fi

# 5. Truncation
review_text=$(cat "${REVIEW_FILE}")
max_chars="${INPUT_MAX_COMMENT_CHARS}"

if [[ "${#review_text}" -gt "${max_chars}" ]]; then
  review_text="${review_text:0:${max_chars}}"
  review_text="${review_text}"$'\n\n---\n'"*Review truncated at ${max_chars} characters.*"
fi

# 6. Write content to temp file
tmp_body=$(mktemp)
tmp_body_json=$(mktemp)

# Ensure cleanup on exit
trap 'rm -f "${tmp_body}" "${tmp_body_json}"' EXIT

printf '%s' "${review_text}" > "${tmp_body}"

# 7. Post comment — handle permission and other failures gracefully
jq -n --rawfile body "${tmp_body}" '{"body":$body}' > "${tmp_body_json}"
set +e
comment_url=$(gh api \
  "repos/${GITHUB_REPOSITORY}/issues/${GITHUB_PR_NUMBER}/comments" \
  --input "${tmp_body_json}" \
  --jq '.html_url' 2>/dev/null)
post_rc=$?
set -e

if [[ "$post_rc" -ne 0 ]] || [[ -z "${comment_url:-}" ]]; then
  echo "WARNING: Failed to post PR comment (exit ${post_rc}); check token permissions." >&2
  echo "comment-url=" >> "${GITHUB_OUTPUT}"
  exit 0
fi

# 8. Set output
echo "comment-url=${comment_url}" >> "${GITHUB_OUTPUT}"
echo "Posted PR comment: ${comment_url}" >&2
