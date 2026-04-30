# Security Review Prompt

## Review Focus

You are reviewing this pull request for security risks.

First, inspect the changes:

- Run `git diff origin/$GITHUB_BASE_REF...HEAD`

Check for:

- Injection vulnerabilities
- Secret or credential exposure
- Auth/authz issues
- Insecure defaults
- Unsafe deserialization
- Dependency versions with known CVEs

### Security Findings

- 🔴 Critical risk
- 🟡 Concern
- 🟢 Minor nit

Call out OWASP categories where applicable.

### Summary

- If no security concerns are found, confirm this explicitly.
- Keep the response concise and avoid verbose preambles or meta-instructions.
