#!/usr/bin/env bash
set -euo pipefail

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

# 5. Sentinel permission test — temporarily disable set -e for this block
set +e
reaction_response=$(gh api \
  "repos/${GITHUB_REPOSITORY}/issues/${GITHUB_PR_NUMBER}/reactions" \
  -f content=eyes \
  --jq '.id' 2>/dev/null)
set -e

if [[ -z "${reaction_response:-}" ]]; then
  echo "WARNING: Insufficient permissions to post PR comment (403 or API error); skipping." >&2
  echo "comment-url=" >> "${GITHUB_OUTPUT}"
  exit 0
fi

# Clean up: delete the reaction we just created
gh api \
  --method DELETE \
  "repos/${GITHUB_REPOSITORY}/issues/${GITHUB_PR_NUMBER}/reactions/${reaction_response}" \
  --silent 2>/dev/null || true

# 6. Truncation
review_text=$(cat "${REVIEW_FILE}")
max_chars="${INPUT_MAX_COMMENT_CHARS}"

if [[ "${#review_text}" -gt "${max_chars}" ]]; then
  review_text="${review_text:0:${max_chars}}"
  review_text="${review_text}"$'\n\n---\n'"*Review truncated at ${max_chars} characters.*"
fi

# 7. Write truncated content to temp file
tmp_body=$(mktemp)

# Ensure cleanup on exit
trap 'rm -f "${tmp_body}"' EXIT

printf '%s' "${review_text}" > "${tmp_body}"

# 8. Post comment using --body-file
comment_output=$(gh pr comment "${GITHUB_PR_NUMBER}" \
  --repo "${GITHUB_REPOSITORY}" \
  --body-file "${tmp_body}") || {
  rm -f "${tmp_body}"
  echo "ERROR: Failed to post PR comment." >&2
  exit 1
}

echo "${comment_output}" >&2

# 9. Get comment URL
comment_url=$(gh api \
  "repos/${GITHUB_REPOSITORY}/issues/${GITHUB_PR_NUMBER}/comments" \
  --jq '.[-1].html_url' 2>/dev/null) || comment_url=""

# 10. Set output
echo "comment-url=${comment_url}" >> "${GITHUB_OUTPUT}"
echo "Posted PR comment: ${comment_url}" >&2
